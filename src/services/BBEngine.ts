import axios from 'axios';
import { nearestUsableTick } from '@uniswap/v3-sdk';
import { createServiceLogger } from '../utils/logger';
import { config } from '../config';

const log = createServiceLogger('BBEngine');

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface BBResult {
  sma: number;
  upperPrice: number;
  lowerPrice: number;
  k: number;
  volatility30D: number;
  tickLower: number;
  tickUpper: number;
  ethPrice: number;
  minPriceRatio: number;
  maxPriceRatio: number;
  isFallback?: boolean;
  regime: string;
}

const VOL_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

interface CacheEntry {
  vol: number;
  expiresAt: number;
}
// In-memory cache: poolAddress -> annualized volatility
const volCache = new Map<string, CacheEntry>();

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
async function fetchDailyVol(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap'): Promise<number> {
  const key = poolAddress.toLowerCase();
  const cached = volCache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.vol;

  const tag = poolAddress.slice(0, 10);
  const save = (vol: number) => {
    volCache.set(key, { vol, expiresAt: Date.now() + VOL_CACHE_TTL_MS });
    log.info(`[BBEngine] vol(${tag}) from GeckoTerminal: ${(vol * 100).toFixed(1)}% — cached 12h`);
    return vol;
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      log.info(`[BBEngine] Fetching 30D Volatility for ${tag} (Attempt ${attempt}/3)...`);
      const res = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/base/pools/${key}/ohlcv/day?limit=30`,
        { timeout: 8000 }
      );

      const dailyList: any[][] = res.data?.data?.attributes?.ohlcv_list ?? [];
      if (dailyList.length > 1) {
        // GeckoTerminal 返回格式: [timestamp, open, high, low, close, volume]
        const prices = dailyList.map(c => parseFloat(c[4])).reverse();
        return save(calcVol(prices));
      }
      break; // Valid response but no data, don't retry
    } catch (e: any) {
      if (attempt < 3) {
        const is429 = e.response?.status === 429;
        log.warn(`[BBEngine] GeckoTerminal ${is429 ? '429' : 'err'} for ${tag}. Retrying in 10s (attempt ${attempt}/3)...`);
        await delay(10000); // Wait 10s before next attempt
      } else {
        log.error(`[BBEngine] Volatility fetch error for ${tag} after 3 attempts: ${e.message}`);
      }
    }
  }

  // 如果失敗，使用預設值，但不要快取，讓它下次有機會重試
  log.warn(`[BBEngine] Using default annualizedVol=50% for ${tag}`);
  return 0.5;
}

/**
 * In-memory Price Buffer to replace hourly GeckoTerminal calls.
 * Stores the close price for each hour.
 */
class PriceBuffer {
  // poolAddress -> { hourTimestamp: price }
  private buffer: Map<string, Map<number, number>> = new Map();

  // Add the current price for the current hour
  public addPrice(poolAddress: string, price: number) {
    const key = poolAddress.toLowerCase();
    if (!this.buffer.has(key)) {
      this.buffer.set(key, new Map());
    }

    // Get current hour timestamp (floor to nearest hour)
    const currentHour = Math.floor(Date.now() / (1000 * 60 * 60)) * (1000 * 60 * 60);
    const poolBuffer = this.buffer.get(key)!;

    // Always overwrite the current hour with the latest price (acts as the "close" if it's the last update in that hour)
    poolBuffer.set(currentHour, price);

    // Prune old hours (keep only last 24 hours to save memory)
    const cutoff = currentHour - (24 * 60 * 60 * 1000);
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

    // Take the last 20
    const last20 = sortedHours.slice(-20).map(entry => entry[1]);
    return last20;
  }
}

const globalPriceBuffer = new PriceBuffer();


export class BBEngine {
  /**
   * Fetches historical OHLCV data from GeckoTerminal (Free API, requires no key)
   * Base Network ID is 'base'
   */
  static async computeDynamicBB(poolAddress: string, dex: 'Uniswap' | 'PancakeSwap', tickSpacing: number, currentTick: number): Promise<BBResult | null> {
    try {
      const currentPrice = Math.pow(1.0001, currentTick);

      // 1. Update the price buffer with the current live price
      globalPriceBuffer.addPrice(poolAddress, currentPrice);

      let prices1H = globalPriceBuffer.getPrices(poolAddress);

      // 2. If we don't have enough data (< 20 hours), fetch from GeckoTerminal to backfill
      if (prices1H.length < 20) {
        log.info(`[BBEngine] Price buffer for ${poolAddress} has only ${prices1H.length}/20 hours. Backfilling from GeckoTerminal...`);
        let res: any = null;
        let hourlyRetries = 3;
        while (hourlyRetries > 0) {
          try {
            res = await axios.get(`https://api.geckoterminal.com/api/v2/networks/base/pools/${poolAddress}/ohlcv/hour?limit=30`);
            break;
          } catch (e: any) {
            if (e.response && e.response.status === 429) {
              const attempt = 4 - hourlyRetries; // 1, 2, 3
              // Exponential backoff + jitter: (2^attempt)s + random(0-1)s
              const backoffMs = 10000 + Math.pow(2, attempt) * 1000 + Math.random() * 1000;
              hourlyRetries--;
              log.warn(`GeckoTerminal 429 rate-limited (hourly OHLCV) for pool=${poolAddress}. Backing off ${(backoffMs / 1000).toFixed(1)}s... (${hourlyRetries} retries remaining)`);
              await delay(backoffMs);
            } else {
              log.warn(`Failed to fetch hourly OHLCV for pool=${poolAddress}: ${e.message}`);
              break;
            }
          }
        }

        if (res && res.data && res.data.data && res.data.data.attributes && res.data.data.attributes.ohlcv_list) {
          const ohlcvList = res.data.data.attributes.ohlcv_list;
          globalPriceBuffer.backfill(poolAddress, ohlcvList);
          prices1H = globalPriceBuffer.getPrices(poolAddress);
          log.info(`[BBEngine] Backfill complete. Buffer now has ${prices1H.length} hours of data.`);
        } else {
          log.warn(`[BBEngine] Failed to backfill OHLCV data from GeckoTerminal for ${poolAddress}. Proceeding with ${prices1H.length} hours.`);
        }
      }

      // 3. Fallback if still no data
      if (prices1H.length < 2) {
        log.warn(`[BBEngine] Insufficient data for SMA (${prices1H.length} hours). Using fallback BB.`);
        return BBEngine.createFallbackBB(currentTick, tickSpacing);
      }

      // Compute 20 SMA / 1H
      const sma = prices1H.reduce((sum: number, p: number) => sum + p, 0) / (prices1H.length || 1);

      // Use fetchDailyVol: tries The Graph (DEX-specific) → GeckoTerminal → stale cache → 50% default
      const annualizedVol = await fetchDailyVol(poolAddress, dex);

      // Determine K
      const k = annualizedVol < 0.50 ? 1.2 : 1.8; // 提高閾值，讓窄 k 更容易觸發
      const regime = k <= 1.5 ? 'Low Vol (震盪市)' : 'High Vol (趨勢市)';

      // 平滑 prices1H (alpha=0.3，最近權重高)
      let smoothedPrices = [...prices1H];
      for (let i = 1; i < smoothedPrices.length; i++) {
        smoothedPrices[i] = 0.3 * smoothedPrices[i] + 0.7 * smoothedPrices[i - 1]; // EWMA
      }

      // 然後用 smoothedPrices 算 variance
      const variance1H = smoothedPrices.reduce((sum: number, p: number) => sum + Math.pow(p - sma, 2), 0) / (smoothedPrices.length || 1);
      const stdDev1H = Math.sqrt(variance1H);

      const maxOffset = sma * 0.10; // ±10% cap
      const upperPrice = Math.min(sma + maxOffset, sma + (k * stdDev1H));
      const lowerPrice = Math.max(0.00000001, Math.max(sma - maxOffset, sma - (k * stdDev1H)));

      // Calculate the percentage offset of the bounds from the current price/SMA
      // Since price = 1.0001^tick, a % change in price corresponds to a constant tick offset
      // Delta Tick = log(Price2/Price1) / log(1.0001)
      const tickOffsetUpper = Math.round(Math.log(upperPrice / sma) / Math.log(1.0001));
      const tickOffsetLower = Math.round(Math.log(sma / lowerPrice) / Math.log(1.0001));

      // If price of Token0 is rising relative to Token1, tick usually increases.
      // E.g cbBTC vs WETH (Token0 is usually cbBTC).
      const tickUpperRaw = currentTick + tickOffsetUpper;
      const tickLowerRaw = currentTick - tickOffsetLower;

      const tickLower = nearestUsableTick(tickLowerRaw, tickSpacing);
      const tickUpper = nearestUsableTick(tickUpperRaw, tickSpacing);

      // Fetch current ETH price for ratio calculation
      let ethPrice = 0;
      try {
        const wethRes = await axios.get('https://api.dexscreener.com/latest/dex/tokens/0x4200000000000000000000000000000000000006');
        if (wethRes.data && wethRes.data.pairs && wethRes.data.pairs.length > 0) {
          ethPrice = parseFloat(wethRes.data.pairs[0].priceUsd);
        }
      } catch (e: any) {
        log.warn(`Failed to fetch ETH price from DexScreener (used for ratio calc): ${e.message}`);
      }

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
        minPriceRatio,
        maxPriceRatio,
        regime
      };

    } catch (error) {
      log.error(`Failed to compute Bollinger Bands for pool=${poolAddress} dex=${dex}: ${error}`);
      return BBEngine.createFallbackBB(currentTick, tickSpacing);
    }
  }

  /**
   * Generates a safe fallback BB block when external APIs fail.
   * Uses the current tick as the SMA and creates a standard 10% wide band.
   */
  private static createFallbackBB(currentTick: number, tickSpacing: number): BBResult {
    const k = 2.0;
    const volatility30D = 0.5;
    const currentPrice = Math.pow(1.0001, currentTick);

    // Arbitrary +/- 1000 ticks (~10%) for the fallback band
    const tickLowerRaw = currentTick - 1000;
    const tickUpperRaw = currentTick + 1000;

    return {
      sma: currentPrice,
      upperPrice: Math.pow(1.0001, tickUpperRaw),
      lowerPrice: Math.pow(1.0001, tickLowerRaw),
      k,
      volatility30D,
      tickLower: nearestUsableTick(tickLowerRaw, tickSpacing),
      tickUpper: nearestUsableTick(tickUpperRaw, tickSpacing),
      ethPrice: 0,
      minPriceRatio: 0,
      maxPriceRatio: 0,
      isFallback: true,
      regime: 'Unknown'
    };
  }
}
