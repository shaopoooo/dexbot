import axios from 'axios';
import { nearestUsableTick } from '@uniswap/v3-sdk';
import { bbVolCache, BBVolEntry } from '../utils/cache';
import { createServiceLogger } from '../utils/logger';
import { geckoRequest } from '../utils/rpcProvider';
import { config } from '../config';
import { getTokenPrices } from '../utils/tokenPrices';
import { BBResult } from '../types';
import { appState } from '../utils/AppState';

export type { BBResult };

const log = createServiceLogger('BBEngine');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));



/** Compute annualized vol from a list of prices (closes). */
function calcVol(prices: number[]): number {
  if (prices.length < 2) return 0.5;
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * Math.sqrt(365);
}

/** Fetch 30-day annualized vol.
 *  Order: DEX-specific The Graph subgraph → GeckoTerminal → stale cache → 50% default
 *  Results are cached 2 hours to avoid hitting free-tier rate limits. */
async function fetchDailyVol(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'): Promise<number> {
  const key = poolAddress.toLowerCase();
  const cached = bbVolCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.vol;

  const tag = poolAddress.slice(0, 10);
  const save = (vol: number) => {
    bbVolCache.set(key, { vol, expiresAt: Date.now() + config.BB_VOL_CACHE_TTL_MS });
    log.info(`💾 30D vol  ${tag}  ${(vol * 100).toFixed(1)}%  (${config.BB_VOL_CACHE_TTL_MS / 3600000}h cache)`);
    return vol;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info(`🌐 30D vol  ${tag}  attempt ${attempt}/3`);
      const res = await geckoRequest(() => axios.get(
        `${config.API_URLS.GECKOTERMINAL_OHLCV}/${key}/ohlcv/day?limit=30`,
        { timeout: 8000, headers: { 'User-Agent': 'DexBot/1.0' } }
      ));

      const dailyList: any[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
      if (dailyList.length > 1) {
        // GeckoTerminal 返回格式: [timestamp, open, high, low, close, volume]
        const prices = dailyList.map(c => parseFloat(c[4])).reverse();
        return save(calcVol(prices));
      }
      break; // Valid response but no data, don't retry
    } catch (e: any) {
      const is429 = e.response?.status === 429;
      if (attempt < 3) {
        // 指數退避 + jitter：429 → 15s/30s，其他錯誤 → 5s/10s
        const base = is429 ? 15000 : 5000;
        const backoff = base * attempt + Math.random() * 5000;
        log.warn(`GeckoTerminal ${is429 ? '429' : 'error'}  ${tag}  retry in ${(backoff / 1000).toFixed(1)}s (${attempt}/3)`);
        await delay(backoff);
      } else {
        log.error(`30D vol fetch failed after 3 attempts  ${tag}: ${e.message}`);
      }
    }
  }

  log.warn(`vol fallback ${(config.BB_FALLBACK_VOL * 100).toFixed(0)}%  ${tag}`);
  return config.BB_FALLBACK_VOL;
}

/**
 * In-memory Price Buffer to replace hourly GeckoTerminal calls.
 * Stores the close price for each hour.
 */
class PriceBuffer {
  // poolAddress -> { hourTimestamp: price }
  private buffer: Map<string, Map<number, number>> = new Map();

  // Add the current price for the current hour.
  // Only accepts valid tick-ratio prices (i.e. Math.pow(1.0001, tick)); rejects near-zero or
  // non-finite values that would corrupt SMA/variance calculations.
  public addPrice(poolAddress: string, price: number) {
    if (!Number.isFinite(price) || price <= 0) {
      log.warn(`addPrice: skipping invalid price ${price} for ${poolAddress.slice(0, 10)}`);
      return;
    }
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) {
      this.buffer.set(key, new Map());
    }

    // Get current hour timestamp (floor to nearest hour)
    const currentHour = Math.floor(Date.now() / config.ONE_HOUR_MS) * config.ONE_HOUR_MS;
    const poolBuffer = this.buffer.get(key)!;

    // Always overwrite the current hour with the latest price (acts as the "close" if it's the last update in that hour)
    poolBuffer.set(currentHour, price);

    // Prune old hours (keep only last 24 hours to save memory)
    const cutoff = currentHour - config.ONE_DAY_MS;
    for (const [hourTimestamp] of poolBuffer.entries()) {
      if (hourTimestamp < cutoff) {
        poolBuffer.delete(hourTimestamp);
      }
    }
  }

  // Backfill prices from GeckoTerminal if the buffer is empty
  public backfill(poolAddress: string, ohlcvList: any[][]) {
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) {
      this.buffer.set(key, new Map());
    }
    const poolBuffer = this.buffer.get(key)!;

    // ohlcvList is newest first: [timestamp, open, high, low, close, volume]
    // timestamp is in seconds from GeckoTerminal
    for (const candle of ohlcvList) {
      if (!candle || candle.length < 5) continue;
      const tsMs = candle[0] * 1000; // API returns seconds
      // Floor to hour just to be safe
      const hourTs = Math.floor(tsMs / (1000 * 60 * 60)) * (1000 * 60 * 60);
      const closePrice = parseFloat(candle[4]);

      // Only set if we don't have a newer live price for that hour
      if (!poolBuffer.has(hourTs)) {
        poolBuffer.set(hourTs, closePrice);
      }
    }
  }

  // Get the last 20 hourly closing prices (chronological: oldest to newest)
  public getPrices(poolAddress: string): number[] {
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) return [];

    const poolBuffer = this.buffer.get(key)!;
    // Sort by timestamp
    const sortedHours = Array.from(poolBuffer.entries()).sort((a, b) => a[0] - b[0]);

    const last20 = sortedHours.slice(-config.BB_HOURLY_WINDOW).map(entry => entry[1]);
    return last20;
  }

  /** Serialize to plain object for JSON persistence. */
  public serialize(): Record<string, Record<string, number>> {
    const out: Record<string, Record<string, number>> = {};
    for (const [pool, hours] of this.buffer.entries()) {
      out[pool] = Object.fromEntries(hours.entries());
    }
    return out;
  }

  /** Restore from a plain object snapshot, skipping invalid prices. */
  public restore(data: Record<string, Record<string, number>>) {
    this.buffer.clear();
    for (const [pool, hours] of Object.entries(data)) {
      const m = new Map<number, number>();
      for (const [ts, price] of Object.entries(hours)) {
        if (Number.isFinite(price) && price > 0) {
          m.set(Number(ts), price);
        }
      }
      if (m.size > 0) this.buffer.set(pool, m);
    }
  }
}

const globalPriceBuffer = new PriceBuffer();


export function getPriceBufferSnapshot(): Record<string, Record<string, number>> {
  return globalPriceBuffer.serialize();
}

export function restorePriceBuffer(data: Record<string, Record<string, number>>) {
  globalPriceBuffer.restore(data);
}

/** 在 runPoolScanner 後、runBBEngine 前呼叫，確保 buffer 有最新當前小時 entry。 */
export function refreshPriceBuffer(poolAddress: string, currentTick: number) {
  const price = Math.pow(1.0001, currentTick);
  globalPriceBuffer.addPrice(poolAddress, price);
}

export class BBEngine {
  /**
   * Fetches historical OHLCV data from GeckoTerminal (Free API, requires no key)
   * Base Network ID is 'base'
   */
  static async computeDynamicBB(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome', tickSpacing: number, currentTick: number): Promise<BBResult | null> {
    try {
      const currentPrice = Math.pow(1.0001, currentTick);

      // 1. Update the price buffer with the current live price
      globalPriceBuffer.addPrice(poolAddress, currentPrice);

      // 價格單位說明：priceBuffer 只存 Math.pow(1.0001, tick) 的 tick-ratio 值（例如 WETH/cbBTC ≈ 0.029）。
      // GeckoTerminal hourly backfill 曾被移除，原因是它返回 USD 價格（例如 $70k），
      // 與 tick-ratio 單位完全不同，混用會導致 SMA/方差計算失真。
      const prices1H = globalPriceBuffer.getPrices(poolAddress);

      // 2. 先取得 30D 年化波動率（k 值與 stdDev fallback 都需要）
      const annualizedVol = await fetchDailyVol(poolAddress, dex);
      const k = annualizedVol < config.BB_VOL_THRESHOLD ? appState.bbKLowVol : appState.bbKHighVol;
      const regime = k <= 1.5 ? 'Low Vol (震盪市)' : 'High Vol (趨勢市)';

      // 3. SMA：用現有資料計算，不足時以當前價格替代
      const sma = prices1H.length > 0
        ? prices1H.reduce((sum: number, p: number) => sum + p, 0) / prices1H.length
        : currentPrice;

      // 4. stdDev：資料 >= 5 筆用 EWMA 平滑後計算；不足時從 30D 年化波動率換算 1H stdDev
      //    annualizedVol = hourlyStdDev × √(365 × 24)  →  hourlyStdDev = sma × annualizedVol / √8760
      let stdDev1H: number;
      let isWarmupFallback = false;
      if (prices1H.length >= config.MIN_CANDLES_FOR_EWMA) {
        let smoothedPrices = [...prices1H];
        for (let i = 1; i < smoothedPrices.length; i++) {
          smoothedPrices[i] = config.EWMA_ALPHA * smoothedPrices[i] + config.EWMA_BETA * smoothedPrices[i - 1];
        }
        const variance1H = smoothedPrices.reduce((sum: number, p: number) => sum + Math.pow(p - sma, 2), 0) / smoothedPrices.length;
        stdDev1H = Math.sqrt(variance1H);
      } else {
        // 冷啟動：用 30D vol 換算 1H stdDev；標記 isFallback 讓 UI 顯示「資料累積中」
        stdDev1H = sma * annualizedVol / Math.sqrt(365 * 24); // √(365×24) = √8760 hourly annualization
        isWarmupFallback = true;
        log.info(`📊 vol-derived stdDev  ${poolAddress.slice(0, 10)}  candles=${prices1H.length}/${config.MIN_CANDLES_FOR_EWMA}  stdDev=${stdDev1H.toExponential(3)} (warmup)`);
      }

      const maxOffset = sma * config.BB_MAX_OFFSET_PCT;
      const upperPrice = Math.min(sma + maxOffset, sma + (k * stdDev1H));
      // 不使用絕對最小值（如 0.00000001），避免 tick-ratio 極小的幣對（如 WETH/cbBTC ≈ 2.9e-12）
      // 被 clamp 到遠大於 SMA 的下界，導致 tickOffsetLower 為負、tick 範圍倒置。
      // sma - maxOffset = 0.9 × sma 恆正，無需額外保護。
      const lowerPrice = Math.max(sma - maxOffset, sma - (k * stdDev1H));

      // Convert BB price bounds directly to ticks: tick = log(price) / log(1.0001)
      // This anchors the band to the SMA, not currentTick, so all positions on the
      // same pool always see the same BB regardless of when they are scanned.
      const tickUpperRaw = Math.round(Math.log(upperPrice) / Math.log(1.0001));
      const tickLowerRaw = Math.round(Math.log(lowerPrice) / Math.log(1.0001));

      const tickLower = nearestUsableTick(tickLowerRaw, tickSpacing);
      const tickUpper = nearestUsableTick(tickUpperRaw, tickSpacing);

      // 幣價由獨立的 tokenPrices 模組管理，BBEngine 只讀快取
      const { ethPrice, cbbtcPrice, cakePrice, aeroPrice } = getTokenPrices();

      const minPriceRatio = ethPrice > 0 ? ethPrice / upperPrice : 0;
      const maxPriceRatio = ethPrice > 0 ? ethPrice / lowerPrice : 0;

      return {
        sma,
        upperPrice,
        lowerPrice,
        k,
        volatility30D: annualizedVol,
        tickLower,
        tickUpper,
        ethPrice,
        cbbtcPrice,
        cakePrice,
        aeroPrice,
        minPriceRatio,
        maxPriceRatio,
        isFallback: isWarmupFallback,
        regime: isWarmupFallback ? '資料累積中' : regime,
      };

    } catch (error) {
      log.error(`BB compute failed  ${poolAddress.slice(0, 10)} (${dex}): ${error}`);
      return BBEngine.createFallbackBB(currentTick, tickSpacing);
    }
  }

  /**
   * Generates a safe fallback BB block when external APIs fail.
   * Uses the current tick as the SMA and creates a standard 10% wide band.
   */
  private static createFallbackBB(currentTick: number, tickSpacing: number): BBResult {
    const k = config.BB_FALLBACK_K;
    const volatility30D = config.BB_FALLBACK_VOL;
    const currentPrice = Math.pow(1.0001, currentTick);

    const tickLowerRaw = currentTick - config.BB_FALLBACK_TICK_OFFSET;
    const tickUpperRaw = currentTick + config.BB_FALLBACK_TICK_OFFSET;

    return {
      sma: currentPrice,
      upperPrice: Math.pow(1.0001, tickUpperRaw),
      lowerPrice: Math.pow(1.0001, tickLowerRaw),
      k,
      volatility30D,
      tickLower: nearestUsableTick(tickLowerRaw, tickSpacing),
      tickUpper: nearestUsableTick(tickUpperRaw, tickSpacing),
      ethPrice: 0,
      cbbtcPrice: 0,
      cakePrice: 0,
      aeroPrice: 0,
      minPriceRatio: 0,
      maxPriceRatio: 0,
      isFallback: true,
      regime: '資料累積中'
    };
  }
}
