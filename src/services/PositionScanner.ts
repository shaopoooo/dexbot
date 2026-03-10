import { ethers } from 'ethers';
import { config } from '../config';
import { PoolScanner } from './PoolScanner';
import { BBEngine, BBResult } from './BBEngine';
import { RiskManager } from './RiskManager';
import { RebalanceService, RebalanceSuggestion } from './rebalance';
import { PnlCalculator } from './PnlCalculator';
import { createServiceLogger, positionLogger } from '../utils/logger';
import { rpcProvider, rpcRetry, delay, nextProvider } from '../utils/rpcProvider';
import { chainEventScanner, openTimestampHandler, ScanRequest } from './ChainEventScanner';
import axios from 'axios';
import { DiscoveredPosition } from '../utils/stateManager';

const log = createServiceLogger('PositionScanner');

// CAKE price cache（5 分鐘 TTL）
let cakePriceCache: { price: number; expiresAt: number } | null = null;

async function fetchCakePrice(): Promise<number> {
    if (cakePriceCache && Date.now() < cakePriceCache.expiresAt) return cakePriceCache.price;
    try {
        const res = await axios.get(
            `${config.API_URLS.DEXSCREENER_TOKENS}/${config.TOKEN_ADDRESSES.CAKE}`,
            { timeout: 5000, headers: { 'User-Agent': 'DexBot/1.0' } }
        );
        const pairs: any[] = res.data?.pairs || [];
        // 取 liquidity 最高的 pair
        const best = pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
        const price = parseFloat(best?.priceUsd || '0');
        if (price > 0) {
            cakePriceCache = { price, expiresAt: Date.now() + 5 * 60 * 1000 };
            return price;
        }
    } catch (e: any) {
        log.warn(`fetchCakePrice failed: ${e.message}`);
    }
    return cakePriceCache?.price || 0;
}

export interface PositionRecord {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    poolAddress: string;
    feeTier: number;
    token0Symbol: string;
    token1Symbol: string;
    ownerWallet: string;

    // Live Snapshot 
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    minPrice: string;
    maxPrice: string;
    bbMinPrice?: string; // Natively scaled BB lower bound
    bbMaxPrice?: string; // Natively scaled BB upper bound
    currentTick: number;
    currentPriceStr: string;
    positionValueUSD: number;

    // Fees & IL
    unclaimed0: string;
    unclaimed1: string;
    unclaimed2: string;       // CAKE rewards (PancakeSwap only), '0' otherwise
    unclaimedFeesUSD: number;
    fees0USD: number;
    fees1USD: number;
    fees2USD: number;         // CAKE USD value
    token2Symbol: string;     // 'CAKE' or ''

    // Risk
    overlapPercent: number;
    ilUSD: number | null;
    breakevenDays: number;
    healthScore: number;
    regime: string;

    // Metadata
    lastUpdated: number;
    openTimestampMs?: number; // 建倉區塊時間 (ms)，從鏈上 Transfer 事件取得
    apr?: number;         // Pool APR (from PoolScanner)
    volSource: string;    // e.g. 'The Graph (PancakeSwap)', 'GeckoTerminal', 'stale cache'
    priceSource: string;  // e.g. 'The Graph (Uniswap)', 'GeckoTerminal'
    bbFallback: boolean;  // True if BBEngine failed and returned a fallback
    isStaked: boolean;    // True if NFT is held by a contract (gauge / masterchef)
    rebalance?: RebalanceSuggestion;
}

export class PositionScanner {

    /** In-memory position store (replaces positions.json) */
    private static positions: PositionRecord[] = [];
    private static syncedWallets = new Set<string>();

    /**
     * Fetches LP NFT positions from on-chain for the configured wallet.
     * Called once at startup to seed the in-memory state.
     * Open timestamps are fetched in one batched scan per NPM via OpenTimestampService.
     */
    /**
     * 查詢 Aerodrome Slipstream 手續費。
     * 策略：
     *  1. 若 ownerOf = gauge（已 stake）→ 嘗試 gauge.pendingFees(tokenId)
     *  2. 若未 stake → 嘗試 collect.staticCall({from: owner})
     *  3. 任一失敗 → 回退至 NPM positions() 的 tokensOwed
     */
    private static async fetchAerodromeGaugeFees(
        tokenId: string,
        owner: string,
        poolAddress: string,
        position: any,
    ): Promise<{ fees0: bigint; fees1: bigint; source: string }> {
        const tokensOwedFallback = {
            fees0: BigInt(position.tokensOwed0),
            fees1: BigInt(position.tokensOwed1),
            source: 'tokensOwed',
        };

        try {
            // 1. 查詢 gauge 地址
            const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
            const gaugeAddress: string = await rpcRetry(() => voter.gauges(poolAddress), 'aero.voter.gauges');
            if (!gaugeAddress || gaugeAddress === ethers.ZeroAddress) {
                log.warn(`#${tokenId} no Aerodrome gauge found for pool`);
                return tokensOwedFallback;
            }
            log.info(`🏛  #${tokenId} gauge ${gaugeAddress.slice(0, 10)}`);

            const gauge = new ethers.Contract(gaugeAddress, config.AERO_GAUGE_ABI, nextProvider());
            const isStaked: boolean = await rpcRetry(
                () => gauge.stakedContains(owner, tokenId),
                'aero.gauge.stakedContains'
            );

            if (isStaked) {
                // 2a. 已 stake：嘗試 gauge.pendingFees(tokenId)
                try {
                    const [f0, f1] = await rpcRetry(
                        () => gauge.pendingFees(tokenId),
                        'aero.gauge.pendingFees'
                    );
                    return { fees0: BigInt(f0), fees1: BigInt(f1), source: 'gauge.pendingFees' };
                } catch {
                    log.warn(`#${tokenId} gauge.pendingFees unavailable, falling back`);
                    return tokensOwedFallback;
                }
            } else {
                // 2b. 未 stake：collect.staticCall({from: owner})
                try {
                    const npmAddress = config.NPM_ADDRESSES['Aerodrome'];
                    const npm = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());
                    const MAX_UINT128 = 2n ** 128n - 1n;
                    const collected = await npm.collect.staticCall(
                        { tokenId, recipient: owner, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 },
                        { from: owner }
                    );
                    return { fees0: BigInt(collected[0]), fees1: BigInt(collected[1]), source: 'collect.staticCall' };
                } catch (e: any) {
                    log.warn(`#${tokenId} collect.staticCall failed: ${e.message}`);
                    return tokensOwedFallback;
                }
            }
        } catch (e: any) {
            log.warn(`#${tokenId} gauge query failed: ${e.message}`);
            return tokensOwedFallback;
        }
    }

    /**
     * 從 pool 直接計算 pending unclaimed fees，不依賴 NPM collect。
     * 使用 Uniswap V3 標準公式：
     *   feeGrowthInside = feeGrowthGlobal - feeGrowthBelow(tickLower) - feeGrowthAbove(tickUpper)
     *   fees = liquidity × (feeGrowthInside - feeGrowthInsideLast) / 2^128
     * 所有運算使用 BigInt 並以 mod 2^256 處理 Solidity uint256 wraparound。
     */
    private static async computePendingFees(
        poolAddress: string,
        dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome',
        currentTick: number,
        tickLower: number,
        tickUpper: number,
        liquidity: bigint,
        feeGrowthInside0LastX128: bigint,
        feeGrowthInside1LastX128: bigint,
        tokensOwed0: bigint,
        tokensOwed1: bigint,
    ): Promise<{ fees0: bigint; fees1: bigint }> {
        const poolAbi = dex === 'Aerodrome' ? config.AERO_POOL_ABI : config.POOL_ABI;
        const pool = new ethers.Contract(poolAddress, poolAbi, nextProvider());
        const Q128 = 2n ** 128n;
        const U256 = 2n ** 256n;
        const sub256 = (a: bigint, b: bigint) => ((a - b) % U256 + U256) % U256;

        const [fg0, fg1, tLower, tUpper] = await Promise.all([
            rpcRetry(() => pool.feeGrowthGlobal0X128(), 'feeGrowthGlobal0X128'),
            rpcRetry(() => pool.feeGrowthGlobal1X128(), 'feeGrowthGlobal1X128'),
            rpcRetry(() => pool.ticks(tickLower), `ticks(${tickLower})`),
            rpcRetry(() => pool.ticks(tickUpper), `ticks(${tickUpper})`),
        ]);

        const fgg0 = BigInt(fg0); const fgg1 = BigInt(fg1);
        const lo0 = BigInt(tLower.feeGrowthOutside0X128);
        const lo1 = BigInt(tLower.feeGrowthOutside1X128);
        const hi0 = BigInt(tUpper.feeGrowthOutside0X128);
        const hi1 = BigInt(tUpper.feeGrowthOutside1X128);

        // feeGrowthBelow: currentTick >= tickLower → use outside as-is, else flip
        const below0 = currentTick >= tickLower ? lo0 : sub256(fgg0, lo0);
        const below1 = currentTick >= tickLower ? lo1 : sub256(fgg1, lo1);
        // feeGrowthAbove: currentTick < tickUpper → use outside as-is, else flip
        const above0 = currentTick < tickUpper ? hi0 : sub256(fgg0, hi0);
        const above1 = currentTick < tickUpper ? hi1 : sub256(fgg1, hi1);

        const inside0 = sub256(sub256(fgg0, below0), above0);
        const inside1 = sub256(sub256(fgg1, below1), above1);

        const pending0 = liquidity * sub256(inside0, feeGrowthInside0LastX128) / Q128;
        const pending1 = liquidity * sub256(inside1, feeGrowthInside1LastX128) / Q128;

        return {
            fees0: pending0 + tokensOwed0,
            fees1: pending1 + tokensOwed1,
        };
    }

    /**
     * 從 state 恢復已探索的倉位清單，並標記 wallet 已同步（跳過 chain scan）。
     * 呼叫端需確認 syncedWallets 與當前 config.WALLET_ADDRESSES 一致。
     */
    static restoreDiscoveredPositions(
        discovered: DiscoveredPosition[],
        wallets: string[],
        timestamps: Record<string, number>
    ) {
        const seedPositions: PositionRecord[] = discovered.map(d => ({
            tokenId: d.tokenId,
            dex: d.dex,
            poolAddress: '',
            feeTier: 0,
            token0Symbol: '',
            token1Symbol: '',
            ownerWallet: d.ownerWallet,
            liquidity: '0',
            tickLower: 0,
            tickUpper: 0,
            minPrice: '0',
            maxPrice: '0',
            currentTick: 0,
            currentPriceStr: '0',
            positionValueUSD: 0,
            unclaimed0: '0',
            unclaimed1: '0',
            unclaimed2: '0',
            unclaimedFeesUSD: 0,
            fees0USD: 0,
            fees1USD: 0,
            fees2USD: 0,
            token2Symbol: '',
            isStaked: false,
            overlapPercent: 0,
            ilUSD: null,
            breakevenDays: 0,
            healthScore: 0,
            regime: '資料累積中',
            lastUpdated: 0,
            openTimestampMs: timestamps[`${d.tokenId}_${d.dex}`],
            volSource: 'pending',
            priceSource: 'pending',
            bbFallback: false,
        }));
        this.positions = seedPositions;
        wallets.forEach(w => this.syncedWallets.add(w));
        log.info(`✅ positions restored from state: ${seedPositions.length} position(s), chain sync skipped`);
    }

    /** 取得目前 discovered positions 快照，供 stateManager 儲存。 */
    static getDiscoveredSnapshot(): DiscoveredPosition[] {
        return this.positions.map(p => ({ tokenId: p.tokenId, dex: p.dex, ownerWallet: p.ownerWallet }));
    }

    static async syncFromChain() {
        if (config.WALLET_ADDRESSES.length === 0) {
            log.info('no wallets configured, skipping chain sync');
            return;
        }

        // Phase 1: discover all tokenIds — 全部 wallet × DEX 平行掃描
        type Discovery = { tokenId: string; dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'; ownerWallet: string };
        const dexes: ('Uniswap' | 'PancakeSwap' | 'Aerodrome')[] = ['Uniswap', 'PancakeSwap', 'Aerodrome'];

        // 全串行：公共 RPC 節點無法承受並發，wallet × DEX 依序執行
        const discovered: Discovery[] = [];

        for (const walletAddress of config.WALLET_ADDRESSES) {
            const wShort = `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`;
            log.info(`⛓  sync  ${wShort}`);

            for (const dex of dexes) {
                try {
                    const npmAddress = config.NPM_ADDRESSES[dex];
                    if (!npmAddress) continue;

                    const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());
                    const balance = await rpcRetry(
                        () => npmContract.balanceOf(walletAddress),
                        `${dex}.balanceOf`
                    );
                    log.info(`📍 ${dex}  ${balance} NFT(s) found  ${wShort}`);

                    for (let i = 0; i < Number(balance); i++) {
                        const tokenId = await rpcRetry(
                            () => npmContract.tokenOfOwnerByIndex(walletAddress, i),
                            `${dex}.tokenOfOwnerByIndex(${i})`
                        );
                        const tokenIdStr = tokenId.toString();
                        log.info(`  → #${tokenIdStr}`);
                        discovered.push({ tokenId: tokenIdStr, dex, ownerWallet: walletAddress });
                    }
                } catch (error) {
                    log.error(`NPM.balanceOf failed  ${dex}  ${wShort}: ${error}`);
                }
            }

            this.syncedWallets.add(walletAddress);
        }

        // 補入手動追蹤的 TokenId（鎖倉於 Gauge 等情境）
        const discoveredIds = new Set(discovered.map(d => d.tokenId));
        for (const [tokenId, dex] of Object.entries(config.TRACKED_TOKEN_IDS)) {
            if (discoveredIds.has(tokenId)) continue;
            log.info(`📍 manual  #${tokenId} (${dex})`);
            discovered.push({ tokenId, dex: dex as 'Uniswap' | 'PancakeSwap' | 'Aerodrome', ownerWallet: 'manual' });
        }

        // Phase 2: batch-fetch open timestamps — one scan per NPM contract
        const timestampRequests: ScanRequest[] = discovered
            .filter(d => !!config.NPM_ADDRESSES[d.dex])
            .map(d => ({ tokenId: d.tokenId, npmAddress: config.NPM_ADDRESSES[d.dex], dex: d.dex }));

        await chainEventScanner.scan(timestampRequests);

        const timestamps: Record<string, number> = {};
        for (const r of timestampRequests) {
            const ts = openTimestampHandler.getCachedTimestamp(`${r.tokenId}_${r.dex}`);
            if (ts !== undefined) timestamps[`${r.tokenId}_${r.dex}`] = ts;
        }

        // Phase 3: build seedPositions
        const seedPositions: PositionRecord[] = discovered.map(d => ({
            tokenId: d.tokenId,
            dex: d.dex,
            poolAddress: '',
            feeTier: 0,
            token0Symbol: '',
            token1Symbol: '',
            ownerWallet: d.ownerWallet,
            liquidity: '0',
            tickLower: 0,
            tickUpper: 0,
            minPrice: '0',
            maxPrice: '0',
            currentTick: 0,
            currentPriceStr: '0',
            positionValueUSD: 0,
            unclaimed0: '0',
            unclaimed1: '0',
            unclaimed2: '0',
            unclaimedFeesUSD: 0,
            fees0USD: 0,
            fees1USD: 0,
            fees2USD: 0,
            token2Symbol: '',
            isStaked: false,
            overlapPercent: 0,
            ilUSD: null,
            breakevenDays: 0,
            healthScore: 0,
            regime: '資料累積中',
            lastUpdated: 0,
            openTimestampMs: timestamps[`${d.tokenId}_${d.dex}`],
            volSource: 'pending',
            priceSource: 'pending',
            bbFallback: false,
        }));

        this.positions = seedPositions;
        log.info(`✅ chain sync done: ${this.positions.length} position(s) loaded`);
    }

    /**
     * Returns the current in-memory tracked positions.
     */
    static getTrackedPositions(): PositionRecord[] {
        return this.positions;
    }

    /** Translate Chinese regime label to English. */
    private static regimeEn(regime: string): string {
        return regime
            .replace('震盪市', 'Ranging')
            .replace('趨勢市', 'Trending')
            .replace('資料累積中', 'Accumulating');
    }

    /**
     * Format a raw token amount with compact subscript-zero notation for small values.
     * e.g.  0.0002719  →  "0.0₃2719 WETH ($0.56)"
     *        0.00000774 →  "0.0₅774 cbBTC ($0.54)"
     *        0.2194     →  "0.2194 CAKE ($0.30)"
     * Returns null if the amount is zero.
     */
    private static formatTokenCompact(rawStr: string, decimals: number, symbol: string, usdValue: number): string | null {
        const raw = BigInt(rawStr);
        if (raw === 0n) return null;

        const divisor = BigInt(10) ** BigInt(decimals);
        const whole = Number(raw / divisor);
        const frac  = Number(raw % divisor) / Math.pow(10, decimals);
        const amount = whole + frac;
        if (amount === 0) return null;

        let display: string;
        if (amount < 0.01 && whole === 0) {
            // Count leading zeros in the fractional part
            const fracStr = (raw % divisor).toString().padStart(decimals, '0');
            const leadingZeros = (fracStr.match(/^0+/) ?? [''])[0].length;
            if (leadingZeros >= 2) {
                const sigDigits = fracStr.slice(leadingZeros).replace(/0+$/, '').slice(0, 4);
                const SUB = '₀₁₂₃₄₅₆₇₈₉';
                const subscript = String(leadingZeros).split('').map(d => SUB[parseInt(d)]).join('');
                display = `0.0${subscript}${sigDigits}`;
            } else {
                display = amount.toPrecision(4);
            }
        } else {
            // 4 significant figures, trim trailing zeros
            display = parseFloat(amount.toPrecision(4)).toString();
        }

        return `${display} ${symbol} ($${usdValue.toFixed(2)})`;
    }

    /** Format a single position as a plain-text block for positions.log. */
    private static formatPositionLog(pos: PositionRecord): string {
        const now = new Date();
        const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
        const label = `${pos.dex} ${(pos.feeTier * 100).toFixed(4).replace(/\.?0+$/, '')}%`;
        const walletShort = pos.ownerWallet
            ? `${pos.ownerWallet.slice(0, 6)}...${pos.ownerWallet.slice(-4)}`
            : 'unknown';

        const openInfo = PnlCalculator.calculateOpenInfo(pos.tokenId, pos.openTimestampMs, pos.ilUSD);
        const openedStr = openInfo
            ? (openInfo.days > 0 ? `${openInfo.days}d ${openInfo.hours}h` : `${openInfo.hours}h`)
            : 'unknown';

        const initialCapital = PnlCalculator.getInitialCapital(pos.tokenId);
        const posValue = pos.positionValueUSD > 0 ? `$${pos.positionValueUSD.toFixed(0)}` : 'N/A';
        const capStr   = initialCapital !== null ? `$${initialCapital.toFixed(0)}` : 'N/A';
        const aprStr   = pos.apr !== undefined ? `${(pos.apr * 100).toFixed(1)}%` : 'N/A';

        const pnlSign  = pos.ilUSD === null ? '' : pos.ilUSD >= 0 ? '+' : '-';
        const pnlAbs   = pos.ilUSD === null ? 'N/A' : `$${Math.abs(pos.ilUSD).toFixed(1)}`;
        const pnlTag   = pos.ilUSD === null ? '' : pos.ilUSD >= 0 ? '[+]' : '[-]';
        const pnlStr   = pos.ilUSD === null ? 'N/A (no capital set)' : `${pnlSign}${pnlAbs} ${pnlTag}`;

        const bbBound = (pos.bbMinPrice && pos.bbMaxPrice)
            ? `${pos.bbMinPrice} ~ ${pos.bbMaxPrice}${pos.bbFallback ? ' [fallback]' : ''}`
            : 'N/A';

        const profitStr = (openInfo?.profitRate !== null && openInfo?.profitRate !== undefined)
            ? ` | Profit: ${openInfo.profitRate >= 0 ? '+' : ''}${openInfo.profitRate.toFixed(2)}%`
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
        lines.push(`  Price:     ${pos.currentPriceStr} | ${this.regimeEn(pos.regime)}`);
        lines.push(`    Your:    ${pos.minPrice} ~ ${pos.maxPrice}`);
        lines.push(`    BB:      ${bbBound}`);
        lines.push(`  PnL:       ${pnlStr}${profitStr}`);
        lines.push(`  Unclaimed: $${pos.unclaimedFeesUSD.toFixed(1)} | Breakeven: ${breakevenStr} | Compound: ${compoundStr}`);
        const TOKEN_DEC: Record<string, number> = { WETH: 18, cbBTC: 8, CAKE: 18, AERO: 18 };
        const t0line = this.formatTokenCompact(pos.unclaimed0, TOKEN_DEC[pos.token0Symbol] ?? 18, pos.token0Symbol, pos.fees0USD);
        const t1line = this.formatTokenCompact(pos.unclaimed1, TOKEN_DEC[pos.token1Symbol] ?? 18, pos.token1Symbol, pos.fees1USD);
        const t2line = pos.token2Symbol ? this.formatTokenCompact(pos.unclaimed2, TOKEN_DEC[pos.token2Symbol] ?? 18, pos.token2Symbol, pos.fees2USD) : null;
        if (t0line) lines.push(`     ${t0line}`);
        if (t1line) lines.push(`     ${t1line}`);
        if (t2line) lines.push(`     ${t2line}`);
        if (pos.overlapPercent < RiskManager.DRIFT_WARNING_PCT) {
            lines.push(`  [!] DRIFT WARNING: overlap ${pos.overlapPercent.toFixed(1)}% < ${RiskManager.DRIFT_WARNING_PCT}%`);
        }
        if (pos.rebalance) {
            const rb = pos.rebalance;
            const strategy = REBALANCE_STRATEGY[rb.recommendedStrategy] ?? rb.recommendedStrategy;
            lines.push(`  [!] REBALANCE: ${strategy} (drift ${rb.driftPercent > 0 ? '+' : ''}${rb.driftPercent.toFixed(1)}%)`);
        }
        lines.push('─'.repeat(44));

        return lines.join('\n');
    }

    /**
     * Log position snapshots to the dedicated positions.log (append-only history).
     * Each 5-minute cycle is preceded by a timestamped header with token prices.
     */
    private static logPositionSnapshots(positions: PositionRecord[], bb?: BBResult | null) {
        const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
        const fmtPrice = (p: number) => p >= 100
            ? `$${Math.round(p).toLocaleString('en-US')}`
            : `$${p.toFixed(3)}`;
        const pricesLine = bb
            ? `  ETH ${fmtPrice(bb.ethPrice)}  BTC ${fmtPrice(bb.cbbtcPrice)}  CAKE ${fmtPrice(bb.cakePrice)}  AERO ${fmtPrice(bb.aeroPrice)}`
            : '';
        const sep = '═'.repeat(44);
        positionLogger.info(
            `\n${sep}\n  [${now}] Snapshot  (${positions.length} position${positions.length !== 1 ? 's' : ''})\n${pricesLine}\n${sep}`
        );
        for (const pos of positions) {
            positionLogger.info(this.formatPositionLog(pos));
        }
    }

    /**
     * Core routine to scan a specific NFT position, fetch live data, compute IL & BB overlap, and update the record.
     */
    static async scanPosition(tokenId: string, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome', precomputedBB?: BBResult | null, openTimestampMs?: number, cycleCache?: Record<string, BBResult>): Promise<PositionRecord | null> {
        try {
            const npmAddress = config.NPM_ADDRESSES[dex];
            const npmContract = new ethers.Contract(npmAddress, config.NPM_ABI, nextProvider());

            // Fetch live position details
            const owner = await rpcRetry(() => npmContract.ownerOf(tokenId), `${dex}.ownerOf(${tokenId})`);
            const position = await rpcRetry(() => npmContract.positions(tokenId), `${dex}.positions(${tokenId})`);

            const feeTier = Number(position.fee);
            const oShort = `${owner.slice(0, 6)}…${owner.slice(-4)}`;
            log.info(`⛓  #${tokenId} ${dex}  owner ${oShort}  fee/tick=${feeTier}  liq=${position.liquidity}`);

            const poolAddress = await this.getPoolFromTokens(position.token0, position.token1, feeTier, dex);
            if (!poolAddress) {
                log.warn(`#${tokenId} no pool match  fee/tick=${feeTier}  dex=${dex}`);
                return null;
            }

            // Fetch live pool info & BB Engine
            // Aerodrome NPM 回傳的是 tickSpacing（非 fee pips），需個別轉換
            let tickSpacing = 60;
            let feeTierForStats = feeTier / 1000000; // 預設：fee pips → 小數費率
            if (feeTier === 100) tickSpacing = 1; // 0.01%
            else if (feeTier === 500) tickSpacing = 10; // 0.05%
            else if (feeTier === 85) tickSpacing = 1; // Aerodrome fee=85 → 0.0085%
            else if (dex === 'Aerodrome' && feeTier === 1) {
                // tickSpacing=1 對應 0.0085% 池
                tickSpacing = 1;
                feeTierForStats = 0.000085;
            }

            const poolStats = await PoolScanner.fetchPoolStats(poolAddress, dex, feeTierForStats);
            if (!poolStats) {
                log.warn(`#${tokenId} fetchPoolStats returned null  ${poolAddress.slice(0, 10)}`);
                return null;
            }

            // 優先使用外部預計算的 BB（由 runBBEngine 統一計算），避免重複 API 呼叫
            // cycleCache 確保同一週期內相同池子只計算一次 BB，避免序列掃描時市價微動造成不同倉位顯示不同 BB
            const poolKey = poolAddress.toLowerCase();
            let bb: BBResult | null;
            if (precomputedBB !== undefined) {
                bb = precomputedBB;
            } else if (cycleCache?.[poolKey] !== undefined) {
                bb = cycleCache[poolKey];
            } else {
                bb = await BBEngine.computeDynamicBB(poolAddress, dex, tickSpacing, poolStats.tick);
                if (bb && cycleCache) cycleCache[poolKey] = bb;
            }

            // 判斷 NFT 是否質押（ownerOf 返回非已知錢包 → 由合約持有）
            const ownerIsWallet = config.WALLET_ADDRESSES.some(w => w.toLowerCase() === owner.toLowerCase());
            const isStaked = !ownerIsWallet;
            let depositorWallet = ownerIsWallet ? owner : '';

            // 手續費計算策略：
            // - Aerodrome staked（ownerOf = gauge）：NPM 的 feeGrowthInside0LastX128 是 staking 時的舊
            //   baseline，computePendingFees 會累積全部 pool 費用（遠大於實際可領），需改用
            //   gauge.pendingFees(tokenId) 讀取 gauge 自己的 checkpoint。
            // - Aerodrome unstaked：pool math（computePendingFees）準確可用。
            // - Uniswap / PancakeSwap: collect.staticCall({ from: owner }) 穩定可用
            let unclaimed0 = 0n;
            let unclaimed1 = 0n;
            if (dex === 'Aerodrome') {
                try {
                    if (isStaked) {
                        // owner 是合約（gauge 或持有合約）
                        // 策略：先查 voter.gauges(poolAddress) 取得 canonical gauge，
                        //       嘗試 gauge.pendingFees(tokenId)（gauge 有自己的 checkpoint）；
                        //       失敗則 fallback 到 pool math（對 unstaked 準確，staked 可能略高）。
                        const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
                        const canonicalGauge: string = await rpcRetry(
                            () => voter.gauges(poolAddress),
                            'aero.voter.gauges'
                        );
                        log.info(`🏛  #${tokenId} owner=${owner.slice(0, 10)}  canonicalGauge=${canonicalGauge?.slice(0, 10) ?? 'none'}`);

                        let pendingFeesOk = false;
                        if (canonicalGauge && canonicalGauge !== ethers.ZeroAddress) {
                            const gauge = new ethers.Contract(canonicalGauge, config.AERO_GAUGE_ABI, nextProvider());

                            // 查詢 depositor wallet：stakedContains 同時作為 pendingFees 的前置守衛
                            // 若所有已知錢包都沒有質押此 tokenId，表示 gauge 持有 NFT 但 _stakes 為空
                            // → 跳過 pendingFees（必然 revert），直接走 collect.staticCall
                            if (!depositorWallet) {
                                for (const wallet of config.WALLET_ADDRESSES) {
                                    try {
                                        if (await gauge.stakedContains(wallet, BigInt(tokenId))) {
                                            depositorWallet = wallet;
                                            break;
                                        }
                                    } catch {}
                                }
                            }

                            if (depositorWallet) {
                                // 確認有質押才呼叫 pendingFees
                                // 不走 rpcRetry：gauge _stakes 不一致時會永久 revert，重試無意義
                                try {
                                    const [f0, f1] = await gauge.pendingFees(tokenId);
                                    unclaimed0 = BigInt(f0);
                                    unclaimed1 = BigInt(f1);
                                    log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [canonical_gauge.pendingFees]`);
                                    pendingFeesOk = true;
                                } catch {
                                    // gauge _stakes 狀態不一致（stakedContains=true 但 pendingFees revert）
                                    // 靜默降級到 collect.staticCall
                                }
                            } else {
                                log.info(`#${tokenId} gauge owns NFT but not staked → skip pendingFees`);
                            }
                        }

                        if (!pendingFeesOk) {
                            // gauge.pendingFees 失敗（tokenId 不在 gauge 內部 staking 紀錄中）：
                            // 嘗試 collect.staticCall({from: owner})，gauge 是 NFT 持有者，NPM 授權允許。
                            try {
                                const MAX_UINT128 = 2n ** 128n - 1n;
                                const collected = await npmContract.collect.staticCall(
                                    {
                                        tokenId,
                                        recipient: owner,
                                        amount0Max: MAX_UINT128,
                                        amount1Max: MAX_UINT128,
                                    },
                                    { from: owner }
                                );
                                unclaimed0 = BigInt(collected.amount0);
                                unclaimed1 = BigInt(collected.amount1);
                                log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [npm.collect.staticCall from gauge]`);
                                pendingFeesOk = true;
                            } catch (e: any) {
                                log.warn(`#${tokenId} collect.staticCall from gauge failed: ${e.message}`);
                            }
                        }

                        if (!pendingFeesOk) {
                            // 最終 fallback：tokensOwed（staking 時的舊快照，保守估計）
                            unclaimed0 = BigInt(position.tokensOwed0);
                            unclaimed1 = BigInt(position.tokensOwed1);
                            log.warn(`#${tokenId} staked aero: pendingFees unavailable, using tokensOwed (conservative)`);
                        }
                    } else {
                        // Unstaked：NPM 的 feeGrowthInsideLast 是最新的，pool math 準確
                        const { fees0, fees1 } = await this.computePendingFees(
                            poolAddress, dex, poolStats.tick,
                            position.tickLower, position.tickUpper,
                            BigInt(position.liquidity),
                            BigInt(position.feeGrowthInside0LastX128),
                            BigInt(position.feeGrowthInside1LastX128),
                            BigInt(position.tokensOwed0),
                            BigInt(position.tokensOwed1),
                        );
                        unclaimed0 = fees0;
                        unclaimed1 = fees1;
                        log.info(`💸 #${tokenId} aero fees  ${unclaimed0} / ${unclaimed1}  [pool.feeGrowth]`);
                    }
                } catch (e: any) {
                    log.warn(`#${tokenId} aero fees failed: ${e.message} — using tokensOwed`);
                    unclaimed0 = BigInt(position.tokensOwed0);
                    unclaimed1 = BigInt(position.tokensOwed1);
                }
            } else {
                // Uniswap / PancakeSwap: use collect.staticCall with {from: owner}
                try {
                    const MAX_UINT128 = 2n ** 128n - 1n;
                    const collected = await npmContract.collect.staticCall(
                        {
                            tokenId,
                            recipient: owner,
                            amount0Max: MAX_UINT128,
                            amount1Max: MAX_UINT128,
                        },
                        { from: owner }
                    );
                    unclaimed0 = BigInt(collected[0]);
                    unclaimed1 = BigInt(collected[1]);
                    log.info(`💸 #${tokenId} fees  ${unclaimed0} / ${unclaimed1}`);
                } catch (e: any) {
                    // Fallback: use tokensOwed from positions() call
                    log.warn(`#${tokenId} collect.staticCall failed (${dex}): ${e.message} — using tokensOwed`);
                    unclaimed0 = BigInt(position.tokensOwed0);
                    unclaimed1 = BigInt(position.tokensOwed1);
                }
            }

            // --- Address token decimal conversion for prices and amounts ---
            // On Base, WETH = 18 decimals, cbBTC = 8 decimals.
            const wethAddr = config.TOKEN_ADDRESSES.WETH.toLowerCase();
            const cbbtcAddr = config.TOKEN_ADDRESSES.CBBTC.toLowerCase();
            const t0 = position.token0.toLowerCase();
            const t1 = position.token1.toLowerCase();
            const dec0 = (t0 === cbbtcAddr) ? 8 : 18;
            const dec1 = (t1 === cbbtcAddr) ? 8 : 18;

            const fee0Normalized = Number(unclaimed0) / Math.pow(10, dec0);
            const fee1Normalized = Number(unclaimed1) / Math.pow(10, dec1);

            // 從 BBEngine 取得動態現價（避免硬編碼）
            const wethPrice = bb?.ethPrice || 0;
            const cbbtcPrice = bb?.cbbtcPrice || 0;
            const price0 = (t0 === cbbtcAddr) ? cbbtcPrice : wethPrice;
            const price1 = (t1 === cbbtcAddr) ? cbbtcPrice : wethPrice;

            // 第三種代幣獎勵（CAKE for PancakeSwap, AERO for Aerodrome staked）
            let unclaimed2 = 0n;
            let fees2USD = 0;
            let token2Symbol = '';

            // AERO 獎勵（Aerodrome staked：gauge.earned(depositorWallet, tokenId)）
            if (dex === 'Aerodrome' && isStaked && depositorWallet) {
                try {
                    const voter = new ethers.Contract(config.AERO_VOTER_ADDRESS, config.AERO_VOTER_ABI, nextProvider());
                    const canonicalGauge: string = await rpcRetry(
                        () => voter.gauges(poolAddress),
                        'aero.voter.gauges.earned'
                    );
                    if (canonicalGauge && canonicalGauge !== ethers.ZeroAddress) {
                        const gauge = new ethers.Contract(canonicalGauge, config.AERO_GAUGE_ABI, nextProvider());
                        const earned: bigint = await gauge.earned(depositorWallet, tokenId);
                        unclaimed2 = BigInt(earned);
                        if (unclaimed2 > 0n) {
                            const aeroPrice = bb?.aeroPrice || 0;
                            const aeroNormalized = Number(unclaimed2) / 1e18;
                            fees2USD = aeroNormalized * aeroPrice;
                            token2Symbol = 'AERO';
                            log.info(`💸 #${tokenId} AERO  ${aeroNormalized.toFixed(6)}  ($${fees2USD.toFixed(3)})  [gauge.earned]`);
                        }
                    }
                } catch (e: any) {
                    log.warn(`#${tokenId} aero gauge.earned failed: ${e.message}`);
                }
            }

            // CAKE 獎勵（PancakeSwap MasterChef V3）
            // ownerOf 返回非已知錢包時，owner 本身就是 MasterChef（NFT 質押於其中）
            // 直接對 owner 合約呼叫 pendingCake，不依賴硬編碼地址
            if (dex === 'PancakeSwap') {
                // 嘗試對象：1) ownerOf 回傳的合約（即 MasterChef）2) 設定檔的 fallback 地址
                const candidates = ownerIsWallet
                    ? (config.PANCAKE_MASTERCHEF_V3 ? [config.PANCAKE_MASTERCHEF_V3] : [])
                    : [owner, ...(config.PANCAKE_MASTERCHEF_V3 && owner.toLowerCase() !== config.PANCAKE_MASTERCHEF_V3.toLowerCase() ? [config.PANCAKE_MASTERCHEF_V3] : [])];

                for (const addr of candidates) {
                    try {
                        const masterchef = new ethers.Contract(addr, config.PANCAKE_MASTERCHEF_V3_ABI, nextProvider());
                        const pending = await masterchef.pendingCake(tokenId);
                        unclaimed2 = BigInt(pending);
                        if (unclaimed2 > 0n) {
                            const cakePrice = bb?.cakePrice || await fetchCakePrice();
                            const cakeNormalized = Number(unclaimed2) / 1e18;
                            fees2USD = cakeNormalized * cakePrice;
                            token2Symbol = 'CAKE';
                            log.info(`💸 #${tokenId} CAKE  ${cakeNormalized.toFixed(6)}  ($${fees2USD.toFixed(3)})  [${addr.slice(0, 10)}]`);
                        }
                        // 順便查詢 depositor wallet
                        if (!depositorWallet) {
                            try {
                                const info = await masterchef.userPositionInfos(tokenId);
                                if (info.user && info.user !== ethers.ZeroAddress) depositorWallet = info.user;
                            } catch {}
                        }
                        break; // 成功即停止
                    } catch {
                        // 未質押或不是 MasterChef，繼續嘗試下一個
                    }
                }
            }

            const unclaimedFeesUSD = (fee0Normalized * price0) + (fee1Normalized * price1) + fees2USD;

            let overlapPercent = 0;
            let breakevenDays = 0;
            let healthScore = 0;
            let regime = 'Unknown';

            // Convert ticks to human-readable prices: price = 1.0001^tick * 10^(dec0 - dec1)
            const tickToPrice = (t: number) => Math.pow(1.0001, t) * Math.pow(10, dec0 - dec1);

            // Note: If t0 is WETH and t1 is cbBTC, price is cbBTC per WETH (~0.038)
            // If we want WETH per cbBTC, we'd invert it. We'll leave it as Token1/Token0 natively to match DexScreener convention for this pair.
            const minPrice = tickToPrice(Number(position.tickLower)).toFixed(8);
            const maxPrice = tickToPrice(Number(position.tickUpper)).toFixed(8);
            const currentPrice = tickToPrice(poolStats.tick).toFixed(8);

            let bbMinPrice: string | undefined;
            let bbMaxPrice: string | undefined;
            if (bb) {
                // Determine native scaled prices for BB ticks to match minPrice/maxPrice format
                bbMinPrice = tickToPrice(bb.tickLower).toFixed(8);
                bbMaxPrice = tickToPrice(bb.tickUpper).toFixed(8);
            }

            // LP 倉位本金計算：Uniswap V3 sqrtPrice 數學
            // sqrtPrice = sqrtPriceX96 / 2^96 (raw token1/token0 units)
            const sqrtPriceCurrent = Number(poolStats.sqrtPriceX96) / (2 ** 96);
            const sqrtPriceLower = Math.sqrt(Math.pow(1.0001, Number(position.tickLower)));
            const sqrtPriceUpper = Math.sqrt(Math.pow(1.0001, Number(position.tickUpper)));
            const liq = Number(position.liquidity);

            let posAmount0Raw = 0;
            let posAmount1Raw = 0;
            if (sqrtPriceCurrent <= sqrtPriceLower) {
                // 價格低於區間下界：倉位全為 token0
                posAmount0Raw = liq * (1 / sqrtPriceLower - 1 / sqrtPriceUpper);
            } else if (sqrtPriceCurrent >= sqrtPriceUpper) {
                // 價格高於區間上界：倉位全為 token1
                posAmount1Raw = liq * (sqrtPriceUpper - sqrtPriceLower);
            } else {
                // 價格在區間內：混合
                posAmount0Raw = liq * (1 / sqrtPriceCurrent - 1 / sqrtPriceUpper);
                posAmount1Raw = liq * (sqrtPriceCurrent - sqrtPriceLower);
            }

            const posAmount0Normalized = posAmount0Raw / Math.pow(10, dec0);
            const posAmount1Normalized = posAmount1Raw / Math.pow(10, dec1);
            const positionValueUSD = posAmount0Normalized * price0 + posAmount1Normalized * price1;

            // PNL = (LP 倉位現值 + 未領手續費) - 初始投入
            const exactIL = PnlCalculator.calculateAbsolutePNL(tokenId, positionValueUSD, unclaimedFeesUSD);

            // Fetch Risk Analysis
            const initialCapital = PnlCalculator.getInitialCapital(tokenId) ?? positionValueUSD;
            const riskState = {
                capital: initialCapital,
                tickLower: Number(position.tickLower),
                tickUpper: Number(position.tickUpper),
                unclaimedFees: unclaimedFeesUSD,
                cumulativeIL: exactIL ?? 0,
                feeRate24h: poolStats.apr / 365
            };

            let rebalanceSuggestion: RebalanceSuggestion | undefined;

            if (bb) {
                const risk = RiskManager.analyzePosition(riskState, bb, poolStats.dailyFeesUSD, 0, 0);
                overlapPercent = risk.driftOverlapPct;
                breakevenDays = risk.ilBreakevenDays;
                healthScore = risk.healthScore;
                regime = bb.regime;

                const token0Sym = t0 === cbbtcAddr ? 'cbBTC' : 'WETH';
                const token1Sym = t1 === cbbtcAddr ? 'cbBTC' : 'WETH';

                const rb = RebalanceService.getRebalanceSuggestion(
                    parseFloat(currentPrice),
                    bb,
                    unclaimedFeesUSD,
                    breakevenDays,
                    positionValueUSD,
                    token0Sym,
                    token1Sym
                );
                if (rb) rebalanceSuggestion = rb;
            }

            const record: PositionRecord = {
                tokenId,
                dex,
                poolAddress,
                feeTier: feeTierForStats,
                token0Symbol: t0 === cbbtcAddr ? 'cbBTC' : 'WETH',
                token1Symbol: t1 === cbbtcAddr ? 'cbBTC' : 'WETH',
                ownerWallet: depositorWallet || owner,
                isStaked,

                liquidity: position.liquidity.toString(),
                tickLower: Number(position.tickLower),
                tickUpper: Number(position.tickUpper),
                minPrice,
                maxPrice,
                bbMinPrice,
                bbMaxPrice,
                currentTick: poolStats.tick,
                currentPriceStr: currentPrice.toString(),
                positionValueUSD,

                unclaimed0: unclaimed0.toString(),
                unclaimed1: unclaimed1.toString(),
                unclaimed2: unclaimed2.toString(),
                unclaimedFeesUSD,
                fees0USD: fee0Normalized * price0,
                fees1USD: fee1Normalized * price1,
                fees2USD,
                token2Symbol,
                rebalance: rebalanceSuggestion,

                overlapPercent,
                ilUSD: exactIL,
                breakevenDays,
                healthScore,
                regime,

                lastUpdated: Date.now(),
                apr: poolStats.apr,
                volSource: poolStats.volSource ?? 'unknown',
                priceSource: bb && !bb.isFallback ? `The Graph / GeckoTerminal` : 'RPC (Fallback)',
                bbFallback: bb ? !!bb.isFallback : true,
            };

            return record;

        } catch (error) {
            log.error(`scan failed  #${tokenId} (${dex}): ${error}`);
            return null;
        }
    }

    /**
     * Helper to find a pool address given two tokens and a fee.
     * Uses Uniswap V3 Factory. (Pancake is similar).
     */
    private static async getPoolFromTokens(tokenA: string, tokenB: string, fee: number, dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'): Promise<string | null> {
        // Key = `${dex}_${fee}` 避免不同 DEX 相同 fee tier 碰撞（例如 Uniswap 與 PancakeSwap 都有 fee=500）
        const map: Record<string, string> = {
            'PancakeSwap_100':  config.POOLS?.PANCAKE_WETH_CBBTC_0_01  || '0xc211e1f853a898bd1302385ccde55f33a8c4b3f3',
            'PancakeSwap_500':  config.POOLS?.PANCAKE_WETH_CBBTC_0_05  || '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
            'Uniswap_500':      config.POOLS?.UNISWAP_WETH_CBBTC_0_05  || '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
            'Uniswap_3000':     config.POOLS?.UNISWAP_WETH_CBBTC_0_3   || '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
            'Aerodrome_85':     config.POOLS?.AERO_WETH_CBBTC_0_0085   || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5',
            'Aerodrome_1':      config.POOLS?.AERO_WETH_CBBTC_0_0085   || '0x22aee3699b6a0fed71490c103bd4e5f3309891d5', // Aerodrome NPM 回傳 tickSpacing 而非 fee
        };
        return map[`${dex}_${fee}`] || null;
    }

    /**
     * Update all tracked positions: re-scan from chain and log snapshots.
     */
    static async updateAllPositions(latestBBs: Record<string, BBResult> = {}) {
        const unsyncedWallets = config.WALLET_ADDRESSES.filter(w => !this.syncedWallets.has(w));
        if (unsyncedWallets.length > 0) {
            log.info(`🔄 ${unsyncedWallets.length} new wallet(s) detected, re-syncing chain`);
            await this.syncFromChain();
        }

        if (this.positions.length === 0) {
            log.info('no tracked positions, skipping update');
            return;
        }

        // 同一週期共用 BB cache：latestBBs 為基礎，掃描過程中新計算的 BB 也會存入，
        // 確保同一池子的多個倉位得到完全相同的 BB 結果（不因序列掃描時市價微動而分歧）
        const cycleCache: Record<string, BBResult> = { ...latestBBs };

        const updated: PositionRecord[] = [];
        for (const pos of this.positions) {
            const precomputedBB = pos.poolAddress ? cycleCache[pos.poolAddress.toLowerCase()] : undefined;
            const freshData = await this.scanPosition(pos.tokenId, pos.dex, precomputedBB, pos.openTimestampMs, cycleCache);
            if (freshData) {
                if (Number(freshData.liquidity) === 0) {
                    log.warn(`#${pos.tokenId} on-chain liquidity=0 — position may be closed`);
                }
                // Preserve the original ownerWallet if ownerOf returned a contract (e.g. gauge)
                const isKnownWallet = config.WALLET_ADDRESSES.some(
                    w => w.toLowerCase() === freshData.ownerWallet.toLowerCase()
                );
                if (!isKnownWallet) freshData.ownerWallet = pos.ownerWallet;
                updated.push({ ...pos, ...freshData, lastUpdated: Date.now() });
            } else {
                log.warn(`#${pos.tokenId} scan failed, keeping stale record`);
                updated.push(pos);
            }
        }

        this.positions = updated;

        // Log snapshots to dedicated positions.log for historical audit
        const firstBB = Object.values(cycleCache)[0] ?? null;
        this.logPositionSnapshots(updated, firstBB);

        log.info(`✅ ${updated.length} position(s) refreshed`);
    }
}

// Re-export from ChainEventScanner so stateManager keeps a stable import path.
export { getOpenTimestampSnapshot, restoreOpenTimestamps } from './ChainEventScanner';
