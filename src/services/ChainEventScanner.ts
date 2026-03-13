/**
 * ChainEventScanner — 統一鏈上事件掃描器
 *
 * 所有 getLogs 掃描邏輯（分塊、重試、連續失敗中止）集中於此。
 * 新增事件類型只需實作 ScanHandler 介面並呼叫 chainEventScanner.registerHandler()。
 */
import { ethers } from 'ethers';
import { createServiceLogger } from '../utils/logger';
import { rpcRetry, delay, nextProvider } from '../utils/rpcProvider';
import { config } from '../config';

const log = createServiceLogger('ChainEventScanner');

const CHUNK = config.BLOCK_SCAN_CHUNK;
const MAX_CONSECUTIVE_FAILURES = config.COLLECTED_FEES_MAX_FAILURES;
const CHUNK_DELAY_MS = config.COLLECTED_FEES_CHUNK_DELAY_MS;

const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)');
const FROM_ZERO_TOPIC = ethers.zeroPadValue(ethers.ZeroAddress, 32);

// ─── Public Interfaces ───────────────────────────────────────────────────────

export interface ScanRequest {
    tokenId: string;
    npmAddress: string;
    dex: string;
    openTimestampMs?: number;
}

export interface ScanHandler {
    name: string;
    topic0: string;
    /** Which topics[] index holds the tokenId in matching logs */
    tokenIdTopicIndex: 1 | 2 | 3;
    /** Additional topic filters inserted between topic0 and the tokenId OR filter */
    extraTopics?: (string | string[] | null)[];
    stopOnFirstMatch: boolean;
    needsBlockTimestamp: boolean;
    /** Return the fromBlock for this request. Return currentBlock+1 to skip scanning. */
    getFromBlock(req: ScanRequest, currentBlock: number): number;
    processLog(log: ethers.Log, req: ScanRequest, blockTimestamp?: number): Promise<void>;
    /**
     * Called after EACH successful getLogs chunk so handlers can persist
     * incremental scan progress without waiting for the full scan to finish.
     */
    onChunkSuccess?(requests: ScanRequest[], chunkFromBlock: number): void;
    /**
     * Called after the scan loop for each NPM group.
     * @param successfullyScanned tokenIds included in at least one successful getLogs chunk
     * @param lowestScannedBlock  lowest fromBlock of any successful chunk (undefined if all failed)
     */
    onBatchComplete(
        npmAddress: string,
        group: ScanRequest[],
        currentBlock: number,
        successfullyScanned: Set<string>,
        lowestScannedBlock?: number,
    ): void;
}

// ─── ChainEventScanner ──────────────────────────────────────────────────────

export class ChainEventScanner {
    private handlers: ScanHandler[] = [];

    registerHandler(h: ScanHandler): void {
        this.handlers.push(h);
    }

    async scan(requests: ScanRequest[]): Promise<void> {
        if (requests.length === 0) return;

        // Group by npmAddress (case-insensitive)
        const byNpm = new Map<string, ScanRequest[]>();
        for (const r of requests) {
            const key = r.npmAddress.toLowerCase();
            if (!byNpm.has(key)) byNpm.set(key, []);
            byNpm.get(key)!.push(r);
        }

        for (const [npmAddress, group] of byNpm.entries()) {
            let currentBlock: number;
            try {
                currentBlock = await rpcRetry(() => nextProvider().getBlockNumber(), 'getBlockNumber');
            } catch (e: any) {
                log.warn(`getBlockNumber failed: ${e.message}`);
                continue;
            }

            for (const handler of this.handlers) {
                await this.runHandler(handler, npmAddress, group, currentBlock);
            }
        }
    }

    private async runHandler(
        handler: ScanHandler,
        npmAddress: string,
        group: ScanRequest[],
        currentBlock: number,
    ): Promise<void> {
        // Determine which requests need scanning and their fromBlock
        let globalFromBlock = currentBlock + 1;
        const activeRequests: ScanRequest[] = [];

        for (const req of group) {
            const fromBlock = handler.getFromBlock(req, currentBlock);
            if (fromBlock > currentBlock) continue;
            activeRequests.push(req);
            if (fromBlock < globalFromBlock) globalFromBlock = fromBlock;
        }

        if (activeRequests.length === 0) {
            handler.onBatchComplete(npmAddress, group, currentBlock, new Set());
            return;
        }

        // Build tokenId OR filter and lookup map
        const topicToReq = new Map<string, ScanRequest>();
        const allTokenIdTopics: string[] = [];
        for (const req of activeRequests) {
            const topic = ethers.zeroPadValue(ethers.toBeHex(BigInt(req.tokenId)), 32);
            allTokenIdTopics.push(topic);
            topicToReq.set(topic, req);
        }

        // Build getLogs topics filter:
        // [topic0, ...extraTopics, tokenIdORFilter]
        const topicsFilter: (string | string[] | null)[] = [
            handler.topic0,
            ...(handler.extraTopics ?? []),
            allTokenIdTopics,
        ];

        log.info(`⛓  [${handler.name}] scanning ${activeRequests.length} tokenId(s) on NPM ${npmAddress.slice(0, 10)}…`);

        // For stopOnFirstMatch: track which tokenIds are still pending
        const pendingSet: Set<string> | null = handler.stopOnFirstMatch
            ? new Set(activeRequests.map(r => r.tokenId))
            : null;

        // Track which tokenIds had at least one successful getLogs chunk
        const successfullyScanned = new Set<string>();
        // Track lowest fromBlock of any successful chunk (for resume-on-restart)
        let lowestSuccessfulBlock: number | undefined;

        let consecutiveFailures = 0;

        for (let toBlock = currentBlock; toBlock >= globalFromBlock; toBlock -= CHUNK) {
            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                log.warn(`[${handler.name}] scan aborted after ${consecutiveFailures} consecutive RPC failures`);
                break;
            }
            if (pendingSet && pendingSet.size === 0) break;

            const chunkFrom = Math.max(globalFromBlock, toBlock - CHUNK + 1);

            try {
                const logs = await rpcRetry(
                    () => nextProvider().getLogs({
                        address: npmAddress,
                        topics: topicsFilter,
                        fromBlock: chunkFrom,
                        toBlock,
                    }),
                    `getLogs(${chunkFrom}-${toBlock})`,
                );

                consecutiveFailures = 0;

                // Mark active tokenIds as successfully scanned
                for (const req of activeRequests) {
                    if (!pendingSet || pendingSet.has(req.tokenId)) {
                        successfullyScanned.add(req.tokenId);
                    }
                }
                // Track lowest successfully fetched block for resume-on-restart
                if (lowestSuccessfulBlock === undefined || chunkFrom < lowestSuccessfulBlock) {
                    lowestSuccessfulBlock = chunkFrom;
                }
                // Incremental progress: update immediately after each chunk so
                // saveState() captures real progress even if the full scan hasn't finished.
                handler.onChunkSuccess?.(activeRequests, chunkFrom);

                for (const l of logs) {
                    const tokenIdTopic = l.topics[handler.tokenIdTopicIndex];
                    if (!tokenIdTopic) continue;

                    const req = topicToReq.get(tokenIdTopic);
                    if (!req) continue;

                    // For incremental handlers, skip logs from already-covered blocks
                    const reqFrom = handler.getFromBlock(req, currentBlock);
                    if (l.blockNumber < reqFrom) continue;

                    let blockTimestamp: number | undefined;
                    if (handler.needsBlockTimestamp) {
                        const block = await rpcRetry(
                            () => nextProvider().getBlock(l.blockNumber),
                            `getBlock(${l.blockNumber})`,
                        );
                        blockTimestamp = block?.timestamp;
                    }

                    await handler.processLog(l, req, blockTimestamp);

                    if (pendingSet) {
                        pendingSet.delete(req.tokenId);
                        if (pendingSet.size === 0) break;
                    }
                }
            } catch (e: any) {
                consecutiveFailures++;
                log.warn(`[${handler.name}] getLogs chunk ${chunkFrom}–${toBlock} failed (${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES}): ${e.message.slice(0, 80)}`);
            }

            await delay(CHUNK_DELAY_MS);
        }

        // Warn about tokenIds not found for stopOnFirstMatch handlers
        if (pendingSet && pendingSet.size > 0) {
            const missing = Array.from(pendingSet).map(id => `#${id}`).join(', ');
            log.warn(`[${handler.name}] ${pendingSet.size} tokenId(s) not found: ${missing}`);
        }

        handler.onBatchComplete(npmAddress, group, currentBlock, successfullyScanned, lowestSuccessfulBlock);
    }
}

// ─── Binary-search mint timestamp ────────────────────────────────────────────

const OWNER_OF_ABI = ['function ownerOf(uint256) view returns (address)'];

/**
 * Returns true if the NPM tokenId exists at the given historical block.
 * Uses direct eth_call (no rpcRetry) so CALL_EXCEPTION from "nonexistent token"
 * is treated as false without noisy error logging or unnecessary retries.
 */
async function tokenExistsAtBlock(
    npmAddress: string,
    tokenIdBigInt: bigint,
    blockTag: number,
): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const contract = new ethers.Contract(npmAddress, OWNER_OF_ABI, nextProvider());
            await contract.ownerOf(tokenIdBigInt, { blockTag });
            return true;
        } catch (e: any) {
            if (e.code === 'CALL_EXCEPTION') return false; // token not yet minted
            if (attempt < 2) { await delay(2000 * (attempt + 1)); continue; }
            throw e;
        }
    }
    return false;
}

/**
 * Locates the mint block for an LP NFT using binary search on ownerOf() at
 * historical blocks, then fetches the exact timestamp via getLogs on the
 * narrow ~CHUNK-block window.
 *
 * Complexity: O(log(currentBlock)) ≈ 15 RPC calls vs O(LOOKBACK/CHUNK) ≈ 1500
 * for the old linear scan.
 */
export async function findMintTimestampMs(
    tokenId: string,
    npmAddress: string,
): Promise<number | null> {
    log.info(`🔍 [MintSearch] #${tokenId} binary search on ${npmAddress.slice(0, 10)}…`);

    let currentBlock: number;
    try {
        currentBlock = await rpcRetry(() => nextProvider().getBlockNumber(), 'getBlockNumber');
    } catch (e: any) {
        log.warn(`[MintSearch] getBlockNumber failed: ${e.message}`);
        return null;
    }

    const tokenIdBigInt = BigInt(tokenId);
    let lo = 1;
    let hi = currentBlock;

    // Binary search: narrow down to the exact block (hi - lo === 0)
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const exists = await tokenExistsAtBlock(npmAddress, tokenIdBigInt, mid);
        if (exists) {
            hi = mid - 1; // mint could be at mid or before
        } else {
            lo = mid + 1; // mint is definitely after mid
        }
    }

    // Now lo is exactly the block where the token first exists
    const mintBlock = lo;
    if (mintBlock > currentBlock) {
        log.warn(`[MintSearch] #${tokenId} token exists binary search failed (lo > currentBlock)`);
        return null;
    }

    let block: ethers.Block | null;
    try {
        block = await rpcRetry(
            () => nextProvider().getBlock(mintBlock),
            `getBlock(${mintBlock})`,
        );
    } catch (e: any) {
        log.warn(`[MintSearch] getBlock(${mintBlock}) failed: ${e.message?.slice(0, 60)}`);
        return null;
    }

    if (!block) return null;
    const tsMs = block.timestamp * 1000;
    log.info(`💾 [MintSearch] #${tokenId} minted at block ${mintBlock} (${new Date(tsMs).toISOString().slice(0, 10)})`);
    return tsMs;
}

// ─── OpenTimestampHandler ────────────────────────────────────────────────────
// Acts only as an in-memory cache; timestamp discovery is now done via
// findMintTimestampMs() binary search (not getLogs linear scan).

class OpenTimestampHandler {
    private readonly cache = new Map<string, number>(); // `${tokenId}_${dex}` → tsMs

    getCachedTimestamp(key: string): number | undefined {
        return this.cache.get(key);
    }

    setCachedTimestamp(key: string, tsMs: number): void {
        this.cache.set(key, tsMs);
    }

    snapshot(): Record<string, number> {
        return Object.fromEntries(this.cache.entries());
    }

    restore(data: Record<string, number>): void {
        for (const [k, v] of Object.entries(data)) this.cache.set(k, v);
    }
}

// ─── Singletons ──────────────────────────────────────────────────────────────

export const openTimestampHandler = new OpenTimestampHandler();

/** chainEventScanner is kept for future handlers (e.g. Collect event tracking). */
export const chainEventScanner = new ChainEventScanner();

// ─── Module-level exports ─────────────────────────────────────────────────────

export function getOpenTimestampSnapshot(): Record<string, number> {
    return openTimestampHandler.snapshot();
}

export function restoreOpenTimestamps(data: Record<string, number>): void {
    openTimestampHandler.restore(data);
}
