import cron from 'node-cron';
import { PoolScanner } from './services/PoolScanner';
import { BBEngine, getPriceBufferSnapshot, restorePriceBuffer, refreshPriceBuffer } from './services/BBEngine';
import { RiskManager, PositionState, RiskAnalysis } from './services/RiskManager';
import { RebalanceService } from './services/rebalance';
import { PnlCalculator } from './services/PnlCalculator';
import { TelegramBotService, minutesToCron, VALID_INTERVALS } from './bot/TelegramBot';
import { PositionScanner, getOpenTimestampSnapshot, restoreOpenTimestamps } from './services/PositionScanner';
import { PositionAggregator } from './services/PositionAggregator';
import { createServiceLogger } from './utils/logger';
import { fetchGasCostUSD } from './utils/rpcProvider';
import { fetchTokenPrices } from './utils/tokenPrices';
import { loadState, saveState, restoreState } from './utils/stateManager';
import { bandwidthTracker } from './utils/BandwidthTracker';
import { appState } from './utils/AppState';
import { config, validateEnv } from './config';
import { PoolStats, BBResult, PositionRecord } from './types';

const log = createServiceLogger('Main');
const botService = new TelegramBotService();

// ── 排程管理 ──────────────────────────────────────────────────────────────────
let currentIntervalMinutes = config.DEFAULT_INTERVAL_MINUTES;
let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

let isCycleRunning = false;

function buildCronJob() {
  return cron.schedule(minutesToCron(currentIntervalMinutes), async () => {
    if (isCycleRunning) {
      log.warn(`⚠️  上一個週期尚未完成，跳過本次觸發（排程重疊保護）`);
      return;
    }
    isCycleRunning = true;
    try {
      log.section(`${currentIntervalMinutes}m cycle`);
      await runTokenPriceFetcher().catch((e) => log.error(`Cron TokenPriceFetcher: ${e}`));
      await runPoolScanner().catch((e) => log.error(`Cron PoolScanner: ${e}`));
      await runBBEngine().catch((e) => log.error(`Cron BBEngine: ${e}`));
      await runPositionScanner().catch((e) => log.error(`Cron PositionScanner: ${e}`));
      await runRiskManager().catch((e) => log.error(`Cron RiskManager: ${e}`));
      await runBotService().catch((e) => log.error(`Cron BotService: ${e}`));
      const triggerStateSave = async () => saveState(
        getPriceBufferSnapshot(), getOpenTimestampSnapshot(), botService.getSortBy(),
        PositionScanner.getDiscoveredSnapshot(), config.WALLET_ADDRESSES,
        bandwidthTracker.snapshot(), currentIntervalMinutes,
        appState.bbKLowVol, appState.bbKHighVol,
        PositionScanner.getClosedSnapshot(),
      );
      await triggerStateSave().catch((e) => log.error(`State save: ${e}`));
      log.section('cycle end');
      PositionScanner.fillMissingTimestamps(triggerStateSave).catch((e) => log.error(`TimestampFiller: ${e}`));
    } finally {
      isCycleRunning = false;
    }
  });
}

function reschedule(minutes: number) {
  if (!VALID_INTERVALS.includes(minutes as typeof VALID_INTERVALS[number])) return;
  scheduledTask?.stop();
  currentIntervalMinutes = minutes;
  scheduledTask = buildCronJob();
  log.info(`🔄 排程已更新為每 ${minutes} 分鐘 (cron: ${minutesToCron(minutes)})`);
}

// 嚴重錯誤告警（每類每 30 分鐘至多一次，避免洗版）
const alertCooldowns = new Map<string, number>();
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
async function sendCriticalAlert(key: string, message: string) {
  const last = alertCooldowns.get(key) ?? 0;
  if (Date.now() - last < ALERT_COOLDOWN_MS) return;
  alertCooldowns.set(key, Date.now());
  await botService.sendAlert(`🚨 <b>DexBot 告警</b>\n${message}`).catch(() => { });
}

let activeTasks = 0;
let isStartupComplete = false;

// 0. Token Price Fetcher
async function runTokenPriceFetcher() {
  try {
    await fetchTokenPrices();
  } catch (e) {
    log.error(`TokenPriceFetcher: ${e}`);
  }
}

// 1. Pool Scanner
async function runPoolScanner() {
  activeTasks++;
  try {
    const pools = await PoolScanner.scanAllCorePools();
    if (pools.length === 0) {
      log.warn('no pools returned — subgraph or RPC error');
      await sendCriticalAlert('pool_scanner_empty', 'PoolScanner 無法取得任何池子資料，請確認 RPC / DexScreener 連線狀態。');
      return;
    }
    pools.sort((a, b) => b.apr - a.apr);
    appState.pools = pools;
    appState.lastUpdated.poolScanner = Date.now();
    const top = appState.pools[0];
    const topTvl = top.tvlUSD >= 1000 ? `$${(top.tvlUSD / 1000).toFixed(0)}K` : `$${top.tvlUSD.toFixed(0)}`;
    log.info(`✅ pools(${appState.pools.length})  top: ${top.dex} ${(top.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}% — APR ${(top.apr * 100).toFixed(1)}%  TVL ${topTvl}`);
  } catch (error) {
    log.error(`PoolScanner: ${error}`);
  } finally { activeTasks--; }
}

// 2. Position Scanner — fetchAll → aggregateAll → enrich PnL → updatePositions
async function runPositionScanner() {
  activeTasks++;
  try {
    const rawPositions = await PositionScanner.fetchAll();
    const assembled = await PositionAggregator.aggregateAll(rawPositions, appState.bbs, appState.pools);

    // PnL enrichment — computed here because assembler is scope-limited to USD values
    const gasCostUSD = await fetchGasCostUSD().catch(() => 1.5);
    for (const rec of assembled) {
      rec.initialCapital = PnlCalculator.getInitialCapital(rec.tokenId);
      const exactIL = PnlCalculator.calculateAbsolutePNL(rec.tokenId, rec.positionValueUSD, rec.unclaimedFeesUSD);
      rec.ilUSD = exactIL;
      const openInfo = PnlCalculator.calculateOpenInfo(rec.tokenId, rec.openTimestampMs, exactIL);
      if (openInfo) {
        rec.openedDays = openInfo.days;
        rec.openedHours = openInfo.hours;
        rec.profitRate = openInfo.profitRate;
      }
    }

    PositionScanner.updatePositions(assembled);

    const positions = PositionScanner.getTrackedPositions();
    appState.positions = positions.filter((p) => Number(p.liquidity) > 0);
    appState.lastUpdated.positionScanner = Date.now();
    log.info(`✅ positions  active ${appState.positions.length}/${positions.length} tracked`);

    appState.pruneStaleBBs();
  } catch (error) {
    log.error(`PositionScanner: ${error}`);
    await sendCriticalAlert('position_scanner_failed', `所有倉位掃描失敗，本週期資料未更新。\n錯誤: ${error}`);
  } finally { activeTasks--; }
}

// 3. BBEngine
async function runBBEngine() {
  activeTasks++;
  try {
    const poolsToProcess = new Map<string, PoolStats>();

    for (const pos of appState.positions) {
      const poolData = appState.pools.find(
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
      if (bb) appState.bbs[poolAddress] = bb;
    }
    appState.lastUpdated.bbEngine = Date.now();
    log.info(`✅ BB bands computed for ${poolsToProcess.size} pool(s)`);
  } catch (error) {
    log.error(`BBEngine: ${error}`);
  } finally { activeTasks--; }
}

// 4. RiskManager + Rebalance
async function runRiskManager() {
  activeTasks++;
  try {
    const gasCostUSD = await fetchGasCostUSD().catch(() => 1.5);
    for (const pos of appState.positions) {
      const poolData = appState.pools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      if (!poolData) continue;

      const bb = appState.bbs[poolData.id.toLowerCase()];
      if (!bb) continue;

      const poolKey = poolData.id.toLowerCase();
      const currentBandwidth = (bb.upperPrice - bb.lowerPrice) / bb.sma;
      const avg30DBandwidth = bandwidthTracker.update(poolKey, currentBandwidth);

      const positionState: PositionState = {
        capital: pos.initialCapital ?? pos.positionValueUSD,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        unclaimedFees: pos.unclaimedFeesUSD,
        cumulativeIL: pos.ilUSD ?? 0,
        feeRate24h: poolData.apr / 365,
      };

      const risk = RiskManager.analyzePosition(
        positionState, bb, poolData.dailyFeesUSD, avg30DBandwidth, currentBandwidth, gasCostUSD
      );

      pos.riskAnalysis = risk;
      pos.overlapPercent = risk.driftOverlapPct;
      pos.breakevenDays = risk.ilBreakevenDays;
      pos.healthScore = risk.healthScore;

      // Rebalance — computed after risk so breakevenDays is the correct analysed value
      const rb = RebalanceService.getRebalanceSuggestion(
        parseFloat(pos.currentPriceStr),
        bb,
        pos.unclaimedFeesUSD,
        pos.breakevenDays,
        pos.positionValueUSD,
        pos.token0Symbol,
        pos.token1Symbol,
        gasCostUSD,
        parseFloat(pos.bbMinPrice || '0'),
        parseFloat(pos.bbMaxPrice || '0'),
      );
      pos.rebalance = rb ?? undefined;
    }
    appState.lastUpdated.riskManager = Date.now();
    log.info(`✅ risk analysis updated for ${appState.positions.length} position(s)`);

    // Log snapshots here — after both BBEngine and RiskManager have enriched the positions,
    // so positions.log reflects correct Health Score, Drift %, and Breakeven values.
    const bbForLog = Object.values(appState.bbs)[0] ?? null;
    PositionScanner.logSnapshots(appState.positions, bbForLog, appState.bbKLowVol, appState.bbKHighVol);
  } catch (error) {
    log.error(`RiskManager: ${error}`);
  } finally { activeTasks--; }
}

// 5. Telegram Bot Reporting
async function runBotService() {
  if (!isStartupComplete) {
    log.info('[BotService] Skipped: Initial data sync not complete yet.');
    return;
  }

  while (activeTasks > 0) {
    log.info(`[BotService] Waiting for ${activeTasks} active services to complete...`);
    await new Promise(r => setTimeout(r, 1000));
  }

  try {
    if (appState.positions.length === 0) {
      log.info('BotService skipped: no active positions');
      return;
    }

    const entries: Array<{ position: PositionRecord; pool: PoolStats; bb: BBResult | null; risk: RiskAnalysis }> = [];
    for (const pos of appState.positions) {
      const poolData = appState.pools.find(
        (p) => p.id.toLowerCase() === pos.poolAddress.toLowerCase() && p.dex === pos.dex
      );
      const bb = appState.bbs[poolData?.id.toLowerCase() || ''];
      const risk = pos.riskAnalysis;

      if (!poolData || !risk) {
        log.warn(`Missing data for position ${pos.tokenId}, skipping.`);
        continue;
      }
      entries.push({ position: pos, pool: poolData, bb: bb || null, risk });
    }

    if (entries.length === 0) return;

    await botService.sendConsolidatedReport(entries, appState.pools, appState.lastUpdated);
    log.info(`✅ Telegram report sent  ${entries.length} position(s)`);
  } catch (error) {
    log.error(`BotService: ${error}`);
  }
}

async function main() {
  validateEnv();
  log.section('DexInfoBot startup');

  botService.setRescheduleCallback(reschedule);
  botService.setBbkCallback((kLow, kHigh) => {
    appState.bbKLowVol  = kLow;
    appState.bbKHighVol = kHigh;
    log.info(`📐 BB k values updated: low=${kLow}  high=${kHigh}`);
  });
  botService.startBot().catch((e) => log.error(`Bot start error: ${e}`));

  const savedState = await loadState();
  if (savedState) {
    restoreState(savedState);
    restorePriceBuffer(savedState.priceBuffer ?? {});
    restoreOpenTimestamps(savedState.openTimestamps ?? {});
    bandwidthTracker.restore(savedState.bandwidthWindows ?? {});
    if (savedState.sortBy) botService.setSortBy(savedState.sortBy);
    if (savedState.intervalMinutes) currentIntervalMinutes = savedState.intervalMinutes;
    if (savedState.bbKLowVol  !== undefined) appState.bbKLowVol  = savedState.bbKLowVol;
    if (savedState.bbKHighVol !== undefined) appState.bbKHighVol = savedState.bbKHighVol;
    PositionScanner.restoreClosedTokenIds(savedState.closedTokenIds ?? []);
    log.info('✅ state restored from previous session');
  }

  const savedWallets = savedState?.syncedWallets ?? [];
  const currentWallets = config.WALLET_ADDRESSES;
  const walletsUnchanged = savedWallets.length === currentWallets.length &&
    savedWallets.every(w => currentWallets.includes(w));
  const cachedPositions = savedState?.discoveredPositions ?? [];

  if (walletsUnchanged && cachedPositions.length > 0) {
    PositionScanner.restoreDiscoveredPositions(
      cachedPositions, savedWallets, savedState?.openTimestamps ?? {}
    );
  } else {
    await PositionScanner.syncFromChain(true);
  }

  await runTokenPriceFetcher();
  await runPoolScanner();

  if (savedState) {
    for (const pool of appState.pools) refreshPriceBuffer(pool.id, pool.tick);
    log.info(`✅ PriceBuffer refreshed for ${appState.pools.length} pool(s) after restore`);
  }

  await runPositionScanner();
  await runBBEngine();
  await runRiskManager();

  isStartupComplete = true;

  const triggerStateSave = async () => saveState(
    getPriceBufferSnapshot(), getOpenTimestampSnapshot(), botService.getSortBy(),
    PositionScanner.getDiscoveredSnapshot(), config.WALLET_ADDRESSES,
    bandwidthTracker.snapshot(), currentIntervalMinutes,
    appState.bbKLowVol, appState.bbKHighVol,
  );

  await triggerStateSave();
  // await runBotService().catch((e) => log.error(`Startup report: ${e}`));
  log.info(`startup complete — scheduler enabled (interval: ${currentIntervalMinutes}m)`);
  log.section('ready');

  scheduledTask = buildCronJob();

  // 開始搜尋遺失的時間戳記 (背景執行)
  PositionScanner.fillMissingTimestamps(triggerStateSave).catch((e) => log.error(`TimestampFiller: ${e}`));
}

let isShuttingDown = false;

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log.info(`${signal} received — saving state before exit`);
  try {
    await saveState(
      getPriceBufferSnapshot(), getOpenTimestampSnapshot(), botService.getSortBy(),
      PositionScanner.getDiscoveredSnapshot(), config.WALLET_ADDRESSES,
      bandwidthTracker.snapshot(), currentIntervalMinutes,
      appState.bbKLowVol, appState.bbKHighVol,
    );
    log.info('✅ state saved — exiting');
  } catch (e) {
    log.error(`graceful shutdown save failed: ${e}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main().catch((e) => log.error(`Main error: ${e}`));
