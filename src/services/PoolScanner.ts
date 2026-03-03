import { ethers } from 'ethers';
import axios from 'axios';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay } from '../utils/rpcProvider';

const log = createServiceLogger('PoolScanner');

export interface PoolStats {
    id: string;
    dex: 'Uniswap' | 'PancakeSwap';
    feeTier: number;
    apr: number;
    tvlUSD: number;
    dailyFeesUSD: number;
    tick: number;
    sqrtPriceX96: bigint;
    volSource: string; // data lineage: e.g. 'The Graph (PancakeSwap)', 'GeckoTerminal'
}


const VOL_CACHE_TTL_MS = config.POOL_VOL_CACHE_TTL_MS;

interface VolResult { daily: number; avg7d: number; source: string; }
interface VolCacheEntry extends VolResult { expiresAt: number; }
const volCache = new Map<string, VolCacheEntry>();

/**
 * Fetch 7-day volume data for a pool.
 * Order: The Graph (DEX-specific) → GeckoTerminal → stale cache → zeros
 */
async function fetchPoolVolume(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap'): Promise<VolResult> {
    const key = poolAddress.toLowerCase();
    const cached = volCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached;

    const tag = poolAddress.slice(0, 10);
    const save = (daily: number, avg7d: number, src: string) => {
        const entry: VolCacheEntry = { daily, avg7d, source: src, expiresAt: Date.now() + VOL_CACHE_TTL_MS };
        volCache.set(key, entry);
        log.info(`[PoolScanner] volume(${tag}) from ${src}: 24h=$${daily.toFixed(0)} (cached 30m)`);
        return entry;
    };

    try {
        // 🔥 終極大招：同時查詢 Uniswap 舊格式與 Messari 新格式
        const query = `{
            uniswapFormat: poolDayDatas(first: 7, orderBy: date, orderDirection: desc, where: { pool: "${key}" }) {
                volumeUSD
            }
            messariFormat: liquidityPoolDailySnapshots(first: 7, orderBy: timestamp, orderDirection: desc, where: { pool: "${key}" }) {
                dailyVolumeUSD
            }
        }`;

        const res = await axios.post(config.SUBGRAPHS[dex], { query }, { timeout: 8000 });
        const data = res.data?.data || {};

        // 紀錄回傳內容方便 debug (移除 slice)
        // log.dev(`[PoolScanner] Subgraph Response for ${tag}: ${JSON.stringify(data, null, 2)}`);

        let vols: number[] = [];
        let sourceUsed = '';

        // 判斷哪個格式有回傳資料
        if (data.messariFormat && data.messariFormat.length > 0) {
            vols = data.messariFormat.map((d: any) => parseFloat(d.dailyVolumeUSD));
            sourceUsed = `The Graph (Messari Schema - ${dex})`;
        } else if (data.uniswapFormat && data.uniswapFormat.length > 0) {
            vols = data.uniswapFormat.map((d: any) => parseFloat(d.volumeUSD));
            sourceUsed = `The Graph (Native Schema - ${dex})`;
        }

        if (vols.length > 0) {
            const daily = vols[0];
            const avg7d = vols.reduce((s, v) => s + v, 0) / vols.length;
            return save(daily, avg7d, sourceUsed);
        } else {
            log.info(`[PoolScanner] The Graph (${dex}) returned 0 days for ${tag}. Falling back to DexScreener 24h volume.`);
        }
    } catch (e: any) {
        log.warn(`[PoolScanner] Subgraph error for ${tag}: ${e.message}`);
    }

    // --- Try 2: GeckoTerminal OHLCV (with 3 retries, 10s delay) ---
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const geckoRes = await axios.get(
                `https://api.geckoterminal.com/api/v2/networks/base/pools/${key}/ohlcv/day?limit=7`,
                { timeout: 8000 }
            );
            const ohlcvList: any[][] = geckoRes.data?.data?.attributes?.ohlcv_list ?? [];
            if (ohlcvList.length > 0) {
                const daily = parseFloat(ohlcvList[0][5]);
                const avg7d = ohlcvList.reduce((s, c) => s + parseFloat(c[5]), 0) / ohlcvList.length;
                return save(daily, avg7d, 'GeckoTerminal');
            }
            break; // Valid response but no data, don't retry
        } catch (e: any) {
            const status = e.response?.status ?? 'err';
            if (attempt < 3) {
                log.warn(`[PoolScanner] GeckoTerminal ${status} for ${tag} (Attempt ${attempt}/3). Retrying in 10s...`);
                await delay(10000);
            } else {
                log.error(`[PoolScanner] GeckoTerminal ${status} for ${tag} failed after 3 attempts: ${e.message}`);
            }
        }
    }

    // --- Fallback: stale cache or zeros ---
    const stale = volCache.get(key);
    if (stale) {
        log.warn(`[PoolScanner] Using stale cached volume for ${tag}`);
        return stale;
    }

    return { daily: 0, avg7d: 0, source: 'none' };
}


export class PoolScanner {
    /**
     * Fetch 24h stats for a given pool using On-Chain RPC and DexScreener for Volume
     */
    static async fetchPoolStats(
        poolAddress: string,
        dex: 'Uniswap' | 'PancakeSwap',
        feeTierVal: number
    ): Promise<PoolStats | null> {
        try {
            // 1. Fetch On-Chain Tick and SqrtPrice
            const poolContract = new ethers.Contract(poolAddress, config.POOL_ABI, rpcProvider);
            const slot0 = await rpcRetry(
                () => poolContract.slot0(),
                `slot0(${poolAddress})`
            );

            const tick = Number(slot0.tick);
            const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);

            // 2. Fetch Volume and TVL from DexScreener API as a free fallback
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/base/${poolAddress}`);

            let tvlUSD = 0;
            let dailyVolumeUSD = 0;
            let apr = 0;
            let dailyFeesUSD = 0;

            if (dexRes.data && dexRes.data.pairs && dexRes.data.pairs.length > 0) {
                const pairData = dexRes.data.pairs[0];
                // log.dev(`[PoolScanner] DexScreener Response for ${poolAddress}: ${JSON.stringify(pairData, null, 2)}`);
                tvlUSD = parseFloat(pairData.liquidity?.usd || '0');
                dailyVolumeUSD = parseFloat(pairData.volume?.h24 || '0');
            } else {
                log.warn(`No DexScreener pair data found for pool=${poolAddress}. Setting volume/TVL to 0.`);
            }

            // 3. Fetch Volume from The Graph / GeckoTerminal with fallback and caching
            const volData = await fetchPoolVolume(poolAddress, dex);
            const geckoDailyVol = volData.daily;
            const gecko7DVol = volData.avg7d;
            const volSource = volData.source;
            // log.dev(`[PoolScanner] TheGraph/Gecko fallback Vol Data for ${poolAddress}: ${JSON.stringify(volData)}`);

            // 4. Multi-Source Volume Verification
            // If one source is wildly off (e.g. > 2x difference), take the conservative (lower) average, else average them.
            let verified24hVol = dailyVolumeUSD;
            if (geckoDailyVol > 0 && dailyVolumeUSD > 0) {
                const ratio = Math.max(geckoDailyVol, dailyVolumeUSD) / Math.min(geckoDailyVol, dailyVolumeUSD);
                if (ratio > 2) {
                    verified24hVol = Math.min(geckoDailyVol, dailyVolumeUSD); // Conservative approach
                } else {
                    verified24hVol = (geckoDailyVol + dailyVolumeUSD) / 2;
                }
            } else if (geckoDailyVol > 0) {
                verified24hVol = geckoDailyVol;
            }

            // 5. Compute APR using 7-day weighted or average volume
            const avgDailyVolume = gecko7DVol > 0 ? (verified24hVol + gecko7DVol) / 2 : verified24hVol;
            dailyFeesUSD = avgDailyVolume * feeTierVal;

            if (tvlUSD > 0) {
                apr = (dailyFeesUSD / tvlUSD) * 365;
            } else {
                log.warn(`TVL=0 from DexScreener for pool=${poolAddress}, APR cannot be calculated.`);
            }

            // log.dev(`[PoolScanner] Final Computed Stats for ${poolAddress}: avgDailyVolume=${avgDailyVolume}, dailyFeesUSD=${dailyFeesUSD}, apr=${apr}`);

            return {
                id: poolAddress.toLowerCase(),
                dex,
                feeTier: feeTierVal,
                apr,
                tvlUSD,
                dailyFeesUSD,
                tick,
                sqrtPriceX96,
                volSource,
            };
        } catch (error) {
            log.error(`Fatal error fetching pool=${poolAddress} dex=${dex}: ${error}`);
            return null;
        }
    }

    /**
     * Scan all core pools and format the output
     */
    static async scanAllCorePools(): Promise<PoolStats[]> {
        const poolTasks = [
            { pool: config.POOLS.PANCAKE_0_01, dex: 'PancakeSwap' as const, fee: 0.0001 },
            { pool: config.POOLS.PANCAKE_0_05, dex: 'PancakeSwap' as const, fee: 0.0005 },
            { pool: config.POOLS.UNISWAP_0_05, dex: 'Uniswap' as const, fee: 0.0005 },
            { pool: config.POOLS.UNISWAP_0_3, dex: 'Uniswap' as const, fee: 0.003 }
        ];

        const results: (PoolStats | null)[] = [];

        // Execute sequentially with a random delay to respect standard public API rate limits
        for (const task of poolTasks) {
            results.push(await this.fetchPoolStats(task.pool, task.dex, task.fee));
            const jitterMs = 1500 + Math.random() * 1000;
            await delay(jitterMs); // 1.5s - 2.5s jitter delay between consecutive pool scans
        }

        return results.filter((r) => r !== null) as PoolStats[];
    }
}
