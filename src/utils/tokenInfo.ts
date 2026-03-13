/**
 * Token metadata helpers — decimal lookup and symbol inference.
 * Single source of truth; replaces inline ternaries and local TOKEN_DEC maps.
 */
import { config } from '../config';

const CBBTC_ADDR = config.TOKEN_ADDRESSES.CBBTC.toLowerCase();

/** Decimals keyed by canonical symbol (covers all tokens tracked by DexBot). */
export const TOKEN_DECIMALS: Record<string, number> = {
    WETH:  18,
    cbBTC: 8,
    CAKE:  18,
    AERO:  18,
};

/**
 * Returns the ERC-20 decimal count for a token address.
 * Only CBBTC has 8; everything else (WETH, CAKE, AERO) is 18.
 */
export function getTokenDecimals(address: string): number {
    return address.toLowerCase() === CBBTC_ADDR ? 8 : 18;
}

/**
 * Returns the display symbol for a token address (cbBTC or WETH).
 * Used for token0/token1 in LP positions — not for reward tokens.
 */
export function getTokenSymbol(address: string): 'cbBTC' | 'WETH' {
    return address.toLowerCase() === CBBTC_ADDR ? 'cbBTC' : 'WETH';
}
