import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats, BBResult, PositionRecord, RiskAnalysis, SortBy } from '../types';
import { createServiceLogger } from '../utils/logger';
import { getTokenPrices } from '../utils/tokenPrices';
import { buildTelegramPositionBlock, fmtInterval } from '../utils/formatter';

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

    setRescheduleCallback(cb: (minutes: number) => void) {
        this.onReschedule = cb;
    }

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        this.bot.command('start', (ctx) => {
            ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
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
                `<b>健康分數</b> (0–100)\n` +
                `= 50 + (Unclaimed + IL) / 本金 × 1000\n` +
                `50 = 損益兩平，100 = 盈利 ≥5%\n\n` +
                `<b>淨損益（PnL）</b>\n` +
                `= LP現值 + Unclaimed - 初始本金\n` +
                `正值 🟢 = 盈利，負值 🔴 = 虧損\n` +
                `（已領取再投入的費用已含於LP現值，不重複計算）\n\n` +
                `<b>無常損失（IL）</b>\n` +
                `= LP現值 - 初始本金\n` +
                `純市價波動造成的 LP 倉位變化，不含手續費\n\n` +
                `<b>Breakeven 天數</b>\n` +
                `= |IL| / 每日手續費收入\n` +
                `代表需幾天費用彌補目前 IL\n\n` +
                `<b>Compound Threshold</b>\n` +
                `= √(2 × 本金 × Gas費 × 24h費率)\n` +
                `Unclaimed > Threshold → 建議複利\n\n` +
                `<b>淨 APR</b>\n` +
                `= 池子費用APR + IL年化率\n` +
                `IL年化率 = IL / 本金 / 持倉天數 × 365\n` +
                `需設定建倉本金才會顯示\n\n` +
                `<b>DRIFT 警告</b>\n` +
                `重疊度 = 倉位落在 BB 內的比例\n` +
                `&lt; 80% 時觸發，建議重建倉`;
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

        // 更新時間（顯示一次）
        msg += `\n\n⌛ <b>資料更新時間:</b>`;
        msg += `\n- Pool: ${formatTs(lastUpdates.poolScanner)} | Position: ${formatTs(lastUpdates.positionScanner)}`;
        msg += `\n- BB Engine: ${formatTs(lastUpdates.bbEngine)} | Risk: ${formatTs(lastUpdates.riskManager)}`;

        await this.sendAlert(msg);
    }
}
