import { PositionRecord, PoolStats, BBResult, RiskAnalysis } from '../types';
import { config } from '../config';

export function fmtInterval(min: number): string {
    if (min < 60)   return `${min} 分鐘`;
    if (min === 60) return `1 小時`;
    if (min < 1440) return `${min / 60} 小時`;
    return `1 天`;
}

/** 將極小數字格式化為緊湊表示法：小數點後 ≥2 個零時使用下標 */
export function compactAmount(n: number): string {
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

/** 格式化代幣數量為日誌格式 */
export function formatTokenCompactLog(unclaimed: string | undefined, decimals: number, symbol: string, usdValue: number): string | null {
    if (!unclaimed || unclaimed === '0') return null;
    try {
        const num = Number(BigInt(unclaimed)) / Math.pow(10, decimals);
        if (num <= 0) return null;
        const display = compactAmount(num);
        return `${display} ${symbol} ($${usdValue.toFixed(2)})`;
    } catch {
        return null;
    }
}

/** 英文市場狀態顯示 */
export function regimeEn(regime: string): string {
    if (regime === 'Low Volatility') return 'Low Vol';
    if (regime === 'High Volatility') return 'High Vol';
    if (regime === '資料累積中') return 'Warmup';
    return regime;
}

/** 格式化單一倉位區塊（供 sendConsolidatedReport 使用） */
export function buildTelegramPositionBlock(
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
    const initialCapital = position.initialCapital ?? null;
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

    const timeStr = (position.openedDays !== undefined && position.openedHours !== undefined)
        ? `${position.openedDays}天${position.openedHours}小時`
        : null;
    const profitStr = (position.profitRate !== null && position.profitRate !== undefined)
        ? ` · 獲利 <b>${position.profitRate >= 0 ? '+' : ''}${position.profitRate.toFixed(2)}%</b>`
        : '';
    const breakevenStr = (position.ilUSD !== null && position.ilUSD >= 0) ? '盈利中' : `${risk.ilBreakevenDays}天`;

    // ── 標頭
    let block = `\n━━ #${index} ${label} ━━\n`;
    // ── 錢包（第二行）
    const lockIcon = position.isStaked ? ' 🔒' : '';
    block += `👛 ${walletShort} · #${position.tokenId}${lockIcon}\n`;
    // ── 開倉時間
    if (timeStr) block += `⏳ 開倉 ${timeStr}\n`;
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
    if (risk.redAlert) block += `🚨 <b>RED_ALERT</b>: Breakeven &gt;30天 (建議減倉)\n`;
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

function toCST(d: Date): { date: string; hh: string; mm: string } {
    const cst = new Date(d.getTime() + 8 * 3600_000);
    return {
        date: cst.toISOString().slice(0, 10),
        hh:   String(cst.getUTCHours()).padStart(2, '0'),
        mm:   String(cst.getUTCMinutes()).padStart(2, '0'),
    };
}

/** Build the snapshot header line (with optional price row) for positions.log. */
export function buildLogSnapshotHeader(bb?: BBResult | null, kLow?: number, kHigh?: number): string {
    const now = new Date();
    const { date, hh, mm } = toCST(now);
    const timestamp = `${date} ${hh}:${mm} UTC+8`;
    const header = `═══ [${timestamp}] Snapshot ═══`;
    if (!bb) return header;
    const prices = `  ETH $${bb.ethPrice.toFixed(0)}  BTC $${bb.cbbtcPrice.toFixed(0)}  CAKE $${bb.cakePrice.toFixed(3)}  AERO $${bb.aeroPrice.toFixed(3)}`;
    const kStr = (kLow !== undefined && kHigh !== undefined) ? `  k=${kLow}/${kHigh}` : '';
    return header + '\n' + prices + kStr;
}

/** Format a single position as a plain-text block for positions.log. */
export function buildLogPositionBlock(pos: PositionRecord, tokenDecimals: Record<string, number>, bb?: BBResult | null): string {
    const now = new Date();
    const { hh, mm } = toCST(now);
    const timeStr = `${hh}:${mm}`;
    const label = `${pos.dex} ${(pos.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
    const walletShort = pos.ownerWallet
        ? `${pos.ownerWallet.slice(0, 6)}...${pos.ownerWallet.slice(-4)}`
        : 'unknown';

    const openedStr = pos.openedDays !== undefined
        ? (pos.openedDays > 0 ? `${pos.openedDays}d ${pos.openedHours}h` : `${pos.openedHours}h`)
        : 'unknown';

    const posValue = pos.positionValueUSD > 0 ? `$${pos.positionValueUSD.toFixed(0)}` : 'N/A';
    const capStr   = pos.initialCapital !== null && pos.initialCapital !== undefined
        ? `$${pos.initialCapital.toFixed(0)}` : 'N/A';
    const aprStr   = pos.apr !== undefined ? `${(pos.apr * 100).toFixed(1)}%` : 'N/A';

    const pnlSign  = pos.ilUSD === null ? '' : pos.ilUSD >= 0 ? '+' : '-';
    const pnlAbs   = pos.ilUSD === null ? 'N/A' : `$${Math.abs(pos.ilUSD).toFixed(1)}`;
    const pnlTag   = pos.ilUSD === null ? '' : pos.ilUSD >= 0 ? '[+]' : '[-]';
    const pnlStr   = pos.ilUSD === null ? 'N/A (no capital set)' : `${pnlSign}${pnlAbs} ${pnlTag}`;

    const bbBound = (pos.bbMinPrice && pos.bbMaxPrice)
        ? `${pos.bbMinPrice} ~ ${pos.bbMaxPrice}${pos.bbFallback ? ' [fallback]' : ''}`
        : 'N/A';

    const profitStr = (pos.profitRate !== null && pos.profitRate !== undefined)
        ? ` | Profit: ${pos.profitRate >= 0 ? '+' : ''}${pos.profitRate.toFixed(2)}%`
        : '';
    const breakevenStr = (pos.ilUSD !== null && pos.ilUSD >= 0) ? 'Profitable' : `${pos.breakevenDays}d`;
    const compoundStr  = pos.unclaimedFeesUSD >= config.EOQ_THRESHOLD ? 'YES' : 'no';

    const REBALANCE_STRATEGY: Record<string, string> = {
        wait:              'Wait (expect reversion)',
        dca:               'DCA buy-in',
        withdrawSingleSide:'Withdraw & single-side LP',
        avoidSwap:         'Avoid direct swap',
    };

    const lines: string[] = [];
    lines.push(`[${timeStr}] ━━ #${pos.tokenId} ${label} ━━`);
    lines.push(`  Value: ${posValue} | Capital: ${capStr} | APR: ${aprStr} | Health: ${pos.healthScore}/100`);
    lines.push(`  Wallet:    ${walletShort}  (${openedStr})`);
    lines.push(`  Price:     ${pos.currentPriceStr} | ${regimeEn(pos.regime)}`);
    lines.push(`    Your:    ${pos.minPrice} ~ ${pos.maxPrice}`);
    lines.push(`    BB:      ${bbBound}`);
    lines.push(`  PnL:       ${pnlStr}${profitStr}`);
    lines.push(`  Unclaimed: $${pos.unclaimedFeesUSD.toFixed(1)} | Breakeven: ${breakevenStr} | Compound: ${compoundStr}`);
    const t0line = formatTokenCompactLog(pos.unclaimed0, tokenDecimals[pos.token0Symbol] ?? 18, pos.token0Symbol, pos.fees0USD);
    const t1line = formatTokenCompactLog(pos.unclaimed1, tokenDecimals[pos.token1Symbol] ?? 18, pos.token1Symbol, pos.fees1USD);
    const t2line = pos.token2Symbol ? formatTokenCompactLog(pos.unclaimed2, tokenDecimals[pos.token2Symbol] ?? 18, pos.token2Symbol, pos.fees2USD) : null;
    if (t0line) lines.push(`     ${t0line}`);
    if (t1line) lines.push(`     ${t1line}`);
    if (t2line) lines.push(`     ${t2line}`);
    const bbReady = !!(pos.bbMinPrice && pos.bbMaxPrice);
    if (bbReady && pos.overlapPercent < config.DRIFT_WARNING_PCT) {
        lines.push(`  [!] DRIFT WARNING: overlap ${pos.overlapPercent.toFixed(1)}% < ${config.DRIFT_WARNING_PCT}%`);
    }
    if (bbReady && pos.rebalance) {
        const rb = pos.rebalance;
        const strategy = REBALANCE_STRATEGY[rb.recommendedStrategy] ?? rb.recommendedStrategy;
        lines.push(`  [!] REBALANCE: ${strategy} (drift ${rb.driftPercent > 0 ? '+' : ''}${rb.driftPercent.toFixed(1)}%)`);
    }
    lines.push('─'.repeat(44));

    return lines.join('\n');
}
