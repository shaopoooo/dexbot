// Central type definitions for DexBot.
// All shared interfaces live here; source files re-export for backward compatibility.

export interface PoolStats {
    id: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    feeTier: number;
    apr: number;
    tvlUSD: number;
    dailyFeesUSD: number;
    tick: number;
    sqrtPriceX96: bigint;
    volSource: string;
}

export interface BBResult {
    sma: number;
    upperPrice: number;
    lowerPrice: number;
    k: number;
    volatility30D: number;
    tickLower: number;
    tickUpper: number;
    ethPrice: number;
    cbbtcPrice: number;
    cakePrice: number;
    aeroPrice: number;
    minPriceRatio: number;
    maxPriceRatio: number;
    isFallback?: boolean;
    regime: string;
}

export interface PositionState {
    capital: number;
    tickLower: number;
    tickUpper: number;
    unclaimedFees: number;
    cumulativeIL: number;
    feeRate24h: number;
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

export interface RebalanceSuggestion {
    newMinPrice: number;
    newMaxPrice: number;
    recommendedStrategy: 'wait' | 'dca' | 'withdrawSingleSide' | 'avoidSwap';
    strategyName: string;
    driftPercent: number;
    estGasCost: number;
    notes: string;
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
    bbMinPrice?: string;
    bbMaxPrice?: string;
    currentTick: number;
    currentPriceStr: string;
    positionValueUSD: number;

    // Fees & IL
    unclaimed0: string;
    unclaimed1: string;
    unclaimed2: string;
    unclaimedFeesUSD: number;
    fees0USD: number;
    fees1USD: number;
    fees2USD: number;
    token2Symbol: string;

    // Risk
    overlapPercent: number;
    ilUSD: number | null;
    breakevenDays: number;
    healthScore: number;
    regime: string;
    riskAnalysis?: RiskAnalysis;

    // Metadata
    lastUpdated: number;
    openTimestampMs?: number;
    apr?: number;
    volSource: string;
    priceSource: string;
    bbFallback: boolean;
    isStaked: boolean;
    rebalance?: RebalanceSuggestion;
    initialCapital?: number | null;
    openedDays?: number;
    openedHours?: number;
    profitRate?: number | null;
}

/** Raw discovered position — tokenId + DEX + owner, before on-chain scanning. */
export interface RawPosition {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    ownerWallet: string;
}

/** Result from FeeCalculator.fetchUnclaimedFees() */
export interface FeeQueryResult {
    unclaimed0: bigint;
    unclaimed1: bigint;
    depositorWallet: string;
    source: string;
}

/** Result from FeeCalculator.fetchThirdPartyRewards() */
export interface RewardsQueryResult {
    unclaimed2: bigint;
    fees2USD: number;
    token2Symbol: string;
    depositorWallet: string;
}

/** Input for PositionAggregator.assemble() */
export interface AggregateInput {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    owner: string;
    depositorWallet: string;
    isStaked: boolean;
    position: any;
    poolAddress: string;
    poolStats: PoolStats;
    bb: BBResult | null;
    unclaimed0: bigint;
    unclaimed1: bigint;
    unclaimed2: bigint;
    fees2USD: number;
    token2Symbol: string;
    feeTierForStats: number;
    openTimestampMs?: number;
}

/** Raw NPM chain data — fetched by PositionScanner, consumed by PositionAggregator */
export interface RawChainPosition {
    tokenId: string;
    dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
    ownerWallet: string;       // original wallet (from syncFromChain / manual)
    owner: string;             // ownerOf() result — may be a gauge contract
    isStaked: boolean;
    position: any;             // NPM positions() return value
    poolAddress: string;
    feeTier: number;           // raw NPM fee field (e.g. 100, 500, 85, 1)
    feeTierForStats: number;   // normalized (e.g. 0.000085 for Aerodrome)
    tickSpacing: number;
    openTimestampMs?: number;
}

/** Sort criteria for Telegram reports */
export type SortBy = 'size' | 'apr' | 'unclaimed' | 'health';
