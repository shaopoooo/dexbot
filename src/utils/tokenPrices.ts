/**
 * tokenPrices.ts — 獨立幣價快取
 *
 * 與 BBEngine 解耦，讓代幣價格可在 cron 任意位置刷新，
 * 不受 BBEngine 是否成功執行影響。
 */
import axios from 'axios';
import { config } from '../config';
import { createServiceLogger } from './logger';

const log = createServiceLogger('TokenPrices');

export interface TokenPrices {
    ethPrice: number;
    cbbtcPrice: number;
    cakePrice: number;
    aeroPrice: number;
    fetchedAt: number;
}

let cache: TokenPrices | null = null;

export async function fetchTokenPrices(): Promise<TokenPrices> {
    if (cache && Date.now() < cache.fetchedAt + config.TOKEN_PRICE_CACHE_TTL_MS) {
        return cache;
    }

    const bestPrice = (pairs: any[]): number =>
        parseFloat(
            (pairs?.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0])?.priceUsd || '0'
        );

    try {
        const [wethRes, cbbtcRes, cakeRes, aeroRes] = await Promise.all([
            axios.get(`${config.API_URLS.DEXSCREENER_TOKENS}/${config.TOKEN_ADDRESSES.WETH}`,  { timeout: 5000, headers: { 'User-Agent': 'DexBot/1.0' } }),
            axios.get(`${config.API_URLS.DEXSCREENER_TOKENS}/${config.TOKEN_ADDRESSES.CBBTC}`, { timeout: 5000, headers: { 'User-Agent': 'DexBot/1.0' } }),
            axios.get(`${config.API_URLS.DEXSCREENER_TOKENS}/${config.TOKEN_ADDRESSES.CAKE}`,  { timeout: 5000, headers: { 'User-Agent': 'DexBot/1.0' } }),
            axios.get(`${config.API_URLS.DEXSCREENER_TOKENS}/${config.TOKEN_ADDRESSES.AERO}`,  { timeout: 5000, headers: { 'User-Agent': 'DexBot/1.0' } }),
        ]);

        cache = {
            ethPrice:   bestPrice(wethRes.data?.pairs),
            cbbtcPrice: bestPrice(cbbtcRes.data?.pairs),
            cakePrice:  bestPrice(cakeRes.data?.pairs),
            aeroPrice:  bestPrice(aeroRes.data?.pairs),
            fetchedAt:  Date.now(),
        };
        log.info(`💹 WETH $${cache.ethPrice.toFixed(0)}  cbBTC $${cache.cbbtcPrice.toFixed(0)}  CAKE $${cache.cakePrice.toFixed(3)}  AERO $${cache.aeroPrice.toFixed(3)}`);
    } catch (e: any) {
        log.warn(`fetch failed: ${e.message}${cache ? ' — using stale cache' : ''}`);
    }

    return cache ?? { ethPrice: 0, cbbtcPrice: 0, cakePrice: 0, aeroPrice: 0, fetchedAt: 0 };
}

/** 同步讀取快取（不觸發 API），無快取時回傳全零。 */
export function getTokenPrices(): TokenPrices {
    return cache ?? { ethPrice: 0, cbbtcPrice: 0, cakePrice: 0, aeroPrice: 0, fetchedAt: 0 };
}
