import * as dotenv from 'dotenv';
dotenv.config();

export const config = {
  // RPC
  RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
  RPC_FALLBACKS: [
    'https://base-rpc.publicnode.com',
    'https://1rpc.io/base',
    'https://base.meowrpc.com'
  ],

  // User tracking setup
  WALLET_ADDRESS: process.env.WALLET_ADDRESS || '',

  // Subgraph Endpoints – free public endpoints (no API key)
  SUBGRAPHS: {
    Uniswap: `https://gateway.thegraph.com/api/${process.env.SUBGRAPH_API_KEY}/subgraphs/id/FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS`,
    PancakeSwap: `https://gateway.thegraph.com/api/${process.env.SUBGRAPH_API_KEY}/subgraphs/id/84ADrft27B8Jo46mdknbJ3PHoJ5wK5YeNBrYTD19WnaH`
  } as Record<string, string>,

  // Cache TTLs
  BB_VOL_CACHE_TTL_MS: 6 * 60 * 60 * 1000, // 6 hours  – annualized vol changes slowly
  POOL_VOL_CACHE_TTL_MS: 30 * 60 * 1000,      // 30 minutes – daily volume updates faster

  // Core Pools (Base Network)
  POOLS: {
    PANCAKE_0_01: '0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3',
    PANCAKE_0_05: '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
    UNISWAP_0_05: '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
    UNISWAP_0_3: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
  },

  // Telegram Bot
  BOT_TOKEN: process.env.BOT_TOKEN || '',
  CHAT_ID: process.env.CHAT_ID || '',

  // Math config
  DECIMAL_PRECISION: 18n,

  // Position tracking list
  EOQ_THRESHOLD: 5,  // Unclaimed fees threshold in USD
  CAPITAL: 20000,      // Total deployed capital in USD for scaling calculations

  // IL Tracking Setup (User Configurable)
  // Map your NLP Position token IDs to your exact original invested USD amount here.
  // Example: '123456': 15000 means for token ID '123456', you invested exactly 15,000 USD.
  INITIAL_INVESTMENT_USD: {
    // 預設填入你的持有部位與當初花費美金
    '1675918': 1810.5, // 請在此填入真正的 tokenID 跟投資金額
  } as Record<string, number>,

  // V3 NonfungiblePositionManager ABI (Basic needed parts)
  NPM_ABI: [
    'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'function ownerOf(uint256 tokenId) external view returns (address)',
    'function balanceOf(address owner) external view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
    'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
    'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
    'event DecreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
  ],

  // Contract Addresses on Base
  NPM_ADDRESSES: {
    Uniswap: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1', // Uniswap V3 NPM on Base
    PancakeSwap: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364', // PancakeSwap V3 NPM on Base
  } as Record<string, string>,

  // V3 Pool ABI (slot0 for tick & sqrtPriceX96)
  POOL_ABI: [
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'
  ],
};
