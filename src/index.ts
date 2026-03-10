import cron from 'node-cron';
import { PoolScanner, PoolStats } from './services/PoolScanner';
import { BBEngine, BBResult, getPriceBufferSnapshot, restorePriceBuffer } from './services/BBEngine';
import { RiskManager, PositionState, RiskAnalysis } from './services/RiskManager';
import { PnlCalculator } from './services/PnlCalculator';
import { TelegramBotService } from './bot/TelegramBot';
import { PositionScanner, PositionRecord, getOpenTimestampSnapshot, restoreOpenTimestamps } from './services/PositionScanner';
import { createServiceLogger } from './utils/logger';
import { fetchGasCostUSD } from './utils/rpcProvider';
import { loadState, saveState, restoreState, DiscoveredPosition } from './utils/stateManager';
import { config } from './config';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();

// Shared In-Memory State across scheduled tasks
let latestPools: PoolStats[] = [];
let activePositions: PositionRecord[] = [];
let latestBBs: Record<string, BBResult> = {}; // keyed by pool Address
let latestRisks: Record<string, RiskAnalysis> = {}; // keyed by position tokenId

const previousBandwidths: Record<string, number> = {}; // keyed by poolAddress

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
  try {
    const pools = await PoolScanner.scanAllCorePools();
    if (pools.length === 0) {
      log.warn('no pools returned — subgraph or RPC error');
      return;
    }
    pools.sort((a, b) => b.apr - a.apr);
    latestPools = pools;
    lastUpdates.poolScanner = Date.now();
    const top = latestPools[0];
    const topTvl = top.tvlUSD >= 1000 ? `$${(top.tvlUSD / 1000).toFixed(0)}K` : `$${top.tvlUSD.toFixed(0)}`;
    log.info(`✅ pools(${latestPools.length})  top: ${top.dex} ${(top.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}% — APR ${(top.apr * 100).toFixed(1)}%  TVL ${topTvl}`);
  } catch (error) {
    log.error(`PoolScanner: ${error}`);
  } finally { activeTasks--; }
}

// 2. Position Scanner
async function runPositionScanner() {
  activeTasks++;
  try {
    await PositionScanner.updateAllPositions(latestBBs);
    const positions = PositionScanner.getTrackedPositions();
    activePositions = positions.filter((p) => Number(p.liquidity) > 0);
    lastUpdates.positionScanner = Date.now();
    log.info(`✅ positions  active ${activePositions.length}/${positions.length} tracked`);
  } catch (error) {
    log.error(`PositionScanner: ${error}`);
  } finally { activeTasks--; }
}

// 3. BBEngine
async function runBBEngine() {
  activeTasks++;
  try {
    const poolsToProcess = new Map<string, PoolStats>();

    for (const pos of activePositions) {
      const poolData = latestPools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      if (poolData) poolsToProcess.set(poolData.id.toLowerCase(), poolData);
    }

    for (const [poolAddress, poolData] of poolsToProcess.entries()) {
      let posTickSpacing = 10;
      if (poolData.feeTier === 0.0001) posTickSpacing = 1;
      else if (poolData.feeTier === 0.003) posTickSpacing = 60;
      else if (poolData.feeTier === 0.000085) posTickSpacing = 1; // Aerodrome 0.0085%

      const bb = await BBEngine.computeDynamicBB(poolData.id, poolData.dex, posTickSpacing, poolData.tick);
      if (bb) latestBBs[poolAddress] = bb;
    }
    lastUpdates.bbEngine = Date.now();
    log.info(`✅ BB bands computed for ${poolsToProcess.size} pool(s)`);
  } catch (error) {
    log.error(`BBEngine: ${error}`);
  } finally { activeTasks--; }
}

// 4. RiskManager
async function runRiskManager() {
  activeTasks++;
  try {
    const gasCostUSD = await fetchGasCostUSD().catch(() => 1.5);
    for (const pos of activePositions) {
      const poolData = latestPools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );

      if (!poolData) continue;

      const bb = latestBBs[poolData.id.toLowerCase()];
      if (!bb) continue;

      const poolKey = poolData.id.toLowerCase();
      const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
      const avg30DBandwidth = previousBandwidths[poolKey] || currentBandwidth;
      previousBandwidths[poolKey] = currentBandwidth;

      const positionState: PositionState = {
        capital: PnlCalculator.getInitialCapital(pos.tokenId) ?? pos.positionValueUSD,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        unclaimedFees: pos.unclaimedFeesUSD,
        cumulativeIL: pos.ilUSD ?? 0,
        feeRate24h: poolData.apr / 365,
      };

      const risk = RiskManager.analyzePosition(
        positionState,
        bb,
        poolData.dailyFeesUSD,
        avg30DBandwidth,
        currentBandwidth,
        gasCostUSD
      );

      latestRisks[pos.tokenId] = risk;
    }
    lastUpdates.riskManager = Date.now();
    log.info(`✅ risk analysis updated for ${Object.keys(latestRisks).length} position(s)`);
  } catch (error) {
    log.error(`RiskManager: ${error}`);
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

  try {
    if (activePositions.length === 0) {
      log.info('BotService skipped: no active positions');
      return;
    }

    const entries: Array<{ position: PositionRecord; pool: PoolStats; bb: BBResult | null; risk: RiskAnalysis }> = [];
    for (const pos of activePositions) {
      const poolData = latestPools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      const bb = latestBBs[poolData?.id.toLowerCase() || ''];
      const risk = latestRisks[pos.tokenId];

      if (!poolData || !risk) {
        log.warn(`Missing data for position ${pos.tokenId}, skipping.`);
        continue;
      }
      entries.push({ position: pos, pool: poolData, bb: bb || null, risk });
    }

    if (entries.length === 0) return;

    await botService.sendConsolidatedReport(entries, latestPools, lastUpdates);
    log.info(`✅ report sent  ${entries.length} position(s)`);
  } catch (error) {
    log.error(`BotService: ${error}`);
  }
}

async function main() {
  log.section('DexInfoBot startup');

  // Start bot webhook or polling
  botService.startBot().catch((e) => log.error(`Bot start error: ${e}`));

  // Restore persisted state from previous session
  const savedState = await loadState();
  if (savedState) {
    restoreState(savedState);
    restorePriceBuffer(savedState.priceBuffer ?? {});
    restoreOpenTimestamps(savedState.openTimestamps ?? {});
    if (savedState.sortBy) botService.setSortBy(savedState.sortBy);
    log.info('✅ state restored from previous session');
  }

  // Initial sync: 若 state 有 positions 且 wallet 配置未變，直接從 state 恢復，跳過 chain scan
  const savedWallets = savedState?.syncedWallets ?? [];
  const currentWallets = config.WALLET_ADDRESSES;
  const walletsUnchanged = savedWallets.length === currentWallets.length &&
      savedWallets.every(w => currentWallets.includes(w));
  const cachedPositions = savedState?.discoveredPositions ?? [];

  if (walletsUnchanged && cachedPositions.length > 0) {
      PositionScanner.restoreDiscoveredPositions(
          cachedPositions,
          savedWallets,
          savedState?.openTimestamps ?? {}
      );
  } else {
      await PositionScanner.syncFromChain();
  }

  // 啟動順序：PositionScanner 先跑（inline 呼叫 BBEngine 計算各池 BB），
  // 再跑 BBEngine 把結果寫入 latestBBs，讓 RiskManager 有資料可用。
  // （5 分鐘 cron 維持 BBEngine → PositionScanner 順序，避免重複 API 呼叫）
  await runPoolScanner();
  await runPositionScanner();
  await runBBEngine();
  await runRiskManager();

  isStartupComplete = true;
  await saveState(getPriceBufferSnapshot(), getOpenTimestampSnapshot(), botService.getSortBy(), PositionScanner.getDiscoveredSnapshot(), config.WALLET_ADDRESSES);
  await runBotService().catch((e) => log.error(`Startup report: ${e}`));
  log.info('startup complete — scheduler enabled');
  log.section('ready');

  cron.schedule('*/5 * * * *', async () => {
    log.section('5m cycle');
    await runPoolScanner().catch((e) => log.error(`Cron PoolScanner: ${e}`));
    await runBBEngine().catch((e) => log.error(`Cron BBEngine: ${e}`));
    await runPositionScanner().catch((e) => log.error(`Cron PositionScanner: ${e}`));
    await runRiskManager().catch((e) => log.error(`Cron RiskManager: ${e}`));
    await runBotService().catch((e) => log.error(`Cron BotService: ${e}`));
    await saveState(getPriceBufferSnapshot(), getOpenTimestampSnapshot(), botService.getSortBy(), PositionScanner.getDiscoveredSnapshot(), config.WALLET_ADDRESSES)
      .catch((e) => log.error(`State save: ${e}`));
    log.section('cycle end');
  });
}

main().catch((e) => log.error(`Main error: ${e}`));
