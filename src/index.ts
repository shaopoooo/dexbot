import cron from 'node-cron';
import { PoolScanner, PoolStats } from './services/PoolScanner';
import { BBEngine, BBResult } from './services/BBEngine';
import { RiskManager, PositionState, RiskAnalysis } from './services/RiskManager';
import { TelegramBotService } from './bot/TelegramBot';
import { PositionScanner, PositionRecord } from './services/PositionScanner';
import { createServiceLogger } from './utils/logger';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();

// Shared In-Memory State across scheduled tasks
let latestPools: PoolStats[] = [];
let highestPool: PoolStats | null = null;
let activePositions: PositionRecord[] = [];
let latestBBs: Record<string, BBResult> = {}; // keyed by pool Address
let latestRisks: Record<string, RiskAnalysis> = {}; // keyed by position tokenId

let previousBandwidth = 0; // simple mock for avg30DBandwidth

export const lastUpdates = {
  poolScanner: 0,
  positionScanner: 0,
  bbEngine: 0,
  riskManager: 0
};

let activeTasks = 0;
let isStartupComplete = false;

// 1. Pool Scanner
async function runPoolScanner() {
  activeTasks++;
  log.info('PoolScanner started');
  try {
    const pools = await PoolScanner.scanAllCorePools();
    if (pools.length === 0) {
      log.warn('No pools found or subgraph error.');
      return;
    }
    pools.sort((a, b) => b.apr - a.apr);

    latestPools = pools;
    highestPool = pools[0];
    lastUpdates.poolScanner = Date.now();
    log.info(`PoolScanner completed: ${latestPools.length} pools fetched. Highest APR: ${highestPool.dex} ${(highestPool.feeTier * 100).toFixed(2)}% fee → APR ${(highestPool.apr * 100).toFixed(2)}%, TVL $${highestPool.tvlUSD.toFixed(0)}`);
  } catch (error) {
    log.error(`Error in PoolScanner task: ${error}`);
  } finally { activeTasks--; }
}

// 2. Position Scanner
async function runPositionScanner() {
  activeTasks++;
  log.info('PositionScanner started');
  try {
    await PositionScanner.updateAllPositions();
    const positions = PositionScanner.getTrackedPositions();
    activePositions = positions.filter((p) => Number(p.liquidity) > 0);
    lastUpdates.positionScanner = Date.now();
    log.info(`PositionScanner completed: ${activePositions.length} active position(s) out of ${positions.length} total tracked`);
  } catch (error) {
    log.error(`Error in PositionScanner task: ${error}`);
  } finally { activeTasks--; }
}

// 3. BBEngine
async function runBBEngine() {
  activeTasks++;
  log.info(`BBEngine started: processing ${activePositions.length} position pool(s) + highestPool`);
  try {
    // Collect all relevant pools (highestPool + active position pools)
    const poolsToProcess = new Map<string, PoolStats>();
    if (highestPool) poolsToProcess.set(highestPool.id.toLowerCase(), highestPool);

    for (const pos of activePositions) {
      const poolData = latestPools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      if (poolData) {
        poolsToProcess.set(poolData.id.toLowerCase(), poolData);
      }
    }

    for (const [poolAddress, poolData] of poolsToProcess.entries()) {
      let posTickSpacing = 10;
      if (poolData.feeTier === 0.0001) posTickSpacing = 1;
      else if (poolData.feeTier === 0.003) posTickSpacing = 60;

      const bb = await BBEngine.computeDynamicBB(
        poolData.id,
        poolData.dex,
        posTickSpacing,
        poolData.tick
      );

      if (bb) {
        latestBBs[poolAddress] = bb;
      }
    }
    lastUpdates.bbEngine = Date.now();
    log.info(`BBEngine completed: computed BB for ${poolsToProcess.size} pool(s)`);
  } catch (error) {
    log.error(`Error in BBEngine task: ${error}`);
  } finally { activeTasks--; }
}

// 4. RiskManager
async function runRiskManager() {
  activeTasks++;
  log.info(`RiskManager started: analyzing ${activePositions.length} position(s)`);
  try {
    for (const pos of activePositions) {
      const poolData = latestPools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );

      if (!poolData) continue;

      const bb = latestBBs[poolData.id.toLowerCase()];
      if (!bb) continue;

      const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
      const avg30DBandwidth = previousBandwidth || currentBandwidth;
      previousBandwidth = currentBandwidth;

      const positionState: PositionState = {
        capital: pos.positionValueUSD || 1000,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        unclaimedFees: pos.unclaimedFeesUSD,
        cumulativeIL: pos.ilUSD || 0,
        feeRate24h: poolData.apr / 365,
      };

      const risk = RiskManager.analyzePosition(
        positionState,
        bb,
        poolData.dailyFeesUSD,
        avg30DBandwidth,
        currentBandwidth
      );

      latestRisks[pos.tokenId] = risk;
    }
    lastUpdates.riskManager = Date.now();
    log.info(`RiskManager completed: ${Object.keys(latestRisks).length} risk analysis record(s) updated`);
  } catch (error) {
    log.error(`Error in RiskManager task: ${error}`);
  } finally { activeTasks--; }
}

// 5. Telegram Bot Reporting (Every 1 hour)
async function runBotService() {
  if (!isStartupComplete) {
    log.info('[BotService] Skipped: Initial data sync not complete yet.');
    return;
  }

  // Wait until all executing tasks are free
  while (activeTasks > 0) {
    log.info(`[BotService] Waiting for ${activeTasks} active services to complete...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  log.info('BotService started: preparing Telegram reports');
  try {
    if (activePositions.length === 0) {
      log.info('BotService skipped: no active tracked positions to report.');
      return;
    }

    if (!highestPool) return;

    for (const pos of activePositions) {
      const poolData = latestPools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );

      const bb = latestBBs[poolData?.id.toLowerCase() || ''];
      const risk = latestRisks[pos.tokenId];

      if (!poolData || !risk) {
        log.warn(`Missing data for position ${pos.tokenId}, skipping report.`);
        continue;
      }

      await botService.sendFormattedReport(pos, poolData, bb || null, risk, highestPool, lastUpdates);
      log.info(`BotService: report sent for position tokenId=${pos.tokenId} pool=${poolData.dex} ${(poolData.feeTier * 100).toFixed(2)}%`);
    }
  } catch (error) {
    log.error(`Error in Bot Service task: ${error}`);
  }
}

async function main() {
  log.info('=== DexInfoBot starting up ===');

  // Start bot webhook or polling
  botService.startBot().catch((e) => log.error(`Bot start error: ${e}`));

  // Initial sync: fetch positions from chain first
  await PositionScanner.syncFromChain();

  // Initial runs to populate state
  await runPoolScanner();
  await runPositionScanner();
  await runBBEngine();
  await runRiskManager();

  isStartupComplete = true;
  log.info('Initial data sync complete. Enabling scheduled bot service.');

  // Schedule distinct cron jobs based on intervals
  // Execute sequentially every 5 minutes to guarantee data readiness before BotService
  cron.schedule('*/5 * * * *', async () => {
    log.info('--- Starting scheduled 5-minute update cycle ---');

    // 1. Fetch market data
    await runPoolScanner().catch((e) => log.error(`Cron PoolScanner error: ${e}`));

    // 2. Fetch user position data
    await runPositionScanner().catch((e) => log.error(`Cron PositionScanner error: ${e}`));

    // 3. Compute BB & Risks based on fresh data
    await runBBEngine().catch((e) => log.error(`Cron BBEngine error: ${e}`));
    await runRiskManager().catch((e) => log.error(`Cron RiskManager error: ${e}`));

    // 4. Send report (will use newest data just computed)
    await runBotService().catch((e) => log.error(`Cron BotService error: ${e}`));

    log.info('--- Scheduled update cycle completed ---');
  });
}

main().catch((e) => log.error(`Main error: ${e}`));
