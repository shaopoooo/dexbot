import { env } from './env';
import { SortBy } from '../types';

export const constants = {
    // ── Network ────────────────────────────────────────────────────────────
    BASE_CHAIN_ID: 8453,

    // ── RPC ────────────────────────────────────────────────────────────────
    RPC_FALLBACKS: [
        'https://base-rpc.publicnode.com',
        'https://1rpc.io/base',
    ],
    RPC_STALL_TIMEOUT_MS: 3000,

    // ── Subgraph Endpoints ─────────────────────────────────────────────────
    SUBGRAPHS: {
        // Uniswap: `https://gateway.thegraph.com/api/${env.SUBGRAPH_API_KEY}/subgraphs/id/FUbEPQw1oMghy39fwWBFY5fE6MXPXZQtjncQy2cXdrNS`,
        // PancakeSwap: `https://gateway.thegraph.com/api/${env.SUBGRAPH_API_KEY}/subgraphs/id/84ADrft27B8Jo46mdknbJ3PHoJ5wK5YeNBrYTD19WnaH`
    } as Record<string, string>,

    // ── API Endpoints ──────────────────────────────────────────────────────
    API_URLS: {
        GECKOTERMINAL_OHLCV: 'https://api.geckoterminal.com/api/v2/networks/base/pools',
        DEXSCREENER_PAIRS: 'https://api.dexscreener.com/latest/dex/pairs/base',
        DEXSCREENER_TOKENS: 'https://api.dexscreener.com/latest/dex/tokens',
    },

    // ── Token Addresses (Base Network) ─────────────────────────────────────
    TOKEN_ADDRESSES: {
        WETH: '0x4200000000000000000000000000000000000006',
        CBBTC: '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf',
        CAKE: '0x3055913c90Fcc1A6CE9a358911721eEb942013A1',
        AERO: '0x940181a94a35a4569e4529a3cdfb74e38fd98631',
    },

    // ── Cache TTLs (ms) ───────────────────────────────────────────────────
    BB_VOL_CACHE_TTL_MS: 6 * 60 * 60 * 1000, // 6 hours
    POOL_VOL_CACHE_TTL_MS: 30 * 60 * 1000,      // 30 minutes
    TOKEN_PRICE_CACHE_TTL_MS: 2 * 60 * 1000,    // 2 minutes
    GAS_COST_CACHE_TTL_MS: 5 * 60 * 1000,     // 5 minutes

    // ── Time Constants (ms) ───────────────────────────────────────────────
    ONE_HOUR_MS: 60 * 60 * 1000,
    ONE_DAY_MS: 24 * 60 * 60 * 1000,

    // ── Block Scanning ────────────────────────────────────────────────────
    // 公共節點（publicnode / 1rpc）對複雜 topics filter 有 block range 限制，
    // 500 blocks/chunk 可避免 -32002 timeout；付費節點可調高至 2000。
    BLOCK_SCAN_CHUNK: 500,
    // 25M → 3M（約 70 天）：stopOnFirstMatch 從新往舊掃，近期建倉幾乎立即命中；
    // 超過 70 天的舊倉位開倉時間會顯示 N/A，建議手動設定 INITIAL_INVESTMENT_<tokenId>。
    BLOCK_LOOKBACK: 3_000_000,
    BASE_BLOCK_TIME_MS: 2_000,
    COLLECTED_FEES_MAX_FAILURES: 3,   // 連續失敗上限，超過即中止本次掃描
    COLLECTED_FEES_CHUNK_DELAY_MS: 200,  // 500-block chunk 數量增加，delay 略拉長降低 rate-limit 風險

    // ── BB Engine Parameters ──────────────────────────────────────────────
    BB_K_LOW_VOL: 1.8,   // 震盪市 (vol < threshold)
    BB_K_HIGH_VOL: 2.5,   // 趨勢市 (vol >= threshold)
    BB_VOL_THRESHOLD: 0.50,  // 年化波動率分界
    BB_MAX_OFFSET_PCT: 0.15, // 帶寬上限 ±10%
    BB_HOURLY_WINDOW: 20,    // getPrices 最後 N 小時
    BB_FALLBACK_K: 2.0,
    BB_FALLBACK_VOL: 0.5,
    BB_FALLBACK_TICK_OFFSET: 1000,
    EWMA_ALPHA: 0.3,         // 短期平滑係數
    EWMA_BETA: 0.7,         // 長期平滑係數
    MIN_CANDLES_FOR_EWMA: 5,
    BANDWIDTH_WINDOW_MAX: 30 * 24 * 12, // 30D × 288 cycles/day (5-min interval) = 8640

    // ── Scheduler ─────────────────────────────────────────────────────────────
    DEFAULT_INTERVAL_MINUTES: 10, // 預設排程間隔（分鐘），可透過 /interval 修改
    TIMESTAMP_MAX_FAILURES: 3,    // mint timestamp 查詢失敗上限，超過後標記 N/A 停止重試

    // ── Gas ───────────────────────────────────────────────────────────────
    GAS_UNITS_COMPOUND: 300_000n,  // Base 上 collect + reinvest 估算用 gas
    DEFAULT_GAS_COST_USD: 1.5,     // Gas oracle 失敗時的 fallback

    // ── Core Pools (Base Network) ─────────────────────────────────────────
    POOLS: {
        PANCAKE_WETH_CBBTC_0_01: '0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3',
        PANCAKE_WETH_CBBTC_0_05: '0xd974d59e30054cf1abeded0c9947b0d8baf90029',
        UNISWAP_WETH_CBBTC_0_05: '0x7aea2e8a3843516afa07293a10ac8e49906dabd1',
        UNISWAP_WETH_CBBTC_0_3: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5',
        AERO_WETH_CBBTC_0_0085: '0x22aee3699b6a0fed71490c103bd4e5f3309891d5', // Aerodrome Slipstream, fee=85 (0.0085%), tickSpacing=1
    },

    // ── Pool Scan List（驅動 PoolScanner.scanAllCorePools，新增池子只需改此處）──
    POOL_SCAN_LIST: [
        { address: '0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3', dex: 'PancakeSwap' as const, fee: 0.0001 },
        { address: '0xd974d59e30054cf1abeded0c9947b0d8baf90029', dex: 'PancakeSwap' as const, fee: 0.0005 },
        { address: '0x7aea2e8a3843516afa07293a10ac8e49906dabd1', dex: 'Uniswap' as const, fee: 0.0005 },
        { address: '0x8c7080564b5a792a33ef2fd473fba6364d5495e5', dex: 'Uniswap' as const, fee: 0.003 },
        { address: '0x22aee3699b6a0fed71490c103bd4e5f3309891d5', dex: 'Aerodrome' as const, fee: 0.000085 },
    ] as { address: string; dex: 'Uniswap' | 'PancakeSwap' | 'Aerodrome'; fee: number }[],

    // ── Math Config ───────────────────────────────────────────────────────
    DECIMAL_PRECISION: 18n,

    // ── Position Tracking ─────────────────────────────────────────────────
    EOQ_THRESHOLD: 5,  // Unclaimed fees threshold in USD
    CAPITAL: 20000,    // Total deployed capital in USD for scaling calculations
    DRIFT_WARNING_PCT: 80,          // Overlap % below which to show drift warning
    RED_ALERT_BREAKEVEN_DAYS: 30,   // IL Breakeven Days 超過此值觸發 RED_ALERT
    HIGH_VOLATILITY_FACTOR: 2,      // currentBandwidth > factor × avg30D 觸發 HIGH_VOLATILITY_AVOID

    // ── Concurrency ───────────────────────────────────────────────────────
    AGGREGATE_CONCURRENCY: 4,  // aggregateAll 並行 RPC 請求上限

    // ── Contract Addresses on Base ────────────────────────────────────────
    AERO_VOTER_ADDRESS: '0x16613524e02ad97eDfeF371bC883F2F5d6C480A5',
    // PancakeSwap V3 MasterChef — 質押 LP NFT 取得 CAKE 獎勵
    // ⚠️ 請至 https://docs.pancakeswap.finance/developers/smart-contracts/pancakeswap-exchange/v3-contracts 確認 Base 部署地址
    PANCAKE_MASTERCHEF_V3: process.env.PANCAKE_MASTERCHEF_V3 || '0x22d7937d7c8f96bbe426f5ce592c462b69c5e57d',

    NPM_ADDRESSES: {
        Uniswap: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
        PancakeSwap: '0x46A15B0b27311cedF172AB29E4f4766fbE7F4364',
        Aerodrome: '0x827922686190790b37229fd06084350E74485b72',
    } as Record<string, string>,

    // ── Rebalance Thresholds ──────────────────────────────────────────────
    REBALANCE_DRIFT_MIN_PCT: 5,          // 觸發再平衡的最小偏離 %
    REBALANCE_WAIT_DRIFT_PCT: 10,        // 偏離 < 此值 → 等待回歸策略
    REBALANCE_WAIT_BREAKEVEN_DAYS: 15,   // 等待策略的 breakeven 門檻（天）
    REBALANCE_DCA_DRIFT_PCT: 20,         // 偏離 < 此值 → DCA 策略
    REBALANCE_PRICE_UPPER_MARGIN: 0.9999, // 單邊建倉：上限安全邊際
    REBALANCE_PRICE_LOWER_MARGIN: 1.0001, // 單邊建倉：下限安全邊際
    REBALANCE_GAS_COST_USD: 0.1,         // 單次 rebalance 估算 Gas（USD）

    // ── Telegram Bot ──────────────────────────────────────────────────────
    SORT_LABELS: {
        size: '倉位大小',
        apr: '年化報酬',
        unclaimed: '可領取',
        health: '健康值',
    } as Record<SortBy, string>,
};
