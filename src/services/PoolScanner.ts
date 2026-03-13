import { ethers } from 'ethers';
import axios from 'axios';
import { poolVolCache } from '../utils/cache';
import { config } from '../config';
import { createServiceLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay, nextProvider, geckoRequest } from '../utils/rpcProvider';
import { PoolStats } from '../types';

export type { PoolStats };

const log = createServiceLogger('PoolScanner');


const VOL_CACHE_TTL_MS = config.POOL_VOL_CACHE_TTL_MS;

interface VolResult { daily: number; avg7d: number; source: string; }

/**
 * Fetch 7-day volume data for a pool.
 * Order: The Graph (DEX-specific) → GeckoTerminal → stale cache → zeros
 */
async function fetchPoolVolume(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'): Promise<VolResult> {
    const key = poolAddress.toLowerCase();
    const cached = poolVolCache.get(key);
    if (cached && Date.now() < cached.expiresAt) return cached;

    const tag = poolAddress.slice(0, 10);
    const save = (daily: number, avg7d: number, src: string) => {
        const entry = { daily, avg7d, source: src, expiresAt: Date.now() + VOL_CACHE_TTL_MS };
        poolVolCache.set(key, entry);
        log.info(`💾 vol  ${tag}  $${daily.toFixed(0)}/24h  [${src}]`);
        return entry;
    };

    // Aerodrome 等無 subgraph 端點的 DEX，直接跳至 GeckoTerminal
    if (!config.SUBGRAPHS[dex]) {
        log.info(`⏭  no subgraph for ${dex}, skip to GeckoTerminal`);
    } else try {
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
            log.warn(`subgraph 0 days for ${tag} (${dex}), falling back to GeckoTerminal`);
        }
    } catch (e: any) {
        log.warn(`subgraph error  ${tag}: ${e.message}`);
    }

    // --- Try 2: GeckoTerminal OHLCV (with 3 retries, exponential backoff) ---
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const geckoRes = await geckoRequest(() => axios.get(
                `${config.API_URLS.GECKOTERMINAL_OHLCV}/${key}/ohlcv/day?limit=7`,
                { timeout: 8000, headers: { 'User-Agent': 'DexBot/1.0' } }
            ));
            const ohlcvList: any[][] = geckoRes.data?.data?.attributes?.ohlcv_list ?? [];
            if (ohlcvList.length > 0) {
                const daily = parseFloat(ohlcvList[0][5]);
                const avg7d = ohlcvList.reduce((s, c) => s + parseFloat(c[5]), 0) / ohlcvList.length;
                return save(daily, avg7d, 'GeckoTerminal');
            }
            break; // Valid response but no data, don't retry
        } catch (e: any) {
            const is429 = e.response?.status === 429;
            const status = e.response?.status ?? 'err';
            if (attempt < 3) {
                const base = is429 ? 15000 : 5000;
                const backoff = base * attempt + Math.random() * 5000;
                log.warn(`GeckoTerminal ${status}  ${tag}  retry in ${(backoff / 1000).toFixed(1)}s (${attempt}/3)`);
                await delay(backoff);
            } else {
                log.error(`GeckoTerminal failed after 3 attempts  ${tag}: ${e.message}`);
            }
        }
    }

    // --- Fallback: stale cache or zeros ---
    const stale = poolVolCache.get(key);
    if (stale) {
        log.warn(`💾 stale vol cache  ${tag}`);
        return stale;
    }

    return { daily: 0, avg7d: 0, source: 'none' };
}


const POOL_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export class PoolScanner {
    /**
     * Fetch 24h stats for a given pool using On-Chain RPC and DexScreener for Volume
     */
    static async fetchPoolStats(
        poolAddress: string,
        dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome',
        feeTierVal: number
    ): Promise<PoolStats | null> {
        if (!POOL_ADDRESS_RE.test(poolAddress)) {
            log.error(`Invalid pool address rejected: ${poolAddress}`);
            return null;
        }
        try {
            // 1. Fetch On-Chain Tick and SqrtPrice
            // Aerodrome Slipstream 的 slot0() 無 feeProtocol 欄位，需使用專屬 ABI
            const poolAbi = dex === 'Aerodrome' ? config.AERO_POOL_ABI : config.POOL_ABI;
            const poolContract = new ethers.Contract(poolAddress, poolAbi, nextProvider());
            const slot0 = await rpcRetry(
                () => poolContract.slot0(),
                `slot0(${poolAddress})`
            );

            const tick = Number(slot0.tick);
            const sqrtPriceX96 = BigInt(slot0.sqrtPriceX96);

            // 2. Fetch Volume and TVL from DexScreener API as a free fallback
            const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/pairs/base/${poolAddress}`, { timeout: 8000 });

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
                log.warn(`DexScreener no pair data  ${poolAddress.slice(0, 10)}`);
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
                log.warn(`TVL=0  ${poolAddress.slice(0, 10)}  APR skipped`);
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
            log.error(`fetchPoolStats failed  ${poolAddress.slice(0, 10)} (${dex}): ${error}`);
            return null;
        }
    }

    /**
     * Scan all core pools and format the output
     */
    static async scanAllCorePools(): Promise<PoolStats[]> {
        // GeckoTerminal 呼叫由 geckoLimiter 限制並發數 ≤ 2；slot0 RPC 與 DexScreener 可安全平行
        const settled = await Promise.allSettled(
            config.POOL_SCAN_LIST.map(p => this.fetchPoolStats(p.address, p.dex, p.fee))
        );

        return settled
            .filter((r): r is PromiseFulfilledResult<PoolStats> => r.status === 'fulfilled' && r.value !== null)
            .map(r => r.value);
    }
}
