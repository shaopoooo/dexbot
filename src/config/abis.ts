export const abis = {
    // PancakeSwap V3 MasterChef — pendingCake(tokenId) 查詢未領 CAKE 獎勵
    PANCAKE_MASTERCHEF_V3_ABI: [
        'function pendingCake(uint256 tokenId) external view returns (uint256)',
        'function userPositionInfos(uint256 tokenId) external view returns (uint128 liquidity, uint128 boostLiquidity, int24 tickLower, int24 tickUpper, uint256 rewardGrowthInside, uint256 reward, address user, uint256 pid, uint256 boostMultiplier)',
    ],

    // Aerodrome Voter — gauges(pool) → gauge address
    AERO_VOTER_ABI: [
        'function gauges(address pool) external view returns (address)',
    ],

    // Aerodrome Slipstream CLGauge
    AERO_GAUGE_ABI: [
        'function stakedContains(address depositor, uint256 id) external view returns (bool)',
        'function earned(address account, uint256 tokenId) external view returns (uint256)',
        'function pendingFees(uint256 tokenId) external view returns (uint256 amount0, uint256 amount1)',
        'function fees0() external view returns (uint256)',
        'function fees1() external view returns (uint256)',
    ],


    // V3 NonfungiblePositionManager ABI (Basic needed parts)
    NPM_ABI: [
        'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
        'function ownerOf(uint256 tokenId) external view returns (address)',
        'function balanceOf(address owner) external view returns (uint256)',
        'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
        'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
        'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
        'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
        'event Collect(uint256 indexed tokenId, address recipient, uint128 amount0Collect, uint128 amount1Collect)'
    ],

    // Uniswap V3 / PancakeSwap V3 Pool ABI
    POOL_ABI: [
        'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
        'function feeGrowthGlobal0X128() external view returns (uint256)',
        'function feeGrowthGlobal1X128() external view returns (uint256)',
        'function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
    ],

    // Aerodrome Slipstream Pool ABI — slot0 無 feeProtocol 欄位（6 個回傳值）
    // ticks() 比 Uniswap V3 多兩個欄位：stakedLiquidityNet、rewardGrowthOutsideX128
    AERO_POOL_ABI: [
        'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
        'function feeGrowthGlobal0X128() external view returns (uint256)',
        'function feeGrowthGlobal1X128() external view returns (uint256)',
        'function ticks(int24 tick) external view returns (uint128 liquidityGross, int128 liquidityNet, int128 stakedLiquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, uint256 rewardGrowthOutsideX128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)',
    ],
};
