import { config } from '../config';

export interface PortfolioSummary {
    positionCount: number;
    walletCount: number;
    totalPositionUSD: number;
    totalUnclaimedUSD: number;
    totalInitialCapital: number;    // sum of configured INITIAL_INVESTMENT_USD across all positions
    totalPnL: number | null;        // null if no positions have capital configured
    totalPnLPct: number | null;     // totalPnL / totalInitialCapital × 100
}

export interface OpenInfo {
    days: number;
    hours: number;
    timeStr: string;       // e.g. "3天2小時" or "5小時"
    profitRate: number | null; // percentage, e.g. 9.17 (null if no capital set)
}

/**
 * Service for position-level financial metrics:
 * absolute PnL (IL + fees) and open-time / profit rate summary.
 */
export class PnlCalculator {
    /**
     * Calculates absolute USD PnL.
     * PnL = (current LP value + unclaimed fees) - initial capital
     * Returns null if initial capital is not configured for this tokenId.
     */
    static calculateAbsolutePNL(
        tokenId: string,
        livePositionValueUSD: number,
        totalCollectedAndUnclaimedFeesUSD: number
    ): number | null {
        const initialInvestmentUSD = config.INITIAL_INVESTMENT_USD[tokenId];
        if (typeof initialInvestmentUSD !== 'number' || initialInvestmentUSD === 0) {
            return null;
        }
        return (livePositionValueUSD + totalCollectedAndUnclaimedFeesUSD) - initialInvestmentUSD;
    }

    /** Returns the configured initial investment for a tokenId, or null if not set. */
    static getInitialCapital(tokenId: string): number | null {
        const v = config.INITIAL_INVESTMENT_USD[tokenId];
        return typeof v === 'number' && v > 0 ? v : null;
    }

    /**
     * Returns how long a position has been open and its profit rate.
     * Returns null if openTimestampMs is not set.
     */
    static calculateOpenInfo(
        tokenId: string,
        openTimestampMs: number | undefined,
        ilUSD: number | null
    ): OpenInfo | null {
        if (!openTimestampMs || openTimestampMs < 0) return null;

        const elapsedMs = Date.now() - openTimestampMs;
        const days = Math.floor(elapsedMs / 86400000);
        const hours = Math.floor((elapsedMs % 86400000) / 3600000);
        const timeStr = days > 0 ? `${days}天${hours}小時` : `${hours}小時`;

        const capital = config.INITIAL_INVESTMENT_USD[tokenId] ?? 0;
        const profitRate = (ilUSD !== null && capital > 0)
            ? (ilUSD / capital) * 100
            : null;

        return { days, hours, timeStr, profitRate };
    }

    /**
     * Aggregates portfolio-level summary from all tracked positions.
     * totalPnL is null when no position has initial capital configured.
     */
    static calculatePortfolioSummary(
        positions: Array<{
            tokenId: string;
            ownerWallet: string;
            positionValueUSD: number;
            unclaimedFeesUSD: number;
            ilUSD: number | null;
        }>
    ): PortfolioSummary {
        const walletCount = new Set(
            positions.map(p => p.ownerWallet).filter(w => /^0x[0-9a-fA-F]{40}$/.test(w ?? ''))
        ).size;

        const totalPositionUSD = positions.reduce((s, p) => s + p.positionValueUSD, 0);
        const totalUnclaimedUSD = positions.reduce((s, p) => s + p.unclaimedFeesUSD, 0);

        const pnlPositions = positions.filter(p => p.ilUSD !== null);
        let totalPnL: number | null = null;
        let totalPnLPct: number | null = null;
        if (pnlPositions.length > 0) {
            totalPnL = pnlPositions.reduce((s, p) => s + (p.ilUSD ?? 0), 0);
            const totalInitialCapital = pnlPositions.reduce((s, p) => {
                return s + (config.INITIAL_INVESTMENT_USD[p.tokenId] ?? 0);
            }, 0);
            totalPnLPct = totalInitialCapital > 0 ? (totalPnL / totalInitialCapital) * 100 : null;
        }

        const totalInitialCapital = positions.reduce((s, p) => s + (config.INITIAL_INVESTMENT_USD[p.tokenId] ?? 0), 0);

        return { positionCount: positions.length, walletCount, totalPositionUSD, totalUnclaimedUSD, totalInitialCapital, totalPnL, totalPnLPct };
    }
}
