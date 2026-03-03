import { ethers } from 'ethers';
import { config } from '../config';
import { PoolScanner } from './PoolScanner';
import { BBEngine } from './BBEngine';
import { RiskManager } from './RiskManager';
import { RebalanceService, RebalanceSuggestion } from './rebalance';
import { ILCalculatorService } from './ILCalculator';
import { createServiceLogger, positionLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay } from '../utils/rpcProvider';

const log = createServiceLogger('PositionScanner');

export interface PositionRecord {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap';
    poolAddress: string;
    feeTier: number;
    token0Symbol: string;
    token1Symbol: string;
    ownerWallet: string;

    // Live Snapshot 
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    minPrice: string;
    maxPrice: string;
    bbMinPrice?: string; // Natively scaled BB lower bound
    bbMaxPrice?: string; // Natively scaled BB upper bound
    currentTick: number;
    currentPriceStr: string;
    positionValueUSD: number;

    // Fees & IL
    unclaimed0: string;
    unclaimed1: string;
    unclaimedFeesUSD: number;
    collectedFeesUSD: number;

    // Risk
    overlapPercent: number;
    ilUSD: number;
    breakevenDays: number;
    healthScore: number;
    regime: string;

    // Metadata
    lastUpdated: number;
    volSource: string;    // e.g. 'The Graph (PancakeSwap)', 'GeckoTerminal', 'stale cache'
    priceSource: string;  // e.g. 'The Graph (Uniswap)', 'GeckoTerminal'
    bbFallback: boolean;  // True if BBEngine failed and returned a fallback
    rebalance?: RebalanceSuggestion;
}

export class PositionScanner {

    /** In-memory position store (replaces positions.json) */
    private static positions: PositionRecord[] = [];
    private static initialized = false;

    /**
     * Fetches LP NFT positions from on-chain for the configured wallet.
     * Called once at startup to seed the in-memory state.
     */
    static async syncFromChain() {
        if (!config.WALLET_ADDRESS) {
            log.info('No WALLET_ADDRESS configured. Skipping chain sync.');
            return;
        }

        log.info(`Syncing LP NFT positions from chain for wallet=${config.WALLET_ADDRESS}...`);
        const seedPositions: PositionRecord[] = [];
        const dexes: ('Uniswap' | 'PancakeSwap')[] = ['Uniswap', 'PancakeSwap'];

        for (const dex of dexes) {
            try {
                const npmAddress = config.NPM_ADDRESSES[dex];
                if (!npmAddress) continue;

                const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, rpcProvider);
                const balance = await rpcRetry(
                    () => npmContract.balanceOf(config.WALLET_ADDRESS),
                    `${dex}.balanceOf`
                );
                log.info(`${dex}: Found ${balance} LP NFT(s) for wallet ${config.WALLET_ADDRESS}`);

                for (let i = 0; i < Number(balance); i++) {
                    await delay(500); // small delay between each NFT fetch
                    const tokenId = await rpcRetry(
                        () => npmContract.tokenOfOwnerByIndex(config.WALLET_ADDRESS, i),
                        `${dex}.tokenOfOwnerByIndex(${i})`
                    );
                    log.info(`${dex}: Discovered tokenId=${tokenId.toString()}`);
                    seedPositions.push({
                        tokenId: tokenId.toString(),
                        dex,
                        poolAddress: '',
                        feeTier: 0,
                        token0Symbol: '',
                        token1Symbol: '',
                        ownerWallet: config.WALLET_ADDRESS,
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
                        unclaimedFeesUSD: 0,
                        collectedFeesUSD: 0,
                        overlapPercent: 0,
                        ilUSD: 0,
                        breakevenDays: 0,
                        healthScore: 0,
                        regime: 'Unknown',
                        lastUpdated: 0,
                        volSource: 'pending',
                        priceSource: 'pending',
                        bbFallback: false,
                    });
                }
            } catch (error) {
                log.error(`Failed to fetch LP NFTs from ${dex} NPM contract: ${error}`);
            }
            await delay(1000); // delay between DEXes to avoid RPC rate limit
        }

        this.positions = seedPositions;
        this.initialized = true;
        log.info(`Chain sync completed: ${this.positions.length} position(s) loaded into memory.`);
    }

    /**
     * Returns the current in-memory tracked positions.
     */
    static getTrackedPositions(): PositionRecord[] {
        return this.positions;
    }

    /**
     * Log position snapshots to the dedicated positions.log (append-only history).
     */
    private static logPositionSnapshots(positions: PositionRecord[]) {
        for (const pos of positions) {
            positionLogger.info('position_snapshot', {
                tokenId: pos.tokenId,
                dex: pos.dex,
                pool: pos.poolAddress,
                feeTier: pos.feeTier,
                liquidity: pos.liquidity,
                currentTick: pos.currentTick,
                tickLower: pos.tickLower,
                tickUpper: pos.tickUpper,
                price: pos.currentPriceStr,
                minPrice: pos.minPrice,
                maxPrice: pos.maxPrice,
                positionValueUSD: pos.positionValueUSD,
                unclaimed0: pos.unclaimed0,
                unclaimed1: pos.unclaimed1,
                unclaimedFeesUSD: pos.unclaimedFeesUSD,
                ilUSD: pos.ilUSD,
                healthScore: pos.healthScore,
                regime: pos.regime,
                breakevenDays: pos.breakevenDays,
                overlapPercent: pos.overlapPercent
            });
        }
    }

    /**
     * Core routine to scan a specific NFT position, fetch live data, compute IL & BB overlap, and update the record.
     */
    static async scanPosition(tokenId: string, dex: 'Uniswap' | 'PancakeSwap'): Promise<PositionRecord | null> {
        try {
            const npmAddress = config.NPM_ADDRESSES[dex];
            const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, rpcProvider);

            // Fetch live position details
            const owner = await npmContract.ownerOf(tokenId);
            const position = await npmContract.positions(tokenId);

            // For this version, we will look up the token addresses to find the pool
            // and assume cbBTC/WETH standard formatting. 
            const feeTier = Number(position.fee);
            const poolAddress = await this.getPoolFromTokens(position.token0, position.token1, feeTier);
            if (!poolAddress) return null;

            // Fetch live pool info & BB Engine
            let tickSpacing = 60;
            if (feeTier === 100) tickSpacing = 1; // 0.01%
            else if (feeTier === 500) tickSpacing = 10; // 0.05%

            const poolStats = await PoolScanner.fetchPoolStats(poolAddress, dex, feeTier / 1000000);
            if (!poolStats) return null;

            const bb = await BBEngine.computeDynamicBB(poolAddress, dex, tickSpacing, poolStats.tick);

            // Unclaimed fees (requires static call to collect)
            // NPM collect(params) returns (amount0, amount1)
            let unclaimed0 = 0n;
            let unclaimed1 = 0n;
            try {
                const MAX_UINT128 = 2n ** 128n - 1n;
                const result = await npmContract.collect.staticCall({
                    tokenId: tokenId,
                    recipient: owner,
                    amount0Max: MAX_UINT128,
                    amount1Max: MAX_UINT128
                });
                unclaimed0 = BigInt(result.amount0);
                unclaimed1 = BigInt(result.amount1);
            } catch (e) {
                // If it fails, fallback to owed (which may be outdated if pos is active)
                unclaimed0 = BigInt(position.tokensOwed0);
                unclaimed1 = BigInt(position.tokensOwed1);
            }

            // --- Address token decimal conversion for prices and amounts ---
            // On Base, WETH = 18 decimals, cbBTC = 8 decimals.
            const wethAddr = '0x4200000000000000000000000000000000000006'.toLowerCase();
            const cbbtcAddr = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf'.toLowerCase();
            const t0 = position.token0.toLowerCase();
            const t1 = position.token1.toLowerCase();
            const dec0 = (t0 === cbbtcAddr) ? 8 : 18;
            const dec1 = (t1 === cbbtcAddr) ? 8 : 18;

            const amount0Normalized = Number(unclaimed0) / Math.pow(10, dec0);
            const amount1Normalized = Number(unclaimed1) / Math.pow(10, dec1);

            // Mock prices for USD value
            const wethPrice = bb?.ethPrice || 2500;
            const cbbtcPrice = 65000;
            const price0 = (t0 === cbbtcAddr) ? cbbtcPrice : wethPrice;
            const price1 = (t1 === cbbtcAddr) ? cbbtcPrice : wethPrice;

            const unclaimedFeesUSD = (amount0Normalized * price0) + (amount1Normalized * price1);

            // (Moved calculation down below positionValueUSD)

            let overlapPercent = 0;
            let breakevenDays = 0;
            let healthScore = 0;
            let regime = 'Unknown';

            // Convert ticks to human-readable prices: price = 1.0001^tick * 10^(dec0 - dec1)
            const tickToPrice = (t: number) => Math.pow(1.0001, t) * Math.pow(10, dec0 - dec1);

            // Note: If t0 is WETH and t1 is cbBTC, price is cbBTC per WETH (~0.038)
            // If we want WETH per cbBTC, we'd invert it. We'll leave it as Token1/Token0 natively to match DexScreener convention for this pair.
            const minPrice = tickToPrice(Number(position.tickLower)).toFixed(8);
            const maxPrice = tickToPrice(Number(position.tickUpper)).toFixed(8);
            const currentPrice = tickToPrice(poolStats.tick).toFixed(8);

            let bbMinPrice: string | undefined;
            let bbMaxPrice: string | undefined;
            if (bb) {
                // Determine native scaled prices for BB ticks to match minPrice/maxPrice format
                bbMinPrice = tickToPrice(bb.tickLower).toFixed(8);
                bbMaxPrice = tickToPrice(bb.tickUpper).toFixed(8);
            }

            // Rough position value estimate: if in-range, approximate half in each token
            // Full math needs sqrtPrice; this gives a ballpark figure
            const isInRange = poolStats.tick >= Number(position.tickLower) && poolStats.tick <= Number(position.tickUpper);
            const tokenValueHold = isInRange ? (amount0Normalized * price0 + amount1Normalized * price1) : 0;
            const positionValueUSD = tokenValueHold > 0 ? tokenValueHold : unclaimedFeesUSD; // fallback to fees if out-of-range

            // Calculate true Absolute PNL (Impermanent Loss vs HODL FIAT Base)
            const totalCollectedAndUnclaimedFeesUSD = unclaimedFeesUSD + 0; // Add historically parsed collected fees if available
            const exactIL = ILCalculatorService.calculateAbsolutePNL(tokenId, positionValueUSD, totalCollectedAndUnclaimedFeesUSD) || 0;

            // Fetch Risk Analysis
            const riskState = {
                capital: 1000, // Mock Capital for now
                tickLower: Number(position.tickLower),
                tickUpper: Number(position.tickUpper),
                unclaimedFees: unclaimedFeesUSD,
                cumulativeIL: exactIL,
                feeRate24h: poolStats.apr / 365
            };

            let rebalanceSuggestion: RebalanceSuggestion | undefined;

            if (bb) {
                const risk = RiskManager.analyzePosition(riskState, bb, poolStats.dailyFeesUSD, 0, 0);
                overlapPercent = risk.driftOverlapPct;
                breakevenDays = risk.ilBreakevenDays;
                healthScore = risk.healthScore;
                regime = bb.regime;

                const token0Sym = t0 === cbbtcAddr ? 'cbBTC' : 'WETH';
                const token1Sym = t1 === cbbtcAddr ? 'cbBTC' : 'WETH';

                const rb = RebalanceService.getRebalanceSuggestion(
                    parseFloat(currentPrice),
                    bb,
                    unclaimedFeesUSD,
                    breakevenDays,
                    positionValueUSD,
                    token0Sym,
                    token1Sym
                );
                if (rb) rebalanceSuggestion = rb;
            }

            const record: PositionRecord = {
                tokenId,
                dex,
                poolAddress,
                feeTier: Number(position.fee) / 1000000,
                token0Symbol: t0 === cbbtcAddr ? 'cbBTC' : 'WETH',
                token1Symbol: t1 === cbbtcAddr ? 'cbBTC' : 'WETH',
                ownerWallet: owner,

                liquidity: position.liquidity.toString(),
                tickLower: Number(position.tickLower),
                tickUpper: Number(position.tickUpper),
                minPrice,
                maxPrice,
                bbMinPrice,
                bbMaxPrice,
                currentTick: poolStats.tick,
                currentPriceStr: currentPrice.toString(),
                positionValueUSD,

                unclaimed0: unclaimed0.toString(),
                unclaimed1: unclaimed1.toString(),
                unclaimedFeesUSD,
                collectedFeesUSD: 0, // Needs event listener to track historical collections
                rebalance: rebalanceSuggestion,

                overlapPercent,
                ilUSD: exactIL, // Calculate against entry value (TODO)
                breakevenDays,
                healthScore,
                regime,

                lastUpdated: Date.now(),
                volSource: poolStats.volSource ?? 'unknown',
                priceSource: bb && !bb.isFallback ? `The Graph / GeckoTerminal` : 'RPC (Fallback)',
                bbFallback: bb ? !!bb.isFallback : true,
            };

            return record;

        } catch (error) {
            log.error(`Error scanning position tokenId=${tokenId} dex=${dex}: ${error}`);
            return null;
        }
    }

    /**
     * Helper to find a pool address given two tokens and a fee.
     * Uses Uniswap V3 Factory. (Pancake is similar).
     */
    private static async getPoolFromTokens(tokenA: string, tokenB: string, fee: number): Promise<string | null> {
        // This is a simplified static map since Base core pools are known.
        const map: Record<string, string> = {
            '100': config.POOLS?.PANCAKE_0_01 || '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
            '500': config.POOLS?.UNISWAP_0_05 || '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
            '3000': config.POOLS?.UNISWAP_0_3 || '0x8c7080564b5a792a33ef2fd473fba6364d5495e5'
        };
        return map[fee.toString()] || null;
    }

    /**
     * Update all tracked positions: re-scan from chain and log snapshots.
     */
    static async updateAllPositions() {
        if (!this.initialized) {
            await this.syncFromChain();
        }

        if (this.positions.length === 0) {
            log.info('No tracked positions in memory. Skipping update cycle.');
            return;
        }

        const updated: PositionRecord[] = [];
        for (const pos of this.positions) {
            const freshData = await this.scanPosition(pos.tokenId, pos.dex);
            if (freshData) {
                updated.push({ ...pos, ...freshData, lastUpdated: Date.now() });
            } else {
                updated.push(pos);
            }
        }

        this.positions = updated;

        // Log snapshots to dedicated positions.log for historical audit
        this.logPositionSnapshots(updated);

        log.info(`Position update cycle completed: ${updated.length} position(s) refreshed. Snapshots written to positions.log.`);
    }
}
