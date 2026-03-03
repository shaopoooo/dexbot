import { BBResult } from './BBEngine';

export interface PositionState {
    capital: number;           // $20,000 max initially
    tickLower: number;         // Current position lower tick
    tickUpper: number;         // Current position upper tick
    unclaimedFees: number;     // e.g. $12.4
    cumulativeIL: number;      // e.g. -8.7 (Loss)
    feeRate24h: number;        // Estimated daily fee rate as % of capital
}

export interface RiskAnalysis {
    driftOverlapPct: number;
    driftWarning: boolean;
    compoundThreshold: number;
    compoundSignal: boolean;
    healthScore: number;
    ilBreakevenDays: number;
    redAlert: boolean;
    highVolatilityAvoid: boolean;
}

export class RiskManager {
    // Gas cost estimation for compounding (e.g. $G)
    private static readonly COMPOUND_GAS_COST_USD = 1.5;

    // Warning Thresholds
    public static readonly RED_ALERT_BREAKEVEN_DAYS = 30;
    public static readonly HIGH_VOLATILITY_FACTOR = 2;
    public static readonly DRIFT_WARNING_PCT = 80;

    /**
     * Analyze Strategy Drift
     * Overlap Pct = (Intersection of actual tick range and recommended BB range) 
     *                / (Recommended BB range)
     */
    public static calculateDrift(actualLower: number, actualUpper: number, bbLower: number, bbUpper: number): number {
        const overlapLower = Math.max(actualLower, bbLower);
        const overlapUpper = Math.min(actualUpper, bbUpper);

        if (overlapLower >= overlapUpper) return 0;

        const bbRange = Math.abs(bbUpper - bbLower);
        if (bbRange === 0) return 100;

        const overlapRange = Math.abs(overlapUpper - overlapLower);
        return (overlapRange / bbRange) * 100;
    }

    /**
     * Evaluate the complete risk and returns profile for a position against the BB bounds
     */
    public static analyzePosition(
        state: PositionState,
        bb: BBResult,
        dailyFeesUSD: number, // From the pool or proportional to position
        avg30DBandwidth: number,
        currentBandwidth: number
    ): RiskAnalysis {

        // 1. Portfolio Drift Analysis
        const overlapPct = this.calculateDrift(state.tickLower, state.tickUpper, bb.tickLower, bb.tickUpper);
        const driftWarning = overlapPct < this.DRIFT_WARNING_PCT;

        // 2. EOQ Compounding Logic
        // Threshold = sqrt(2 * P * G * Fee_Rate_24h) -> approximation
        // Let P = Position size (state.capital)
        // Let G = Gas Cost
        // Let R_Daily = Fee rate 24h as decimal
        // To match actual units, it's typically sqrt(2 * P * G / R_Daily_yield) but the PROJECT_RULES says `sqrt(2 * P * G * Fee_Rate_24h)`
        // Assuming the rule implies:
        const tempFeeRate = state.feeRate24h > 0 ? state.feeRate24h : 0.0001; // Avoid divide by zero
        const threshold = Math.sqrt(2 * state.capital * this.COMPOUND_GAS_COST_USD * tempFeeRate);
        const compoundSignal = state.unclaimedFees > threshold;

        // 3. Health Score
        // Health Score: Score = (Fee_Income / IL_Risk_Weight) * 100
        // We treat IL_Risk as the |Cumulative IL| or a minimum cap to prevent infinity
        const ilRiskWeight = Math.abs(state.cumulativeIL) < 1 ? 1 : Math.abs(state.cumulativeIL);
        // Let Fee_Income be the unclaimed or cumulative fees (we'll use unclaimed + assumed claimed)
        // Actually PROJECT_RULES says: `Score = (Fee_Income / IL_Risk_Weight) * 100` (capped at 100)
        // This is subjective, so we implement the formula literally based on unclaimed fees for now.
        let healthScore = (state.unclaimedFees / ilRiskWeight) * 100;
        if (healthScore > 100) healthScore = 100;
        if (healthScore < 0) healthScore = 0;

        // 4. IL Breakeven Days
        // IL Breakeven Days = Cumulative IL USD / (24h Fees / 24)
        // Wait rule says `Cumulative IL USD / (24h Fees / 24)`. 
        // This implies breakeven in HOURS if dividing by / 24, but it says "(以天數計)". 
        // Usually it's `IL / DailyFees` for Days. Let's use `Math.abs(IL) / dailyFeesUSD` representing Days.
        const ilBreakevenDays = dailyFeesUSD > 0 ? Math.abs(state.cumulativeIL) / dailyFeesUSD : 999;

        // 5. Key Alerts
        // "IL Breakeven Days > 30 天" = RED_ALERT
        const redAlert = ilBreakevenDays > this.RED_ALERT_BREAKEVEN_DAYS;

        // "Bandwidth > 2x 30D Avg" = HIGH_VOLATILITY_AVOID
        // Using simple current vs avg comparison
        const highVolatilityAvoid = currentBandwidth > this.HIGH_VOLATILITY_FACTOR * avg30DBandwidth;

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
