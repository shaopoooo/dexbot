/**
 * stateManager.ts — 跨重啟狀態持久化
 * 將各模組的 in-memory 快取序列化至 data/state.json，
 * 下次啟動時自動從檔案恢復，避免 cold-start 重新爬蟲。
 */
import * as fs from 'fs-extra';
import { rename } from 'fs/promises';
import * as path from 'path';
import { createServiceLogger } from './logger';
import { bbVolCache, poolVolCache, snapshotCache, restoreCache, BBVolEntry, PoolVolEntry } from './cache';

const log = createServiceLogger('State');
const STATE_FILE = path.join(process.cwd(), 'data', 'state.json');
const TMP_FILE   = STATE_FILE + '.tmp';

export interface DiscoveredPosition {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    ownerWallet: string;
}

export interface PersistedState {
    volCacheBB:   Record<string, BBVolEntry>;
    volCachePool: Record<string, PoolVolEntry>;
    priceBuffer:  Record<string, Record<string, number>>;  // poolAddr → hourTs → price
    openTimestamps: Record<string, number>;                 // `${tokenId}_${dex}` → ms
    intervalMinutes?: number;                               // cron 排程間隔（分鐘）
    sortBy: string;
    bandwidthWindows?: Record<string, number[]>;            // poolAddr → rolling 30D bandwidth window
    bbKLowVol?: number;                                     // runtime BB k (low vol)
    bbKHighVol?: number;                                    // runtime BB k (high vol)
    closedTokenIds?: string[];                              // liquidity=0 confirmed, skip forever
    // 已探索的倉位清單（跳過 syncFromChain）
    discoveredPositions?: DiscoveredPosition[];
    syncedWallets?: string[];   // 當時掃描的 wallet 列表，用於判斷配置是否變更
}

export async function loadState(): Promise<PersistedState | null> {
    try {
        if (!(await fs.pathExists(STATE_FILE))) return null;
        const raw = await fs.readJson(STATE_FILE) as PersistedState;
        const bbKeys   = Object.keys(raw.volCacheBB   ?? {}).length;
        const poolKeys = Object.keys(raw.volCachePool ?? {}).length;
        const tsKeys   = Object.keys(raw.openTimestamps ?? {}).length;
        log.info(`💾 state loaded — BB vols: ${bbKeys}, pool vols: ${poolKeys}, timestamps: ${tsKeys}`);
        return raw;
    } catch (e: any) {
        log.warn(`state load failed: ${e.message}`);
        return null;
    }
}

export async function saveState(
    priceBuffer: Record<string, Record<string, number>>,
    openTimestamps: Record<string, number>,
    sortBy: string,
    discoveredPositions?: DiscoveredPosition[],
    syncedWallets?: string[],
    bandwidthWindows?: Record<string, number[]>,
    intervalMinutes?: number,
    bbKLowVol?: number,
    bbKHighVol?: number,
    closedTokenIds?: string[],
): Promise<void> {
    try {
        await fs.ensureDir(path.dirname(STATE_FILE));
        const state: PersistedState = {
            volCacheBB:   snapshotCache(bbVolCache),
            volCachePool: snapshotCache(poolVolCache),
            priceBuffer,
            openTimestamps,
            intervalMinutes,
            sortBy,
            bandwidthWindows,
            bbKLowVol,
            bbKHighVol,
            closedTokenIds,
            discoveredPositions,
            syncedWallets,
        };
        // 原子寫入：先寫暫存檔，成功後 rename，避免 SIGINT 截斷導致 JSON 損毀
        await fs.writeJson(TMP_FILE, state, { spaces: 2 });
        await rename(TMP_FILE, STATE_FILE);
    } catch (e: any) {
        log.warn(`state save failed: ${e.message}`);
    }
}

export function restoreState(state: PersistedState) {
    restoreCache(bbVolCache,   state.volCacheBB   ?? {});
    restoreCache(poolVolCache, state.volCachePool ?? {});
}
