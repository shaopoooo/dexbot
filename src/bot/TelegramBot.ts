import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats, BBResult, PositionRecord, RiskAnalysis, SortBy } from '../types';
import { createServiceLogger } from '../utils/logger';
import { getTokenPrices } from '../utils/tokenPrices';
import { buildTelegramPositionBlock, fmtInterval } from '../utils/formatter';
import { appState } from '../utils/AppState';

const log = createServiceLogger('TelegramBot');

/** 允許的排程間隔（分鐘）：10 的倍數且能整除 1440，起始對齊每日 00:00 */
export const VALID_INTERVALS = [10, 20, 30, 60, 120, 180, 240, 360, 480, 720, 1440] as const;
export type IntervalMinutes = typeof VALID_INTERVALS[number];

export function minutesToCron(min: number): string {
    if (min < 60)   return `*/${min} * * * *`;
    if (min === 1440) return `0 0 * * *`;
    return `0 */${min / 60} * * *`;
}

export class TelegramBotService {
    private bot: Bot;
    private chatId: string;
    private sortBy: SortBy = 'size';
    private onReschedule: ((minutes: number) => void) | null = null;
    private onBbkChange: ((kLow: number, kHigh: number) => void) | null = null;

    setRescheduleCallback(cb: (minutes: number) => void) {
        this.onReschedule = cb;
    }

    setBbkCallback(cb: (kLow: number, kHigh: number) => void) {
        this.onBbkChange = cb;
    }

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        this.bot.command('start', (ctx) => {
            ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
        });

        this.bot.command('help', (ctx) => {
            const msg =
                `📋 <b>DexInfoBot 指令說明</b>\n\n` +
                `<b>📊 報告與排序</b>\n` +
                `/sort &lt;key&gt; — 設定倉位排序方式\n` +
                `  · <code>size</code>　倉位大小（預設）\n` +
                `  · <code>apr</code>　　池子 APR\n` +
                `  · <code>unclaimed</code> 未領取手續費\n` +
                `  · <code>health</code>　健康分數\n\n` +
                `<b>⏱ 排程</b>\n` +
                `/interval &lt;分鐘&gt; — 設定自動報告間隔\n` +
                `  可用值: ${VALID_INTERVALS.map(m => fmtInterval(m)).join('、')}\n` +
                `  範例: <code>/interval 30</code>\n\n` +
                `<b>📐 BB 布林通道</b>\n` +
                `/bbk — 查看目前 k 值設定\n` +
                `/bbk &lt;low&gt; &lt;high&gt; — 調整 BB 帶寬乘數\n` +
                `  · low：震盪市（Low Vol）用\n` +
                `  · high：趨勢市（High Vol）用\n` +
                `  建議範圍 1.0 ~ 3.0，預設 ${config.BB_K_LOW_VOL}/${config.BB_K_HIGH_VOL}\n` +
                `  範例: <code>/bbk 1.8 2.5</code>\n\n` +
                `<b>📖 說明</b>\n` +
                `/explain — 各項指標計算公式詳解\n` +
                `/help — 顯示本說明`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        });

        this.bot.command('sort', (ctx) => {
            const key = (ctx.match?.trim() ?? '') as SortBy;
            const valid = Object.keys(config.SORT_LABELS) as SortBy[];
            if (valid.includes(key)) {
                this.sortBy = key;
                ctx.reply(`✅ 排序已設為: <b>${config.SORT_LABELS[key]}</b> ↓`, { parse_mode: 'HTML' });
            } else {
                ctx.reply(
                    `排序選項:\n` +
                    valid.map(k => `  /sort ${k} — ${config.SORT_LABELS[k]}`).join('\n') +
                    `\n\n目前排序: <b>${config.SORT_LABELS[this.sortBy]}</b>`,
                    { parse_mode: 'HTML' }
                );
            }
        });

        this.bot.command('explain', (ctx) => {
            const msg =
                `📖 <b>指標計算說明</b>\n\n` +
                `<b>淨損益（PnL）</b>\n` +
                `= LP現值 + Unclaimed - 初始本金\n` +
                `正值 🟢 = 盈利，負值 🔴 = 虧損\n\n` +
                `<b>無常損失（IL）</b>\n` +
                `= LP現值 - 初始本金\n` +
                `純市價波動造成的倉位縮水，不含手續費收益\n\n` +
                `<b>健康分數</b> (0–100)\n` +
                `= 50 + (Unclaimed + IL) / 本金 × 1000\n` +
                `50 = 損益兩平；&gt;50 盈利；&lt;50 虧損\n` +
                `100 = 報酬率達 +5% 以上\n\n` +
                `<b>Breakeven 天數</b>\n` +
                `= |IL| / 每日手續費收入\n` +
                `需幾天費用收益才能彌補目前 IL\n` +
                `IL ≥ 0 時顯示「盈利中」\n\n` +
                `<b>Compound Threshold (EOQ)</b>\n` +
                `= √(2 × 本金 × Gas費 × 24h費率)\n` +
                `Unclaimed ✅ &gt; Threshold → 建議複利再投入\n` +
                `Unclaimed ❌ &lt; Threshold → 繼續等待累積\n\n` +
                `<b>獲利率</b>\n` +
                `= (LP現值 + Unclaimed - 本金) / 本金 × 100%\n` +
                `需設定初始本金（INITIAL_INVESTMENT_&lt;tokenId&gt;）才顯示\n\n` +
                `<b>布林通道 BB（Bollinger Bands）</b>\n` +
                `SMA = 最近 20 筆小時 tick 均價\n` +
                `帶寬 = k × σ（stdDev，EWMA 平滑）\n` +
                `震盪市（Low Vol）: k_low；趨勢市（High Vol）: k_high\n` +
                `用 /bbk 調整，目前 k=${appState.bbKLowVol}/${appState.bbKHighVol}\n\n` +
                `<b>DRIFT 警告</b>\n` +
                `重疊度 = 你的倉位區間落在 BB 內的比例\n` +
                `&lt; ${config.DRIFT_WARNING_PCT}% 時觸發，建議依 BB 重建倉\n\n` +
                `<b>再平衡策略</b>\n` +
                `等待回歸 — 偏離小，無需行動\n` +
                `DCA 定投 — 偏離中，用手續費補倉\n` +
                `撤資單邊建倉 — 偏離大，單幣掛單等回歸`;
            ctx.reply(msg, { parse_mode: 'HTML' });
        });

        this.bot.command('interval', (ctx) => {
            const raw = ctx.match?.trim() ?? '';
            if (!raw) {
                const opts = VALID_INTERVALS.map(m => `  /interval ${m} — ${fmtInterval(m)}`).join('\n');
                ctx.reply(`⏱ 排程間隔設定\n\n可用選項:\n${opts}`, { parse_mode: 'HTML' });
                return;
            }
            const min = parseInt(raw, 10);
            if (!VALID_INTERVALS.includes(min as IntervalMinutes)) {
                const opts = VALID_INTERVALS.map(m => `${fmtInterval(m)}`).join('、');
                ctx.reply(`❌ 無效間隔。可用值: ${opts}`);
                return;
            }
            if (this.onReschedule) {
                this.onReschedule(min);
                ctx.reply(`✅ 排程已更新為每 <b>${fmtInterval(min)}</b> 執行一次\n（cron: <code>${minutesToCron(min)}</code>）`, { parse_mode: 'HTML' });
            } else {
                ctx.reply('❌ 排程功能尚未初始化');
            }
        });

        this.bot.command('bbk', (ctx) => {
            const parts = (ctx.match?.trim() ?? '').split(/\s+/).filter(Boolean);
            if (parts.length === 0) {
                const { bbKLowVol, bbKHighVol } = appState;
                ctx.reply(
                    `📐 <b>BB k 值設定</b>\n\n` +
                    `目前: k_low=<b>${bbKLowVol}</b>  k_high=<b>${bbKHighVol}</b>\n\n` +
                    `用法: <code>/bbk &lt;low&gt; &lt;high&gt;</code>\n` +
                    `範例: <code>/bbk 1.8 2.5</code>\n\n` +
                    `震盪市 (Low Vol) 用 k_low，趨勢市 (High Vol) 用 k_high。\n` +
                    `建議範圍：1.0 ~ 3.0`,
                    { parse_mode: 'HTML' }
                );
                return;
            }
            if (parts.length !== 2) {
                ctx.reply('❌ 格式錯誤。用法: <code>/bbk &lt;low&gt; &lt;high&gt;</code>', { parse_mode: 'HTML' });
                return;
            }
            const kLow  = parseFloat(parts[0]);
            const kHigh = parseFloat(parts[1]);
            if (isNaN(kLow) || isNaN(kHigh) || kLow <= 0 || kHigh <= 0 || kLow > kHigh) {
                ctx.reply('❌ 數值無效。low 與 high 需為正數且 low ≤ high');
                return;
            }
            if (this.onBbkChange) {
                this.onBbkChange(kLow, kHigh);
                ctx.reply(
                    `✅ BB k 值已更新\nk_low=<b>${kLow}</b>  k_high=<b>${kHigh}</b>\n（下個週期生效）`,
                    { parse_mode: 'HTML' }
                );
            } else {
                ctx.reply('❌ BBk 功能尚未初始化');
            }
        });
    }

    public getSortBy(): string { return this.sortBy; }
    public setSortBy(key: string) {
        const valid = Object.keys(config.SORT_LABELS) as SortBy[];
        if (valid.includes(key as SortBy)) this.sortBy = key as SortBy;
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

    /** 將所有倉位合併為單一 Telegram 報告 */
    public async sendConsolidatedReport(
        entries: Array<{ position: PositionRecord; pool: PoolStats; bb: BBResult | null; risk: RiskAnalysis }>,
        allPools: PoolStats[],
        lastUpdates: { poolScanner: number; positionScanner: number; bbEngine: number; riskManager: number }
    ) {
        const timeFormatter = new Intl.DateTimeFormat('zh-TW', {
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', hour12: false,
            timeZone: 'Asia/Taipei',
        });
        const timeOnlyFormatter = new Intl.DateTimeFormat('zh-TW', {
            hour: '2-digit', minute: '2-digit', hour12: false,
            timeZone: 'Asia/Taipei',
        });
        const timeStr = timeFormatter.format(new Date()).replace(/\//g, '-').replace(',', '');
        // 使用獨立的 time-only formatter 避免 zh-TW locale 在新版 ICU 使用 U+202F
        // 而非一般空格導致 split(' ') 回傳 undefined
        const formatTs = (ts: number) => ts === 0 ? '無紀錄' : timeOnlyFormatter.format(new Date(ts));

        // 依當前排序鍵由大到小排列
        const sorted = [...entries].sort((a, b) => {
            switch (this.sortBy) {
                case 'apr': return b.pool.apr - a.pool.apr;
                case 'unclaimed': return b.position.unclaimedFeesUSD - a.position.unclaimedFeesUSD;
                case 'health': return b.risk.healthScore - a.risk.healthScore;
                case 'size':
                default: return b.position.positionValueUSD - a.position.positionValueUSD;
            }
        });

        // ── 總覽區塊 ──────────────────────────────────────────────
        const totalPositionUSD    = entries.reduce((s, e) => s + e.position.positionValueUSD, 0);
        const totalUnclaimedUSD   = entries.reduce((s, e) => s + e.position.unclaimedFeesUSD, 0);
        const totalInitialCapital = entries.reduce((s, e) => s + (e.position.initialCapital ?? 0), 0);
        const pnlValues           = entries.map(e => e.position.ilUSD);
        const totalPnL            = pnlValues.every(v => v !== null)
            ? pnlValues.reduce((s, v) => s + (v ?? 0), 0) : null;
        const totalPnLPct         = (totalPnL !== null && totalInitialCapital > 0)
            ? (totalPnL / totalInitialCapital) * 100 : null;
        const walletCount         = new Set(
            entries.map(e => e.position.ownerWallet).filter(w => /^0x[0-9a-fA-F]{40}$/.test(w))
        ).size;
        const fmtUSD = (v: number) => v >= 0 ? `+$${v.toFixed(1)}` : `-$${Math.abs(v).toFixed(1)}`;

        let msg = `<b>[${timeStr}] 倉位監控報告 (${sorted.length} 個倉位 | 排序: ${config.SORT_LABELS[this.sortBy]} ↓)</b>`;
        msg += `\n\n📊 <b>總覽</b>  ${entries.length} 倉位 · ${walletCount} 錢包`;
        msg += `\n💼 總倉位 <b>$${totalPositionUSD.toFixed(0)}</b>  |  本金 <b>$${totalInitialCapital.toFixed(0)}</b>  |  Unclaimed <b>$${totalUnclaimedUSD.toFixed(1)}</b>`;

        // 即時幣價（由獨立 tokenPrices 模組提供，不依賴 BBEngine 是否成功）
        const tp = getTokenPrices();
        const p = (v: number, d: number) => v > 0 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '–';
        msg += `\n💱 ETH ${p(tp.ethPrice, 0)}  BTC ${p(tp.cbbtcPrice, 0)}  CAKE ${p(tp.cakePrice, 3)}  AERO ${p(tp.aeroPrice, 3)}`;

        if (totalPnL !== null) {
            const icon = totalPnL >= 0 ? '🟢' : '🔴';
            const pctStr = totalPnLPct !== null
                ? ` (${totalPnLPct >= 0 ? '+' : ''}${totalPnLPct.toFixed(2)}%)`
                : '';
            msg += `\n💰 總獲利 <b>${fmtUSD(totalPnL)}${pctStr}</b> ${icon}`;
        }

        sorted.forEach(({ position, pool, bb, risk }, i) => {
            msg += buildTelegramPositionBlock(i + 1, position, pool, bb, risk);
        });

        // 各池收益排行（顯示一次）
        if (allPools.length > 0) {
            const medals = ['🥇', '🥈', '🥉'];
            const activePoolIds = new Set(entries.map(e => e.position.poolAddress.toLowerCase()));
            msg += `\n📊 <b>各池收益排行:</b>`;
            allPools.forEach((p, i) => {
                const rank = medals[i] ?? '　';
                const label = `${p.dex} ${(p.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
                const aprPct = (p.apr * 100).toFixed(1);
                const tvl = p.tvlUSD >= 1000 ? `$${(p.tvlUSD / 1000).toFixed(0)}K` : `$${p.tvlUSD.toFixed(0)}`;
                const tag = activePoolIds.has(p.id.toLowerCase()) ? ' ◀ 你的倉位' : '';
                msg += `\n${rank} ${label} — APR <b>${aprPct}%</b> | TVL ${tvl}${tag}`;
            });
        }

        // BB k 值與更新時間
        msg += `\n\n⌛ <b>資料更新時間:</b>`;
        msg += `\n- Pool: ${formatTs(lastUpdates.poolScanner)} | Position: ${formatTs(lastUpdates.positionScanner)}`;
        msg += `\n- BB Engine: ${formatTs(lastUpdates.bbEngine)} | Risk: ${formatTs(lastUpdates.riskManager)}`;
        msg += `\n📐 BB k: low=<b>${appState.bbKLowVol}</b>  high=<b>${appState.bbKHighVol}</b>`;

        await this.sendAlert(msg);
    }
}
