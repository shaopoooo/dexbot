import { ethers } from 'ethers';
import { config } from '../config';
import { buildLogPositionBlock, buildLogSnapshotHeader } from '../utils/formatter';
import { BBResult, RawChainPosition } from '../types';
import { createServiceLogger, positionLogger } from '../utils/logger';
import { rpcRetry, nextProvider } from '../utils/rpcProvider';
import { openTimestampHandler, findMintTimestampMs } from './ChainEventScanner';
import { DiscoveredPosition } from '../utils/stateManager';
import { PositionRecord } from '../types';
import { TOKEN_DECIMALS } from '../utils/tokenInfo';
import path from 'path';
import fs from 'fs-extra';

export type { PositionRecord };

const log = createServiceLogger('PositionScanner');

export class PositionScanner {

    /** In-memory position store */
    private static positions: PositionRecord[] = [];
    private static syncedWallets = new Set<string>();
    /** 已確認關閉（liquidity=0）的 tokenId，持久化後跨重啟跳過掃描 */
    private static closedTokenIds = new Set<string>();
    /** 各 tokenId 的 timestamp 查詢失敗次數；超過上限後停止重試，顯示 N/A */
    private static timestampFailures = new Map<string, number>();

    /**
     * 從 state 恢復已探索的倉位清單，並標記 wallet 已同步（跳過 chain scan）。
     */
    static restoreDiscoveredPositions(
        discovered: DiscoveredPosition[],
        wallets: string[],
        timestamps: Record<string, number>
    ) {
        const activeDiscovered = discovered.filter(d => !this.closedTokenIds.has(d.tokenId));
        const seedPositions: PositionRecord[] = activeDiscovered.map(d => ({
            tokenId: d.tokenId,
            dex: d.dex,
            poolAddress: '',
            feeTier: 0,
            token0Symbol: '',
            token1Symbol: '',
            ownerWallet: d.ownerWallet,
            liquidity: '0',
            tickLower: 0,
            tickUpper: 0,
            minPrice: '0',
            maxPrice: '0',
            currentTick: 0,
            currentPriceStr: '0',
            positionValueUSD: 0,
            unclaimed0: '0',
            unclaimed1: '0',
            unclaimed2: '0',
            unclaimedFeesUSD: 0,
            fees0USD: 0,
            fees1USD: 0,
            fees2USD: 0,
            token2Symbol: '',
            isStaked: false,
            overlapPercent: 0,
            ilUSD: null,
            breakevenDays: 0,
            healthScore: 0,
            regime: '資料累積中',
            lastUpdated: 0,
            openTimestampMs: timestamps[`${d.tokenId}_${d.dex}`],
            volSource: 'pending',
            priceSource: 'pending',
            bbFallback: false,
        }));
        this.positions = seedPositions;
        wallets.forEach(w => this.syncedWallets.add(w));
        log.info(`✅ positions restored from state: ${seedPositions.length} position(s), chain sync skipped`);
    }

    /** 取得目前 discovered positions 快照，供 stateManager 儲存。 */
    static getDiscoveredSnapshot(): DiscoveredPosition[] {
        return this.positions.map(p => ({ tokenId: p.tokenId, dex: p.dex, ownerWallet: p.ownerWallet }));
    }

    /** 取得已關閉 tokenId 清單快照，供 stateManager 持久化。 */
    static getClosedSnapshot(): string[] {
        return [...this.closedTokenIds];
    }

    /** 從 state 恢復已關閉的 tokenId 集合。 */
    static restoreClosedTokenIds(ids: string[]) {
        ids.forEach(id => this.closedTokenIds.add(id));
        if (ids.length > 0) log.info(`💾 closed positions restored: ${ids.join(', ')}`);
    }

    static async syncFromChain(skipTimestampScan = false) {
        if (config.WALLET_ADDRESSES.length === 0) {
            log.info('no wallets configured, skipping chain sync');
            return;
        }

        type Discovery = { tokenId: string; dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'; ownerWallet: string };
        const dexes: ('Uniswap' | 'PancakeSwap' | 'Aerodrome')[] = ['Uniswap', 'PancakeSwap', 'Aerodrome'];
        const discovered: Discovery[] = [];

        for (const walletAddress of config.WALLET_ADDRESSES) {
            const wShort = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
            log.info(`⛓  sync  ${wShort}`);

            for (const dex of dexes) {
                try {
                    const npmAddress = config.NPM_ADDRESSES[dex];
                    if (!npmAddress) continue;

                    const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());
                    const balance = await rpcRetry(
                        () => npmContract.balanceOf(walletAddress),
                        `${dex}.balanceOf`
                    );
                    log.info(`📍 ${dex}  ${balance} NFT(s) found  ${wShort}`);

                    for (let i = 0; i < Number(balance); i++) {
                        const tokenId = await rpcRetry(
                            () => npmContract.tokenOfOwnerByIndex(walletAddress, i),
                            `${dex}.tokenOfOwnerByIndex(${i})`
                        );
                        const tokenIdStr = tokenId.toString();
                        if (this.closedTokenIds.has(tokenIdStr)) {
                            log.info(`  → #${tokenIdStr} (skipped — closed)`);
                            continue;
                        }
                        log.info(`  → #${tokenIdStr}`);
                        discovered.push({ tokenId: tokenIdStr, dex, ownerWallet: walletAddress });
                    }
                } catch (error) {
                    log.error(`NPM.balanceOf failed  ${dex}  ${wShort}: ${error}`);
                }
            }

            this.syncedWallets.add(walletAddress);
        }

        // 補入手動追蹤的 TokenId（鎖倉於 Gauge 等情境）
        const discoveredIds = new Set(discovered.map(d => d.tokenId));
        for (const [tokenId, dex] of Object.entries(config.TRACKED_TOKEN_IDS)) {
            if (discoveredIds.has(tokenId)) continue;
            log.info(`📍 manual  #${tokenId} (${dex})`);
            discovered.push({ tokenId, dex: dex as 'Uniswap' | 'PancakeSwap' | 'Aerodrome', ownerWallet: 'manual' });
        }

        const timestamps: Record<string, number> = {};
        for (const d of discovered) {
            const ts = openTimestampHandler.getCachedTimestamp(`${d.tokenId}_${d.dex}`);
            if (ts !== undefined) timestamps[`${d.tokenId}_${d.dex}`] = ts;
        }
        if (!skipTimestampScan) {
            log.info(`⏭  timestamp lookup deferred to fillMissingTimestamps()`);
        }

        const activeDiscovered = discovered.filter(d => !this.closedTokenIds.has(d.tokenId));
        const seedPositions: PositionRecord[] = activeDiscovered.map(d => ({
            tokenId: d.tokenId,
            dex: d.dex,
            poolAddress: '',
            feeTier: 0,
            token0Symbol: '',
            token1Symbol: '',
            ownerWallet: d.ownerWallet,
            liquidity: '0',
            tickLower: 0,
            tickUpper: 0,
            minPrice: '0',
            maxPrice: '0',
            currentTick: 0,
            currentPriceStr: '0',
            positionValueUSD: 0,
            unclaimed0: '0',
            unclaimed1: '0',
            unclaimed2: '0',
            unclaimedFeesUSD: 0,
            fees0USD: 0,
            fees1USD: 0,
            fees2USD: 0,
            token2Symbol: '',
            isStaked: false,
            overlapPercent: 0,
            ilUSD: null,
            breakevenDays: 0,
            healthScore: 0,
            regime: '資料累積中',
            lastUpdated: 0,
            openTimestampMs: timestamps[`${d.tokenId}_${d.dex}`],
            volSource: 'pending',
            priceSource: 'pending',
            bbFallback: false,
        }));

        this.positions = seedPositions;
        log.info(`✅ chain sync done: ${this.positions.length} position(s) loaded`);
    }

    /** Returns the current in-memory tracked positions. */
    static getTrackedPositions(): PositionRecord[] {
        return this.positions;
    }

    /**
     * Fetch raw NPM chain data for all tracked positions.
     * Handles unsynced wallet detection and returns RawChainPosition[].
     * Called by index.ts; results are passed to PositionAggregator.aggregateAll().
     */
    static async fetchAll(): Promise<RawChainPosition[]> {
        const unsyncedWallets = config.WALLET_ADDRESSES.filter(w => !this.syncedWallets.has(w));
        if (unsyncedWallets.length > 0) {
            log.info(`🔄 ${unsyncedWallets.length} new wallet(s) detected, re-syncing chain`);
            await this.syncFromChain();
        }

        if (this.positions.length === 0) {
            log.info('no tracked positions, skipping fetch');
            return [];
        }

        const rawPositions: RawChainPosition[] = [];
        for (const pos of this.positions) {
            const raw = await this._fetchNpmData(pos.tokenId, pos.dex, pos.ownerWallet, pos.openTimestampMs);
            if (raw) {
                rawPositions.push(raw);
            } else {
                log.warn(`#${pos.tokenId} npm fetch failed, position will keep stale record`);
            }
        }
        return rawPositions;
    }

    /**
     * Update in-memory positions with newly assembled PositionRecords.
     * Positions missing from assembled (failed scan) keep their stale record.
     * Preserves ownerWallet when ownerOf returns a gauge contract.
     */
    static updatePositions(assembled: PositionRecord[]) {
        const assembledMap = new Map(assembled.map(p => [p.tokenId, p]));
        const updated: PositionRecord[] = [];
        for (const prev of this.positions) {
            const fresh = assembledMap.get(prev.tokenId);
            if (!fresh) {
                log.warn(`#${prev.tokenId} not in assembled batch, keeping stale record`);
                updated.push(prev);
                continue;
            }
            if (Number(fresh.liquidity) === 0) {
                this.closedTokenIds.add(prev.tokenId);
                log.info(`#${prev.tokenId} liquidity=0 — marked closed, removed from tracking`);
                continue; // drop from positions, will not be scanned again
            }
            const isKnownWallet = config.WALLET_ADDRESSES.some(
                w => w.toLowerCase() === fresh.ownerWallet.toLowerCase()
            );
            const ownerWallet = isKnownWallet ? fresh.ownerWallet : prev.ownerWallet;
            updated.push({
                ...prev,
                ...fresh,
                ownerWallet,
                openTimestampMs: fresh.openTimestampMs ?? prev.openTimestampMs,
                lastUpdated: Date.now(),
            });
        }
        this.positions = updated;
        log.info(`✅ ${assembled.length} position(s) refreshed`);
    }

    /**
     * Optional: Generate a text report of positions to a log file.
     * Call this at the end of the analysis pipeline.
     */
    static logSnapshots(positions: PositionRecord[], bb?: BBResult | null, kLow?: number, kHigh?: number) {
        if (positions.length === 0) return;
        const outputs = positions.map(pos => buildLogPositionBlock(pos, TOKEN_DECIMALS, bb));

        const header = buildLogSnapshotHeader(bb, kLow, kHigh);
        const logContent = header + '\n\n' + outputs.join('\n\n') + '\n\n';

        const logDir = path.join(__dirname, '../../logs');
        fs.ensureDirSync(logDir);
        fs.appendFileSync(path.join(logDir, 'positions.log'), logContent);
        log.info(`✅ positions.log written  ${positions.length} position(s)`);
    }

    /**
     * Fetch raw NPM data for a single position — ownerOf + positions().
     * Returns null on failure.
     */
    private static async _fetchNpmData(
        tokenId: string,
        dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome',
        ownerWallet: string,
        openTimestampMs?: number,
    ): Promise<RawChainPosition | null> {
        try {
            const npmAddress = config.NPM_ADDRESSES[dex];
            const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());

            const owner = await rpcRetry(() => npmContract.ownerOf(tokenId), `${dex}.ownerOf(${tokenId})`);
            const position = await rpcRetry(() => npmContract.positions(tokenId), `${dex}.positions(${tokenId})`);

            const feeTier = Number(position.fee);
            const oShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
            log.info(`⛓  #${tokenId} ${dex}  owner ${oShort}  fee/tick=${feeTier}  liq=${position.liquidity}`);

            const poolAddress = this.getPoolFromTokens(position.token0, position.token1, feeTier, dex);
            if (!poolAddress) {
                log.warn(`#${tokenId} no pool match  fee/tick=${feeTier}  dex=${dex}`);
                return null;
            }

            // Aerodrome NPM 回傳的是 tickSpacing（非 fee pips），需個別轉換
            let tickSpacing = 60;
            let feeTierForStats = feeTier / 1000000;
            if (feeTier === 100) tickSpacing = 1;
            else if (feeTier === 500) tickSpacing = 10;
            else if (feeTier === 85) tickSpacing = 1;
            else if (dex === 'Aerodrome' && feeTier === 1) {
                tickSpacing = 1;
                feeTierForStats = 0.000085;
            }

            const ownerIsWallet = config.WALLET_ADDRESSES.some(w => w.toLowerCase() === owner.toLowerCase());
            const isStaked = !ownerIsWallet;

            return {
                tokenId,
                dex,
                ownerWallet,
                owner,
                isStaked,
                position,
                poolAddress,
                feeTier,
                feeTierForStats,
                tickSpacing,
                openTimestampMs,
            };
        } catch (error) {
            log.error(`npm fetch failed  #${tokenId} (${dex}): ${error}`);
            return null;
        }
    }

    /**
     * Helper to find a pool address given two tokens and a fee.
     */
    private static getPoolFromTokens(tokenA: string, tokenB: string, fee: number, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'): string | null {
        const map: Record<string, string> = {
            'PancakeSwap_100':  config.POOLS?.PANCAKE_WETH_CBBTC_0_01  || '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
            'PancakeSwap_500':  config.POOLS?.PANCAKE_WETH_CBBTC_0_05  || '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
            'Uniswap_500':      config.POOLS?.UNISWAP_WETH_CBBTC_0_05  || '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
            'Uniswap_3000':     config.POOLS?.UNISWAP_WETH_CBBTC_0_3   || '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
            'Aerodrome_85':     config.POOLS?.AERO_WETH_CBBTC_0_0085   || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5',
            'Aerodrome_1':      config.POOLS?.AERO_WETH_CBBTC_0_0085   || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5',
        };
        return map[`${dex}_${fee}`] || null;
    }

    /**
     * 背景補齊缺少 openTimestampMs 的倉位建倉時間。
     * 失敗超過 TIMESTAMP_MAX_FAILURES 次後標記為 -1（顯示 N/A），停止重試。
     */
    static async fillMissingTimestamps(saveStateCallback?: () => Promise<void>): Promise<void> {
        const missing = this.positions.filter(p => p.openTimestampMs === undefined);
        if (missing.length === 0) return;

        log.info(`⏳ fillMissingTimestamps  ${missing.length} token(s) pending`);

        let filled = 0;
        for (const pos of missing) {
            const key = `${pos.tokenId}_${pos.dex}`;

            // Check cache first (restored from state.json on startup)
            const cached = openTimestampHandler.getCachedTimestamp(key);
            if (cached !== undefined) {
                this.positions = this.positions.map(p =>
                    p.tokenId === pos.tokenId ? { ...p, openTimestampMs: cached } : p
                );
                filled++;
                continue;
            }

            // 超過失敗上限 → 標記為 -1（N/A），不再重試
            const failures = this.timestampFailures.get(key) ?? 0;
            if (failures >= config.TIMESTAMP_MAX_FAILURES) {
                this.positions = this.positions.map(p =>
                    p.tokenId === pos.tokenId ? { ...p, openTimestampMs: -1 } : p
                );
                continue;
            }

            const npmAddress = config.NPM_ADDRESSES[pos.dex];
            if (!npmAddress) continue;

            // Binary search: ~15 RPC calls instead of ~1500 getLogs chunks
            const tsMs = await findMintTimestampMs(pos.tokenId, npmAddress);
            if (tsMs !== null) {
                openTimestampHandler.setCachedTimestamp(key, tsMs);
                this.positions = this.positions.map(p =>
                    p.tokenId === pos.tokenId ? { ...p, openTimestampMs: tsMs } : p
                );
                filled++;
                if (saveStateCallback) {
                    await saveStateCallback().catch(e => log.error(`Timestamp saveState failed: ${e}`));
                }
            } else {
                this.timestampFailures.set(key, failures + 1);
                if (failures + 1 >= config.TIMESTAMP_MAX_FAILURES) {
                    log.warn(`⏳ #${pos.tokenId} timestamp lookup failed ${config.TIMESTAMP_MAX_FAILURES} times — marking N/A`);
                }
            }
        }

        if (filled > 0) log.info(`✅ fillMissingTimestamps  ${filled} timestamp(s) filled`);
    }
}

// Re-export from ChainEventScanner so stateManager keeps a stable import path.
export { getOpenTimestampSnapshot, restoreOpenTimestamps } from './ChainEventScanner';
