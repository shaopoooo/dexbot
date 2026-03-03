import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats } from '../services/PoolScanner';
import { RiskAnalysis, RiskManager } from '../services/RiskManager';
import { BBResult } from '../services/BBEngine';
import { PositionRecord } from '../services/PositionScanner';
import { createServiceLogger } from '../utils/logger';

const log = createServiceLogger('TelegramBot');

export class TelegramBotService {
    private bot: Bot;
    private chatId: string;

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        this.bot.command('start', (ctx) => {
            ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
        });
    }

    public async startBot() {
        log.info('Starting Telegram Bot...');
        await this.bot.start({
            onStart: () => {
                log.info('Telegram Bot is running.');
            },
        });
    }

    public async sendAlert(message: string) {
        if (!this.chatId) {
            log.warn('CHAT_ID not set. Cannot send telegram alert.');
            log.warn(`Message: ${message}`);
            return;
        }
        try {
            await this.bot.api.sendMessage(this.chatId, message, { parse_mode: 'HTML' });
        } catch (error) {
            log.error(`Failed to send telegram message: ${error}`);
        }
    }

    /**
     * Format message according to Phase 7 format.
     * Example:
     * > **[2026-03-02 17:05] 最高 APR 池: Pancake 0.01% (APR 67.2%)**
     * > **建議 BB 區間**: 0.0298 – 0.0312 cbBTC/WETH
     * > **Unclaimed**: $12.4 | **IL**: -$8.7 | **Breakeven**: 14 天
     * > **Compound Signal**: ✅ Unclaimed $12.4 > Threshold $7.1
     * > **Health Score**: 94/100 | **Regime**: Low Vol
     */
    public async sendFormattedReport(
        position: PositionRecord,
        pool: PoolStats,
        bb: BBResult | null,
        risk: RiskAnalysis,
        highestPool: PoolStats,
        lastUpdates: { poolScanner: number; positionScanner: number; bbEngine: number; riskManager: number }
    ) {
        const timeFormatter = new Intl.DateTimeFormat('zh-TW', {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
            timeZone: 'Asia/Taipei', // Local time
        });

        // YYYY-MM-DD HH:mm format
        const timeStr = timeFormatter.format(new Date()).replace(/\//g, '-').replace(',', '');
        const aprStr = (pool.apr * 100).toFixed(1);

        const bbBoundStr = (bb && position.bbMinPrice && position.bbMaxPrice)
            ? `<b>建議 BB 區間</b>: ${position.bbMinPrice} - ${position.bbMaxPrice}`
            : '<b>建議 BB 區間</b>: 計算失敗或無足夠數據';

        const compoundCheck = risk.compoundSignal ? '✅' : '❌';
        const regime = position.regime;

        let msg = `<b>[${timeStr}] 監控池: ${pool.dex} ${(pool.feeTier * 100).toFixed(2)}% (APR ${aprStr}%)</b>\n`;
        msg += `<b>當前價格</b>: ${position.currentPriceStr} | <b>你的區間</b>: ${position.minPrice} - ${position.maxPrice}\n`;
        msg += `${bbBoundStr}\n`;
        if (position.bbFallback) {
            msg += `⚠️ <b>BBEngine 暫時受限</b> (API 限流), 改用預設區間。\n`;
        }

        const ilDisplay = position.ilUSD !== 0
            ? (position.ilUSD > 0 ? `+$${position.ilUSD.toFixed(1)} 🟢` : `-$${Math.abs(position.ilUSD).toFixed(1)} 🔴`)
            : '未設定歷史本金';

        msg += `<b>Unclaimed</b>: $${position.unclaimedFeesUSD.toFixed(1)} | <b>IL (PNL)</b>: ${ilDisplay} | <b>Breakeven</b>: ${risk.ilBreakevenDays} 天\n`;
        msg += `<b>Compound Signal</b>: ${compoundCheck} Unclaimed $${position.unclaimedFeesUSD.toFixed(1)} ${risk.compoundSignal ? '&gt;' : '&lt;'} Threshold $${risk.compoundThreshold.toFixed(1)}\n`;
        msg += `<b>Health Score</b>: ${risk.healthScore}/100 | <b>Regime</b>: ${regime}\n`;

        // Alerts
        if (risk.redAlert) {
            msg += `\n🚨 <b>RED_ALERT</b>: IL Breakeven &gt; ${RiskManager.RED_ALERT_BREAKEVEN_DAYS} Days! (建議減倉)`;
        }
        if (risk.highVolatilityAvoid) {
            msg += `\n⚠️ <b>HIGH_VOLATILITY_AVOID</b>: Bandwidth &gt; ${RiskManager.HIGH_VOLATILITY_FACTOR}x 30D Avg! (建議觀望)`;
        }
        if (risk.driftWarning) {
            msg += `\n⚠️ <b>STRATEGY_DRIFT_WARNING</b>: 區間重疊度 &lt; ${RiskManager.DRIFT_WARNING_PCT}% (${risk.driftOverlapPct.toFixed(1)}%)`;
            if (position.rebalance) {
                const rb = position.rebalance;
                msg += `\n   <b>💡 重建倉策略</b>: ${rb.strategyName}\n   📝 <i>${rb.notes}</i>`;
                if (rb.estGasCost > 0) msg += `\n   ⛽️ 預估 Gas: $${rb.estGasCost.toFixed(2)}`;
            } else {
                msg += ` (建議撤資並依建議BB區間重新建倉)`;
            }
        }

        // Add suggestion about the highest APR pool
        if (highestPool.id.toLowerCase() !== pool.id.toLowerCase()) {
            msg += `\n\n💡 <i>市場發現更高收益率池: ${highestPool.dex} ${(highestPool.feeTier * 100).toFixed(2)}% (APR ${(highestPool.apr * 100).toFixed(1)}%)</i>`;
        }

        const formatTs = (ts: number) => ts === 0 ? '無紀錄' : timeFormatter.format(new Date(ts)).replace(/\//g, '-').replace(',', '').split(' ')[1];
        msg += `\n\n⏱ <b>資料更新時間 &amp; 來源:</b>`;
        msg += `\n- Pool: ${formatTs(lastUpdates.poolScanner)} <i>(vol: ${pool.volSource})</i>`;
        msg += `\n- Position: ${formatTs(lastUpdates.positionScanner)} <i>(${position.volSource} | price: ${position.priceSource})</i>`;
        msg += `\n- BB Engine: ${formatTs(lastUpdates.bbEngine)}`;
        msg += `\n- Risk Manager: ${formatTs(lastUpdates.riskManager)}`;

        await this.sendAlert(msg);
    }
}
