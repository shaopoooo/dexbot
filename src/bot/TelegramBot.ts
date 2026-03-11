import { Bot } from 'grammy';
import { config } from '../config';
import { PoolStats } from '../services/PoolScanner';
import { RiskAnalysis, RiskManager } from '../services/RiskManager';
import { BBResult } from '../services/BBEngine';
import { PositionRecord } from '../services/PositionScanner';
import { createServiceLogger } from '../utils/logger';
import { PnlCalculator } from '../services/PnlCalculator';

const log = createServiceLogger('TelegramBot');

/** 將極小數字格式化為緊湊表示法：小數點後 ≥2 個零時使用下標 */
function compactAmount(n: number): string {
    if (n <= 0) return '0';
    const s = n.toFixed(20);
    const dec = s.split('.')[1] || '';
    let zeros = 0;
    for (const c of dec) { if (c === '0') zeros++; else break; }
    if (zeros >= 2) {
        const sig = dec.slice(zeros, zeros + 4).replace(/0+$/, '');
        const sub = '₀₁₂₃₄₅₆₇₈₉';
        const subscript = String(zeros).split('').map(d => sub[+d]).join('');
        return `0.0${subscript}${sig}`;
    }
    return n.toFixed(zeros + 4).replace(/\.?0+$/, '');
}

type SortBy = 'size' | 'apr' | 'unclaimed' | 'health';

const SORT_LABELS: Record<SortBy, string> = {
    size: '倉位大小',
    apr: 'APR',
    unclaimed: 'Unclaimed',
    health: 'Health Score',
};

export class TelegramBotService {
    private bot: Bot;
    private chatId: string;
    private sortBy: SortBy = 'size';

    constructor() {
        this.bot = new Bot(config.BOT_TOKEN);
        this.chatId = config.CHAT_ID;

        this.bot.command('start', (ctx) => {
            ctx.reply('DexInfoBot started! Monitoring Base network DEX pools...');
        });

        this.bot.command('sort', (ctx) => {
            const key = (ctx.match?.trim() ?? '') as SortBy;
            const valid = Object.keys(SORT_LABELS) as SortBy[];
            if (valid.includes(key)) {
                this.sortBy = key;
                ctx.reply(`✅ 排序已設為: <b>${SORT_LABELS[key]}</b> ↓`, { parse_mode: 'HTML' });
            } else {
                ctx.reply(
                    `排序選項:\n` +
                    valid.map(k => `  /sort ${k} — ${SORT_LABELS[k]}`).join('\n') +
                    `\n\n目前排序: <b>${SORT_LABELS[this.sortBy]}</b>`,
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
    }

    public getSortBy(): string { return this.sortBy; }
    public setSortBy(key: string) {
        const valid = Object.keys(SORT_LABELS) as SortBy[];
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

    /** 格式化單一倉位區塊（供 sendConsolidatedReport 使用） */
    private formatPositionBlock(
        index: number,
        position: PositionRecord,
        pool: PoolStats,
        bb: BBResult | null,
        risk: RiskAnalysis
    ): string {
        const label = `${pool.dex} ${(pool.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
        const walletShort = position.ownerWallet && /^0x[0-9a-fA-F]{40}$/.test(position.ownerWallet)
            ? `${position.ownerWallet.slice(0, 6)}...${position.ownerWallet.slice(-4)}`
            : '未知';
        const posValue = position.positionValueUSD > 0
            ? `$${position.positionValueUSD.toFixed(0)}`
            : 'N/A';
        const initialCapital = PnlCalculator.getInitialCapital(position.tokenId);
        const capitalStr = initialCapital !== null ? `$${initialCapital.toFixed(0)}` : 'N/A';

        // 淨損益 = LP現值 + Unclaimed - 本金（含手續費貢獻）
        const pnlDisplay = position.ilUSD === null
            ? '未設定本金'
            : position.ilUSD >= 0
                ? `+$${position.ilUSD.toFixed(1)} 🟢`
                : `-$${Math.abs(position.ilUSD).toFixed(1)} 🔴`;

        // 無常損失 = LP現值 - 本金（純市價波動，不含手續費）
        const ilOnly = initialCapital !== null ? position.positionValueUSD - initialCapital : null;
        const ilOnlyDisplay = ilOnly === null
            ? ''
            : ilOnly >= 0
                ? `+$${ilOnly.toFixed(1)} 🟢`
                : `-$${Math.abs(ilOnly).toFixed(1)} 🔴`;

        const bbBound = (bb && position.bbMinPrice && position.bbMaxPrice)
            ? `${position.bbMinPrice} ~ ${position.bbMaxPrice}${position.bbFallback ? ' ⚠️' : ''}`
            : '無數據';
        const cmp = risk.compoundSignal ? '✅' : '❌';

        const openInfo = PnlCalculator.calculateOpenInfo(position.tokenId, position.openTimestampMs, position.ilUSD);
        const profitStr = (openInfo?.profitRate !== null && openInfo?.profitRate !== undefined)
            ? ` · 獲利 <b>${openInfo.profitRate >= 0 ? '+' : ''}${openInfo.profitRate.toFixed(2)}%</b>`
            : '';
        const breakevenStr = (position.ilUSD !== null && position.ilUSD >= 0) ? '盈利中' : `${risk.ilBreakevenDays}天`;

        // ── 標頭
        let block = `\n━━ #${index} ${label} ━━\n`;
        // ── 錢包（第二行）
        const lockIcon = position.isStaked ? ' 🔒' : '';
        block += `👛 ${walletShort} · #${position.tokenId}${lockIcon}\n`;
        // ── 開倉時間
        if (openInfo) block += `⏳ 開倉 ${openInfo.timeStr}\n`;
        // ── 價格 + 區間（縮排）
        block += `💹 當前 ${position.currentPriceStr} | ${position.regime}\n`;
        block += ` ├ 你的 ${position.minPrice} ~ ${position.maxPrice}\n`;
        block += ` └ 建議 ${bbBound}\n`;
        // ── 倉位摘要（縮排）
        block += `💼 倉位 ${posValue} | 本金 ${capitalStr} | 健康 ${risk.healthScore}/100\n`;
        // ── Breakeven + 獲利率同行
        block += `⌛  Breakeven ${breakevenStr}${profitStr}\n`;
        // ── 淨損益 + 無常損失
        block += `💸 淨損益 ${pnlDisplay}`;
        if (ilOnlyDisplay) block += ` | 無常損失 ${ilOnlyDisplay}`;
        block += '\n';
        // ── 建議領取：未領取手續費 + 逐幣明細
        const dec0 = position.token0Symbol === 'cbBTC' ? 8 : 18;
        const dec1 = position.token1Symbol === 'cbBTC' ? 8 : 18;
        const amt0 = Number(BigInt(position.unclaimed0 || '0')) / Math.pow(10, dec0);
        const amt1 = Number(BigInt(position.unclaimed1 || '0')) / Math.pow(10, dec1);
        const amt2 = Number(BigInt(position.unclaimed2 || '0')) / 1e18;
        const feeDetail = [
            amt0 > 0 ? `${compactAmount(amt0)} ${position.token0Symbol} ($${position.fees0USD.toFixed(2)})` : '',
            amt1 > 0 ? `${compactAmount(amt1)} ${position.token1Symbol} ($${position.fees1USD.toFixed(2)})` : '',
            amt2 > 0 && position.token2Symbol ? `${compactAmount(amt2)} ${position.token2Symbol} ($${position.fees2USD.toFixed(2)})` : '',
        ].filter(Boolean);
        block += `🔄 未領取手續費 $${position.unclaimedFeesUSD.toFixed(2)} ${cmp} ${risk.compoundSignal ? '&gt;' : '&lt;'} $${risk.compoundThreshold.toFixed(1)}\n`;
        for (const line of feeDetail) block += `     ${line}\n`;
        // ── 警示
        if (risk.redAlert) block += `🚨 <b>RED_ALERT</b>: Breakeven &gt;${RiskManager.RED_ALERT_BREAKEVEN_DAYS}天 (建議減倉)\n`;
        if (risk.highVolatilityAvoid) block += `⚠️ <b>HIGH_VOLATILITY_AVOID</b> (建議觀望)\n`;
        if (risk.driftWarning) {
            block += `⚠️ <b>DRIFT</b> 重疊 ${risk.driftOverlapPct.toFixed(1)}%`;
            if (position.rebalance) {
                const rb = position.rebalance;
                block += ` | 💡 ${rb.strategyName}`;
                if (rb.estGasCost > 0) block += ` (Gas $${rb.estGasCost.toFixed(2)})`;
            } else {
                block += ` (建議依 BB 重建倉)`;
            }
            block += '\n';
        }

        return block;
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
        const timeStr = timeFormatter.format(new Date()).replace(/\//g, '-').replace(',', '');
        const formatTs = (ts: number) => ts === 0 ? '無紀錄' : timeFormatter.format(new Date(ts)).replace(/\//g, '-').replace(',', '').split(' ')[1];

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
        const summary = PnlCalculator.calculatePortfolioSummary(entries.map(e => e.position));
        const fmtUSD = (v: number) => v >= 0 ? `+$${v.toFixed(1)}` : `-$${Math.abs(v).toFixed(1)}`;

        let msg = `<b>[${timeStr}] 倉位監控報告 (${sorted.length} 個倉位 | 排序: ${SORT_LABELS[this.sortBy]} ↓)</b>`;
        msg += `\n\n📊 <b>總覽</b>  ${summary.positionCount} 倉位 · ${summary.walletCount} 錢包`;
        msg += `\n💼 總倉位 <b>$${summary.totalPositionUSD.toFixed(0)}</b>  |  本金 <b>$${summary.totalInitialCapital.toFixed(0)}</b>  |  Unclaimed <b>$${summary.totalUnclaimedUSD.toFixed(1)}</b>`;

        // 即時幣價
        const bb0 = entries.find(e => e.bb)?.bb;
        if (bb0) {
            const p = (v: number, d: number) => v > 0 ? `$${v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}` : '–';
            msg += `\n💱 ETH ${p(bb0.ethPrice, 0)}  BTC ${p(bb0.cbbtcPrice, 0)}  CAKE ${p(bb0.cakePrice, 3)}  AERO ${p(bb0.aeroPrice, 3)}`;
        }

        if (summary.totalPnL !== null) {
            const icon = summary.totalPnL >= 0 ? '🟢' : '🔴';
            const pctStr = summary.totalPnLPct !== null
                ? ` (${summary.totalPnLPct >= 0 ? '+' : ''}${summary.totalPnLPct.toFixed(2)}%)`
                : '';
            msg += `\n💰 總獲利 <b>${fmtUSD(summary.totalPnL)}${pctStr}</b> ${icon}`;
        }

        sorted.forEach(({ position, pool, bb, risk }, i) => {
            msg += this.formatPositionBlock(i + 1, position, pool, bb, risk);
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
