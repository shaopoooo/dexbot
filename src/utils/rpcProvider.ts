import { ethers } from 'ethers';
import { config } from '../config';
import { createServiceLogger } from './logger';

const log = createServiceLogger('RPC');

/**
 * Creates a FallbackProvider using the primary RPC_URL and multiple fallback RPCs.
 * If only one URL is available, returns a simple JsonRpcProvider.
 */
function createProvider(): ethers.JsonRpcProvider | ethers.FallbackProvider {
    const allUrls = [config.RPC_URL, ...config.RPC_FALLBACKS];
    const baseNetwork = new ethers.Network('base', 8453);

    if (allUrls.length === 1) {
        return new ethers.JsonRpcProvider(allUrls[0], baseNetwork, { staticNetwork: baseNetwork });
    }

    const providers = allUrls.map((url, i) => ({
        provider: new ethers.JsonRpcProvider(url, baseNetwork, { staticNetwork: true }),
        priority: i + 1,       // primary = 1 (highest), fallbacks = 2, 3, ...
        stallTimeout: 3000,     // 3s before falling back
        weight: 1
    }));

    log.info(`Initialized FallbackProvider with ${allUrls.length} RPC endpoints: ${allUrls.join(', ')}`);

    return new ethers.FallbackProvider(providers, baseNetwork, {
        quorum: 1, // only need 1 provider to respond
        eventQuorum: 1
    });
}

export const rpcProvider = createProvider();

export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Retry wrapper for RPC calls that may fail due to rate limiting */
export async function rpcRetry<T>(fn: () => Promise<T>, label: string, retries = 3, backoffMs = 2000): Promise<T> {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await fn();
        } catch (error: any) {
            // Ethers v6 rate limit errors can be nested or just 'CALL_EXCEPTION' with 'missing revert data'
            const errMsg = (error?.message || '').toLowerCase();
            const infoMsg = (error?.info?.error?.message || '').toLowerCase();

            const isRateLimit =
                (error.code === 'CALL_EXCEPTION' && error.data === null) ||
                errMsg.includes('rate limit') ||
                errMsg.includes('too many requests') ||
                infoMsg.includes('rate limit');

            if (isRateLimit && attempt < retries) {
                log.warn(`RPC rate-limited on ${label}. Backing off ${backoffMs * attempt}ms... (attempt ${attempt}/${retries})`);
                await delay(backoffMs * attempt);
            } else {
                log.error(`RPC failed permanently on ${label}: ${error.message} (code: ${error.code})`);
                throw error;
            }
        }
    }
    throw new Error(`rpcRetry exhausted for ${label}`);
}
