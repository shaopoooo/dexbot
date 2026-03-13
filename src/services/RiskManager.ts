import { BBResult, PositionState, RiskAnalysis } from '../types';
import { config } from '../config';

export type { PositionState, RiskAnalysis };

export class RiskManager {
    private static readonly COMPOUND_GAS_COST_USD = config.DEFAULT_GAS_COST_USD;

    /**
     * Analyze Strategy Drift
     * Overlap Pct = (倉位區間與 BB 區間的重疊長度) / (倉位自身區間長度)
     * 語意：「我的倉位有多少比例落在 BB 建議範圍內」
     * 100% = 倉位完全在 BB 內（無需調整）
     *   0% = 倉位完全在 BB 外（嚴重偏移）
     */
    public static calculateDrift(actualLower: number, actualUpper: number, bbLower: number, bbUpper: number): number {
        const overlapLower = Math.max(actualLower, bbLower);
        const overlapUpper = Math.min(actualUpper, bbUpper);

        if (overlapLower >= overlapUpper) return 0; // 完全無重疊

        const posRange = Math.abs(actualUpper - actualLower);
        if (posRange === 0) return 100;

        const overlapRange = Math.abs(overlapUpper - overlapLower);
        return (overlapRange / posRange) * 100;
    }

    /**
     * Evaluate the complete risk and returns profile for a position against the BB bounds
     */
    public static analyzePosition(
        state: PositionState,
        bb: BBResult,
        dailyFeesUSD: number, // From the pool or proportional to position
        avg30DBandwidth: number,
        currentBandwidth: number,
        gasCostUSD?: number   // Dynamic gas cost; falls back to COMPOUND_GAS_COST_USD
    ): RiskAnalysis {

        // 1. Portfolio Drift Analysis
        const overlapPct = this.calculateDrift(state.tickLower, state.tickUpper, bb.tickLower, bb.tickUpper);
        const driftWarning = overlapPct < config.DRIFT_WARNING_PCT;

        // 2. EOQ Compounding Logic
        // Threshold = sqrt(2 * P * G * Fee_Rate_24h) -> approximation
        // Let P = Position size (state.capital)
        // Let G = Gas Cost
        // Let R_Daily = Fee rate 24h as decimal
        // To match actual units, it's typically sqrt(2 * P * G / R_Daily_yield) but the PROJECT_RULES says `sqrt(2 * P * G * Fee_Rate_24h)`
        // Assuming the rule implies:
        const tempFeeRate = state.feeRate24h > 0 ? state.feeRate24h : 0.0001; // Avoid divide by zero
        const gasCost = gasCostUSD ?? this.COMPOUND_GAS_COST_USD;
        const threshold = Math.sqrt(2 * state.capital * gasCost * tempFeeRate);
        const compoundSignal = state.unclaimedFees > threshold;

        // 3. Health Score
        // 以淨報酬率（ROI）為核心指標：
        //   netReturn = unclaimedFees + cumulativeIL（正 = 盈利，負 = 虧損）
        //   roi = netReturn / capital
        //   score = 50 + roi * 1000（線性映射：+5% ROI → 100, -5% ROI → 0）
        // 當 IL 為正（盈利）時健康分數高；IL 為負（虧損）時分數低；費用收入可拉高分數
        const netReturn = state.unclaimedFees + state.cumulativeIL;
        const roi = state.capital > 0 ? netReturn / state.capital : 0;
        let healthScore = Math.max(0, Math.min(100, 50 + roi * 1000));

        // 4. IL Breakeven Days
        // IL Breakeven Days = Cumulative IL USD / (24h Fees / 24)
        // Wait rule says `Cumulative IL USD / (24h Fees / 24)`. 
        // This implies breakeven in HOURS if dividing by / 24, but it says "(以天數計)". 
        // Usually it's `IL / DailyFees` for Days. Let's use `Math.abs(IL) / dailyFeesUSD` representing Days.
        const ilBreakevenDays = dailyFeesUSD > 0 ? Math.abs(state.cumulativeIL) / dailyFeesUSD : 999;

        // 5. Key Alerts
        // "IL Breakeven Days > 30 天" = RED_ALERT
        const redAlert = ilBreakevenDays > config.RED_ALERT_BREAKEVEN_DAYS;

        // "Bandwidth > 2x 30D Avg" = HIGH_VOLATILITY_AVOID
        const highVolatilityAvoid = currentBandwidth > config.HIGH_VOLATILITY_FACTOR * avg30DBandwidth;

        return {
            driftOverlapPct: overlapPct,
            driftWarning,
            compoundThreshold: threshold,
            compoundSignal,
            healthScore: Math.round(healthScore),
            ilBreakevenDays: parseFloat(ilBreakevenDays.toFixed(2)),
            redAlert,
            highVolatilityAvoid
        };
    }
}
