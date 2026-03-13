/**
 * dryrun.ts — One-shot scan without starting the Telegram bot or cron scheduler.
 * Useful for verifying config, RPC connectivity, and data pipeline output.
 *
 * Usage: npm run dryrun
 */
import { PoolScanner, PoolStats } from './services/PoolScanner';
import { BBEngine, BBResult } from './services/BBEngine';
import { RiskManager, PositionState, RiskAnalysis } from './services/RiskManager';
import { PositionScanner, PositionRecord } from './services/PositionScanner';
import { PositionAggregator } from './services/PositionAggregator';
import { createServiceLogger } from './utils/logger';

const log = createServiceLogger('Dryrun');

async function main() {
    log.section('DexBot dryrun — single-pass scan (no Telegram, no cron)');

    // 1. Sync positions from chain
    log.info('Syncing positions from chain...');
    await PositionScanner.syncFromChain();

    // 2. Pool Scanner
    log.info('Running PoolScanner...');
    const pools = await PoolScanner.scanAllCorePools();
    pools.sort((a, b) => b.apr - a.apr);
    log.info(`Pools (${pools.length}):`);
    pools.forEach((p, i) => {
        const label = `${p.dex} ${(p.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
        const tvl = p.tvlUSD >= 1000 ? `$${(p.tvlUSD / 1000).toFixed(0)}K` : `$${p.tvlUSD.toFixed(0)}`;
        log.info(`  #${i + 1} ${label} — APR ${(p.apr * 100).toFixed(1)}%  TVL ${tvl}`);
    });

    // 3. BB Engine — compute for all active positions' pools
    const latestBBs: Record<string, BBResult> = {};
    const positions = PositionScanner.getTrackedPositions();
    const activePositions: PositionRecord[] = positions.filter(p => Number(p.liquidity) > 0);

    log.info(`Running BBEngine for ${activePositions.length} active position(s)...`);
    const poolsToProcess = new Map<string, PoolStats>();
    for (const pos of activePositions) {
        const poolData = pools.find(
            p => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
        );
        if (poolData) poolsToProcess.set(poolData.id.toLowerCase(), poolData);
    }
    for (const [poolAddress, poolData] of poolsToProcess.entries()) {
        let tickSpacing = 10;
        if (poolData.feeTier === 0.0001)   tickSpacing = 1;
        else if (poolData.feeTier === 0.003)    tickSpacing = 60;
        else if (poolData.feeTier === 0.000085) tickSpacing = 1;
        const bb = await BBEngine.computeDynamicBB(poolData.id, poolData.dex, tickSpacing, poolData.tick);
        if (bb) latestBBs[poolAddress] = bb;
    }

    // 4. Position Scanner — fetch raw chain data, aggregate, then update
    log.info('Running PositionScanner...');
    const rawPositions = await PositionScanner.fetchAll();
    const assembled = await PositionAggregator.aggregateAll(rawPositions, latestBBs, pools);
    PositionScanner.updatePositions(assembled);
    const updatedPositions = PositionScanner.getTrackedPositions().filter(p => Number(p.liquidity) > 0);

    // 5. Risk Manager + print results
    log.info('Running RiskManager and printing results:');
    const previousBandwidths: Record<string, number> = {};
    for (const pos of updatedPositions) {
        const poolData = pools.find(
            p => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
        );
        if (!poolData) { log.warn(`No pool data for tokenId ${pos.tokenId}`); continue; }
        const bb = latestBBs[poolData.id.toLowerCase()];
        if (!bb) { log.warn(`No BB for tokenId ${pos.tokenId}`); continue; }

        const poolKey = poolData.id.toLowerCase();
        const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
        const avg30DBandwidth = previousBandwidths[poolKey] || currentBandwidth;
        previousBandwidths[poolKey] = currentBandwidth;

        const positionState: PositionState = {
            capital: pos.positionValueUSD || 1000,
            tickLower: pos.tickLower,
            tickUpper: pos.tickUpper,
            unclaimedFees: pos.unclaimedFeesUSD,
            cumulativeIL: pos.ilUSD ?? 0,
            feeRate24h: poolData.apr / 365,
        };
        const risk: RiskAnalysis = RiskManager.analyzePosition(
            positionState, bb, poolData.dailyFeesUSD, avg30DBandwidth, currentBandwidth
        );

        const label = `${poolData.dex} ${(poolData.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
        const walletShort = pos.ownerWallet
            ? `${pos.ownerWallet.slice(0, 6)}...${pos.ownerWallet.slice(-4)}`
            : '?';
        log.info(
            `[#${pos.tokenId}] ${label} | ${walletShort}\n` +
            `  Value $${pos.positionValueUSD.toFixed(0)} | APR ${(poolData.apr * 100).toFixed(1)}% | Health ${risk.healthScore}/100\n` +
            `  Price ${pos.currentPriceStr} | Range ${pos.minPrice}~${pos.maxPrice}\n` +
            `  BB    ${pos.bbMinPrice ?? '?'}~${pos.bbMaxPrice ?? '?'} (${bb.regime})\n` +
            `  Unclaimed $${pos.unclaimedFeesUSD.toFixed(1)} | IL ${pos.ilUSD === null ? 'N/A' : `$${pos.ilUSD.toFixed(1)}`}\n` +
            `  Breakeven ${risk.ilBreakevenDays}d | Compound ${risk.compoundSignal ? 'YES' : 'no'} ($${pos.unclaimedFeesUSD.toFixed(1)} vs $${risk.compoundThreshold.toFixed(1)})\n` +
            `  Drift ${risk.driftWarning ? `WARNING ${risk.driftOverlapPct.toFixed(1)}%` : 'ok'} | RedAlert ${risk.redAlert} | HighVol ${risk.highVolatilityAvoid}`
        );
    }

    log.section('dryrun complete');
}

main().catch(e => {
    console.error('Dryrun failed:', e);
    process.exit(1);
});
