import { PoolScanner } from './services/PoolScanner';
import { BBEngine } from './services/BBEngine';
import { RiskManager, PositionState } from './services/RiskManager';

// Mock position state per rules to evaluate risk logic.
let mockPositionState: PositionState = {
    capital: 20000,
    tickLower: -887270, // Example raw ticks that are within limits
    tickUpper: 887270,
    unclaimedFees: 12.4,
    cumulativeIL: -8.7,
    feeRate24h: 0.005, // 0.5% daily
};

let previousBandwidth = 0; // simple mock for avg30DBandwidth

async function executeDryRun() {
    console.log('Executing dry run...');
    try {
        const pools = await PoolScanner.scanAllCorePools();
        if (pools.length === 0) {
            console.warn('No pools found or subgraph error. Are endpoints reachable?');
            return;
        }

        console.log(`Successfully fetched data for ${pools.length} pools.`);

        // Find highest APR pool
        pools.sort((a, b) => b.apr - a.apr);
        console.log(`\n--- ALL POOLS (Sorted by APR) ---`);
        pools.forEach((pool, index) => {
            console.log(`${index + 1}. [${pool.dex}] ${pool.id} (Fee: ${(pool.feeTier * 100).toFixed(2)}%) -> APR: ${(pool.apr * 100).toFixed(2)}% | TVL: $${pool.tvlUSD.toFixed(0)}`);
        });
        console.log(`---------------------------------\n`);

        const highestPool = pools[0];

        console.log(`>> Selected Highest APR Pool: ${highestPool.dex} ${highestPool.id} (Fee Tier: ${(highestPool.feeTier * 100).toFixed(2)}%)`);
        console.log(`>> Estimated APR: ${(highestPool.apr * 100).toFixed(2)}% | TVL: $${highestPool.tvlUSD.toFixed(0)}`);
        console.log(`----------------------------------------`);

        // Compute dynamic BB for the highest pool
        let tickSpacing = 10;
        if (highestPool.feeTier === 0.0001) tickSpacing = 1; // 0.01%
        else if (highestPool.feeTier === 0.003) tickSpacing = 60; // 0.3%

        const bb = await BBEngine.computeDynamicBB(highestPool.id, highestPool.dex, tickSpacing, highestPool.tick);

        if (!bb) {
            console.warn('Failed to compute BB. Check GraphQL logs.');
            return;
        }

        // Bandwidth
        const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
        const avg30DBandwidth = previousBandwidth || currentBandwidth;
        previousBandwidth = currentBandwidth; // lazy update

        // Mock update to position fee rate based on highest pool APR
        mockPositionState.feeRate24h = highestPool.apr / 365;

        // Evaluate Risk
        const risk = RiskManager.analyzePosition(
            mockPositionState,
            bb,
            highestPool.dailyFeesUSD,
            avg30DBandwidth,
            currentBandwidth
        );

        const regime = bb.k === 1.8 ? 'Low Vol (震盪市)' : 'High Vol (趨勢市)';

        console.log(`BB Engine: `);
        console.log(` 20 SMA (1H): ${bb.sma.toFixed(6)}`);
        console.log(` Range: ${bb.lowerPrice.toFixed(6)} - ${bb.upperPrice.toFixed(6)} (k=${bb.k})`);
        console.log(` Ticks: [${bb.tickLower}, ${bb.tickUpper}]`);
        console.log(` Regime: ${regime} | Vol: ${(bb.volatility30D * 100).toFixed(2)}%`);
        if (bb.ethPrice > 0) {
            console.log(` ETH Price: $${bb.ethPrice.toFixed(2)}`);
            console.log(` ETH/BTC Ratio Bounds:`);
            console.log(`   Min Price Ratio: ${bb.minPriceRatio.toFixed(5)} (ETH Price / Upper BB)`);
            console.log(`   Max Price Ratio: ${bb.maxPriceRatio.toFixed(5)} (ETH Price / Lower BB)`);
        }

        console.log(`\nRisk Analysis:`);
        console.log(` Health Score: ${risk.healthScore}/100`);
        console.log(` IL Breakeven Days: ${risk.ilBreakevenDays} Days`);
        console.log(` Compound Signal: ${risk.compoundSignal ? 'YES' : 'NO'} (Threshold: $${risk.compoundThreshold.toFixed(2)})`);

        if (risk.redAlert) console.log(` [ALERT] RED ALERT: High IL Breakeven`);
        if (risk.highVolatilityAvoid) console.log(` [ALERT] HIGH VOLATILITY AVOID: High bandwidth`);
        if (risk.driftWarning) console.log(` [ALERT] DRIFT WARNING: Overlap ${risk.driftOverlapPct.toFixed(1)}%`);

        console.log(`----------------------------------------`);
        console.log('Dry run complete.');

    } catch (error) {
        console.error('Error in dry run cycle:', error);
    }
}

executeDryRun().catch(console.error);
