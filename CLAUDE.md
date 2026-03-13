# CLAUDE.md — DexBot V1 多 DEX 策略（小市值版）

---

## 1. 專案核心定位

- **執行模式**：純監測 + 手動執行（Telegram Bot 推播訊號）
- **技術選型**：Node.js + TypeScript、`@uniswap/v3-sdk`、`grammyjs`（Telegram）、`ethers.js`
- **Code Review**：此專案由 **Gemini** 與 **Grok** 進行 code review，Claude 實作時應確保程式碼品質符合多模型審查標準

---

## 2. 代碼規範

### 系統韌性

**狀態持久化**
- 核心狀態（`PriceBuffer`、`volCache`）必須於重啟後保留
- 使用 `fs-extra` 將狀態儲存至 `data/state.json`，每次啟動時優先讀取

**記憶體管理**
- **禁止**使用無上限的原生 `Map` 作為快取
- 所有快取一律改用 `lru-cache`，防止記憶體無限增長

**RPC 備援與防卡死**
- 使用 `FallbackProvider`，節點順序：QuickNode → Alchemy → 公共節點
- 所有 RPC 呼叫必須設定**顯式超時**與**重試上限**
- 串行呼叫使用 `nextProvider()` 輪換節點，分散負載

**API 防封鎖**
- GeckoTerminal 免費 API 易觸發 429，必須實作 **Exponential Backoff + Jitter**
- 平行呼叫 GeckoTerminal 時限制並發數 ≤ 2
- 所有 Axios 請求應加上 `User-Agent` Header

**動態 Gas 預估**
- **禁止**硬編碼 Gas 費用（例如 `$1.5`）
- 一律透過 `fetchGasCostUSD()` 即時取得 `maxFeePerGas`

**輸入清洗**
- 所有外部傳入的 Pool Address 必須通過 `/^0x[0-9a-fA-F]{40}$/` 校驗
- 不合法輸入應拒絕處理並記錄錯誤，不允許程式崩潰

### 架構規範

**配置管理（`config/`）**
```
config/
├── env.ts        # 環境變數（process.env 讀取）
├── constants.ts  # 常數（池地址、費率等）
├── abis.ts       # 合約 ABI
└── index.ts      # 統一匯出入口
```

**型別管理**
- 所有共用 `Interface` 與 `Type` 集中至 `src/types/index.ts`
- 禁止在各模組內定義跨模組使用的型別

**DRY（Don't Repeat Yourself）**
- 相同邏輯禁止在多個模組分別實作；發現重複時立刻提取成共用工具
- `tickToPrice` → `src/utils/math.ts`；token decimal / symbol 推斷 → `src/utils/tokenInfo.ts`；Wallet 正則 → `src/utils/validation.ts`
- 新增工具函式後，**所有**使用舊版 inline 實作的地方必須一併改用新版，不允許新舊並存

**文件職責分工**

| 內容類型 | 主要文件 | 另一份文件的處理方式 |
|----------|----------|----------------------|
| 環境變數完整說明 | `README.md` | CLAUDE.md 只列變數名，不重複說明 |
| 監測池清單與地址 | `README.md` | CLAUDE.md 引用 `config.POOL_SCAN_LIST` |
| Telegram 指令完整說明 | `README.md` | CLAUDE.md 只列指令名稱 |
| 狀態持久化 schema | `README.md` | CLAUDE.md 模組描述只提欄位名 |
| 部署 / Docker / Railway | `README.md` | 不在 CLAUDE.md |
| 程式架構、模組職責、資料流 | `CLAUDE.md` | README.md 保留高階一行說明 |
| Telegram 報告欄位邏輯 | `CLAUDE.md` | README.md 保留完整格式範例 |
| 任務清單 | `CLAUDE.md` | 不在 README.md |

**文件同步規則**
- **每次變更程式邏輯後，必須同步更新 CLAUDE.md 與 README.md**
- CLAUDE.md：更新目錄結構、核心資料流、模組說明、任務清單
- README.md：更新環境變數、Telegram 指令、state.json schema、BBEngine 參數等使用者可感知的內容
- 新增功能 → 兩份文件都要反映；Bug 修正 → CLAUDE.md 任務清單 `[x]`；若有使用者可見變化（指令、格式、env var）→ README.md 一起更新
- 禁止兩份文件出現相互矛盾的說明；主要文件先更新，另一份對應簡化

**部署文件**
- `README.md`：清楚列出所有環境變數及說明（單一來源）
- `Dockerfile`：包含 Railway 部署設定指南

---

## 3. 模組說明 & 程式碼索引

### 目錄結構

```
src/
├── index.ts                    # 主進入點：cron 排程、服務協調、狀態存取
├── types/
│   └── index.ts                # 共用型別定義（PositionRecord、BBResult、RiskAnalysis、RawPosition 等）
├── config/
│   ├── env.ts                  # 環境變數讀取（process.env）
│   ├── constants.ts            # 常數（池地址、快取 TTL、BB 參數、EWMA、區塊掃描、Gas）
│   ├── abis.ts                 # 合約 ABI（NPM、Pool、Aero Voter/Gauge）
│   └── index.ts                # 統一匯出入口
├── services/
│   ├── PoolScanner.ts          # APR 掃描（DexScreener + GeckoTerminal；池清單由 config.POOL_SCAN_LIST 驅動）
│   ├── BBEngine.ts             # 動態布林通道（20 SMA + EWMA stdDev + 30D 波動率）
│   ├── ChainEventScanner.ts    # 通用鏈上事件掃描器（ScanHandler 介面 + OpenTimestampHandler）
│   ├── PositionScanner.ts      # LP NFT 倉位監測（狀態管理、倉位發現、鏈上讀取、timestamp 補齊）
│   ├── FeeCalculator.ts        # 手續費計算（Uniswap / PancakeSwap / Aerodrome 三路 + 第三幣獎勵）
│   ├── PositionAggregator.ts   # 倉位組裝 Pipeline（RawChainPosition → PositionRecord）
│   ├── RiskManager.ts          # 風險評估（Health Score、IL Breakeven、EOQ 複利訊號）
│   ├── PnlCalculator.ts        # 絕對 PNL、開倉資訊、組合總覽計算
│   └── rebalance.ts            # 再平衡建議（純計算，不執行交易）
├── bot/
│   └── TelegramBot.ts          # Telegram 推播格式化
├── backtest/
│   └── BacktestEngine.ts       # 歷史回測引擎
└── utils/
    ├── logger.ts               # Winston 彩色 logger（console + 檔案輪轉）
    ├── math.ts                 # BigInt 固定精度數學工具
    ├── rpcProvider.ts          # FallbackProvider + rpcRetry + nextProvider() + fetchGasCostUSD()
    ├── cache.ts                # LRU 快取實例（bbVolCache、poolVolCache）+ snapshot/restore
    ├── stateManager.ts         # 跨重啟狀態持久化（讀寫 data/state.json）
    ├── BandwidthTracker.ts     # 30D 帶寬滾動窗口（update / snapshot / restore）
    ├── tokenPrices.ts          # 幣價快取（WETH / cbBTC / CAKE / AERO，2 分鐘 TTL）
    ├── AppState.ts             # 全域共享狀態單例（pools / positions / bbs / lastUpdated / bbKLowVol / bbKHighVol）
    ├── tokenInfo.ts            # Token 元資料（getTokenDecimals / getTokenSymbol / TOKEN_DECIMALS）
    └── formatter.ts            # 文字格式化工具（compactAmount、formatPositionLog，TelegramBot 與 logger 共用）
```

### 核心資料流

```
# 啟動順序（一次性）
TokenPriceFetcher → PoolScanner → PositionScanner → BBEngine → RiskManager
                                  ↑ 先填充 positions  ↑ 才有池子可算 BB

# PositionScanner 內部 Pipeline（5 段）：
PositionScanner.fetchAll()
  → PositionAggregator.aggregateAll(rawPositions, appState.bbs, appState.pools)
      └── FeeCalculator（fee + 第三幣）→ 基礎 PositionRecord（USD 值 + fee 正規化）
  → PnL enrichment loop（index.ts）
      └── PnlCalculator（initialCapital / ilUSD / openedDays / profitRate）
  → PositionScanner.updatePositions(assembled)  ← 寫回 appState.positions
  → runRiskManager()
      ├── RiskManager.analyzePosition（overlapPercent / healthScore / breakevenDays）
      └── RebalanceService.getRebalanceSuggestion（使用已計算的 breakevenDays）

# cron（BBEngine 必須在 PositionScanner 之前）
TokenPriceFetcher → PoolScanner → BBEngine → PositionScanner → RiskManager → BotService
                                  ↑ 預計算 BB  ↑ 直接使用 appState.bbs，不重複呼叫 GeckoTerminal

# 共享狀態（AppState singleton）
appState.pools      ← runPoolScanner 寫入
appState.positions  ← PositionScanner.updatePositions 寫入，runRiskManager 就地更新欄位
appState.bbs        ← runBBEngine 寫入，runPositionScanner 後 pruneStaleBBs()
appState.lastUpdated.* ← 各 runner 寫入時間戳
```

### PoolScanner（`src/services/PoolScanner.ts`）

- **資料來源**：DexScreener（TVL）→ GeckoTerminal（所有池子，The Graph subgraph 已停用）
- **APR 公式**：`APR = (24h 手續費 / TVL) × 365`，24h 手續費 = 7D 加權均量 × 費率
- **池清單**：由 `config.POOL_SCAN_LIST`（`constants.ts`）統一定義，新增池子只需改此處；完整地址見 README.md
- **關鍵函式**：`scanAllCorePools()` → `fetchPoolStats()` → `fetchPoolVolume()`

### BBEngine（`src/services/BBEngine.ts`）

- **均線週期**：20 SMA（`BB_HOURLY_WINDOW=20`），時間框架：1 小時；Tick 轉換使用 `nearestUsableTick`
- **stdDev 計算**：資料 ≥ 5 筆（`MIN_CANDLES_FOR_EWMA`）時用 EWMA（`α=0.3, β=0.7`）平滑後計算；不足時從 30D 年化波動率換算 1H stdDev（`sma × vol / √8760`）
- **Tick 計算方式**：直接由 SMA price 換算 tick（`tick = log(price) / log(1.0001)`），不再以 currentTick ± offset 計算；同一池子所有倉位週期內看到相同 BB，不受市價微動影響
- **下界保護**：`lowerPrice = max(sma - maxOffset, sma - k × stdDev)`，`maxOffset = sma × 10%`，禁止使用絕對數值夾值
- **幣價快取**：同時取得 WETH / cbBTC / CAKE / AERO 四個價格（DexScreener，2 分鐘 TTL），存入 `BBResult`
- **k 值**：`appState.bbKLowVol`（震盪市）/ `appState.bbKHighVol`（趨勢市），預設讀 `config.BB_K_LOW_VOL / BB_K_HIGH_VOL`，可透過 `/bbk` 即時調整；完整說明見 README.md
- **關鍵函式**：`computeDynamicBB()` — 計算上下界 Tick 與價格

### ChainEventScanner（`src/services/ChainEventScanner.ts`）

- **架構**：通用 `getLogs` 掃描器，取代 `OpenTimestampService.ts`；新增事件類型只需實作 `ScanHandler` 介面並呼叫 `chainEventScanner.registerHandler()`
- **ScanHandler 介面**：`getFromBlock()` / `processLog()` / `onBatchComplete()`；支援 `stopOnFirstMatch`、`needsBlockTimestamp`、OR-filter tokenId 批次查詢
- **分組策略**：同 NPM 合約的所有 tokenId 合併一次 `getLogs`（OR filter），分塊掃描（`BLOCK_SCAN_CHUNK=2000`），連續失敗超過 `MAX_CONSECUTIVE_FAILURES=3` 即中止
- **內建 Handler**：`OpenTimestampHandler`（原 `OpenTimestampService.ts` 邏輯移入此處）
- **Singleton 匯出**：`chainEventScanner`、`openTimestampHandler`、`getOpenTimestampSnapshot()`、`restoreOpenTimestamps()`

### PositionScanner（`src/services/PositionScanner.ts`）

- **職責**：狀態管理、倉位發現、鏈上原始資料讀取（→ `RawChainPosition[]`）、timestamp 補齊；不直接計算 IL / PNL / Risk
- **多錢包支援**：`WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 環境變數，支援動態新增
- **Gauge 鎖倉**：`TRACKED_TOKEN_<tokenId>=<DEX>` 手動追蹤質押倉位；`isStaked` 欄位自動偵測（ownerOf 回傳非已知錢包 → staked）；`depositorWallet` 追蹤實際持有者
- **關閉倉位自動剔除**：`updatePositions()` 確認 `liquidity=0` 時，將 tokenId 加入 `closedTokenIds` Set 並從 `this.positions` 移除；`syncFromChain` 和 `restoreDiscoveredPositions` 均跳過 closedTokenIds；持久化至 `state.json`，重啟後不重新掃描（避免已關倉的 NFT 每週期浪費 RPC）
- **Drift 門檻**：實際區間與 BB 區間重合度 < 80% 時推播 `STRATEGY_DRIFT_WARNING`
- **手續費計算**：委託 `FeeCalculator`（見下方），PositionScanner 不直接呼叫合約計算費用
- **timestamp 失敗保護**：`timestampFailures` Map 記錄各 tokenId 失敗次數；超過 `config.TIMESTAMP_MAX_FAILURES`（= 3）後寫入 `openTimestampMs = -1`（顯示 N/A），停止重試
- **注意**：Aerodrome `positions()` 第 5 欄回傳 `tickSpacing`（非 fee pips）
- **關鍵函式**：`fetchAll()` / `updatePositions()` / `syncFromChain(skipTimestampScan?)` / `fillMissingTimestamps()` / `restoreDiscoveredPositions()` / `getDiscoveredSnapshot()` / `getClosedSnapshot()` / `restoreClosedTokenIds()`

### FeeCalculator（`src/services/FeeCalculator.ts`）

- **職責**：純 RPC 手續費計算，與 PositionScanner 解耦
- **Aerodrome staked fallback 鏈**：`voter.gauges()` → `gauge.pendingFees(tokenId)` → `collect.staticCall({from: gauge})` → `tokensOwed`（第 3 級 `computePendingFees()` 暫時停用：`0x22AEe369` pool 在公共節點不支援 `feeGrowthGlobal` / `ticks()`，CALL_EXCEPTION 每次浪費 6+ 次 retry）
- **Aerodrome unstaked**：`computePendingFees()`（pool feeGrowth 數學計算）
- **Uniswap / PancakeSwap**：`collect.staticCall({ from: owner })`，最終 fallback `tokensOwed0/1`
- **第三幣獎勵**：PancakeSwap staked → `masterchef.pendingCake(tokenId)`；Aerodrome staked → `gauge.earned(depositorWallet, tokenId)`
- **幣價**：直接使用傳入的 `cakePrice / aeroPrice` 參數（由 `tokenPrices.ts` 提供），不自行維護快取

### PositionAggregator（`src/services/PositionAggregator.ts`）

- **職責**：Pipeline 組裝，將 `RawChainPosition[]` 轉為完整 `PositionRecord[]`
- **輸入**：`rawPositions, latestBBs, latestPools, gasCostUSD`
- **內部呼叫**：`FeeCalculator`、`RiskManager`、`PnlCalculator`、`rebalance`
- **幣價 fallback**：`bb` 為 null 時（啟動首次掃描），fallback 到 `getTokenPrices()` 取得 WETH / cbBTC / CAKE / AERO 價格，避免啟動時幣價全為 $0
- **關鍵函式**：`aggregateAll(rawPositions, latestBBs, latestPools, gasCostUSD)` / `assemble(input)`

### BandwidthTracker（`src/utils/BandwidthTracker.ts`）

- **職責**：各池 30D bandwidth 滾動窗口管理，與 `index.ts` 及 `RiskManager` 解耦
- **窗口大小**：`config.BANDWIDTH_WINDOW_MAX`（= 8640 筆 = 30D × 288 cycles/day）
- **持久化**：`snapshot() / restore()` 接入 `state.json`，重啟後自動恢復
- **Singleton**：`export const bandwidthTracker = new BandwidthTracker()`

### RiskManager & EOQ（`src/services/RiskManager.ts`）

```
Health Score     = (Fee_Income / IL_Risk_Weight) × 100（上限 100 分）
IL Breakeven Days = 累計 IL（USD）/ (24h 手續費 / 24)
EOQ Threshold    = sqrt(2 × P × G × Fee_Rate_24h)
```

- `G`（Gas）必須由 `fetchGasCostUSD()` 即時取得，**禁止硬編碼**
- 當 `Unclaimed Fees > Threshold` 時發送 `COMPOUND_SIGNAL`
- **關鍵函式**：`analyzePosition(positionState, bb, dailyFeesUSD, avg30DBandwidth, currentBandwidth, gasCostUSD)`

| 條件 | 標記 | 建議行動 |
|------|------|----------|
| IL Breakeven Days > 30 天 | `RED_ALERT` | 建議減倉 |
| Bandwidth > 2× 30D 平均 | `HIGH_VOLATILITY_AVOID` | 建議觀望 |

### PnlCalculator（`src/services/PnlCalculator.ts`）

- **關鍵函式**：`getInitialCapital(tokenId)` / `calculateOpenInfo()` / `calculatePortfolioSummary()`
- 運算必須與 `@uniswap/v3-sdk` 保持一致

### Telegram Bot（`src/bot/TelegramBot.ts`）

- **關鍵函式**：`sendConsolidatedReport()` — 每 5 分鐘推播單一合併報告
- **`compactAmount(n)`**：將極小數字轉為下標零表示法（如 `0.0002719` → `0.0₃2719`），Telegram 與 positions.log 共用同一邏輯
- **淨損益 vs 無常損失**：`💸 淨損益` = LP現值 + Unclaimed - 本金（含手續費）；`無常損失` = LP現值 - 本金（純市價波動）
- **鎖倉 icon**：`isStaked = true` 的倉位在 tokenId 後顯示 `🔒`
- **BB k 值顯示**：報告底部顯示目前 `k_low / k_high`（`appState.bbKLowVol / bbKHighVol`）

**指令**：`/help` / `/sort <key>` / `/interval <分鐘>` / `/bbk [low high]` / `/explain`；完整說明見 README.md

**報告欄位邏輯（實作參考）：**

- `💱` 幣價行：`getTokenPrices()` 提供，不依賴 BBResult
- `⏳ 開倉`：需 `openTimestampMs > 0`；`· 獲利 +X%` 需 `initialCapital != null`
- `💼 倉位`：`positionValueUSD`；`本金`：`initialCapital ?? N/A`；`健康`：`healthScore/100`
- `⌛ Breakeven`：`ilUSD >= 0` → 顯示「盈利中」；否則顯示 `breakevenDays` 天數
- `💸 淨損益`：`ilUSD`（LP現值 + Unclaimed - 本金）；`無常損失`：`positionValueUSD - initialCapital`
- `🔄 未領取`：`unclaimedFeesUSD`；`✅/❌` 比較 `compoundThreshold`；逐幣明細各幣 > 0 才顯示
- `🔒`：`isStaked = true`
- `⚠️ RED_ALERT`：`breakevenDays > config.RED_ALERT_BREAKEVEN_DAYS`
- `⚠️ HIGH_VOLATILITY_AVOID`：`currentBandwidth > avg30D × config.HIGH_VOLATILITY_FACTOR`
- `⚠️ DRIFT`：`overlapPercent < config.DRIFT_WARNING_PCT`；附 `rebalance.strategyName`
- 底部：`📐 BB k: low=X  high=X`（`appState.bbKLowVol / bbKHighVol`）

完整格式範例見 README.md。

### 環境變數

完整說明與 `.env` 範例見 **README.md**。Claude 在讀寫環境變數時需注意的關鍵命名：
- `WALLET_ADDRESS_N`：多錢包依序編號
- `INITIAL_INVESTMENT_<tokenId>`：本金設定，影響 PnL / 獲利率顯示
- `TRACKED_TOKEN_<tokenId>=<DEX>`：鎖倉倉位手動追蹤

---

## 4. 安全性備註

本 Bot 為**純背景監測腳本**，`npm audit` 回報的相依套件漏洞在當前架構下風險為零：

- **無 Web Server**：無外部接收 payload 或 cookie 的介面
- **無動態合約編譯**：不使用 `solc` 或 `mocha`，無 RCE 風險
- **無私鑰簽發**：純監測模式，未引入錢包私鑰進行鏈上寫入

> 可安全忽略 `cookie`、`serialize-javascript`、`elliptic` 等套件的升級警告。

---

## 5. 任務清單

### ✅ 階段一：基礎建設（已完成）

- [x] **RPC 備援**：`src/utils/rpcProvider.ts` 實作 `FallbackProvider`（QuickNode → Alchemy → 公共節點）+ `rpcRetry`
- [x] **config 拆分**：`env.ts` / `constants.ts` / `abis.ts` 分離，`index.ts` 統一匯出
- [x] **README.md**：完整記錄環境變數、架構與啟動方式

### ✅ 階段二：多 DEX / 多錢包支援（已完成）

- [x] **新增 Aerodrome WETH/cbBTC 池**：fee=85 (0.0085%)，tickSpacing=1，NPM `0x827922...`
- [x] **池命名統一**：全部改為 `{DEX}_{交易對}_{費率}` 格式（如 `UNISWAP_WETH_CBBTC_0_05`）
- [x] **多錢包支援**：`env.ts` 改為 `WALLET_ADDRESS_1`、`WALLET_ADDRESS_2`... 編號變數
- [x] **syncFromChain 多錢包迴圈**：外層錢包、內層 DEX，已同步錢包記錄於 `syncedWallets` Set
- [x] **getPoolFromTokens 碰撞修正**：key 改為 `${dex}_${fee}`，避免同費率不同 DEX 衝突
- [x] **dex 型別擴充**：全專案 `'Uniswap' | 'PancakeSwap'` 改為加入 `'Aerodrome'`

### ✅ 階段三：Bug 修正（已完成）

- [x] **IL 計算錯誤修正**：改用 Uniswap V3 sqrtPrice 數學計算 LP 倉位本金（`amount0 = L × (1/sqrtP_current - 1/sqrtP_upper)`）
- [x] **Health Score 歸零修正**：連鎖修正（IL 正確後 ilRiskWeight 不再為 $1801）
- [x] **ilUSD 型別修正**：改為 `number | null`，未設定初始本金時顯示「未設定歷史本金」
- [x] **previousBandwidth 污染修正**：改為 `previousBandwidths: Record<string, number>`，各池獨立追蹤
- [x] **initialized flag 改進**：改為 `syncedWallets: Set<string>`，支援熱新增錢包
- [x] **Aerodrome slot0 ABI 修正**：新增 `AERO_POOL_ABI`（6 個回傳值，無 `feeProtocol`），`PoolScanner` 依 dex 動態選擇
- [x] **BBEngine 重複查詢修正**：執行順序改為 BBEngine → PositionScanner，`updateAllPositions` 接收 `latestBBs` 避免重複呼叫 GeckoTerminal
- [x] **鎖倉倉位支援**：`TRACKED_TOKEN_IDS` 結構（`tokenId → dex`），手動補入 Gauge 鎖倉的倉位
- [x] **Aerodrome Subgraph Invalid URL 修正**：`fetchPoolVolume` 加入 `if (!config.SUBGRAPHS[dex])` guard，無 subgraph 時直接跳至 GeckoTerminal
- [x] **Aerodrome NPM fee 欄位語意修正**：Aerodrome `positions()` 第 5 欄回傳 `tickSpacing`（非 fee pips），`getPoolFromTokens` 加入 `'Aerodrome_1'` 對應，`feeTierForStats` 強制設為 `0.000085`
- [x] **BBEngine Aerodrome tickSpacing 修正**：`runBBEngine()` 加入 `feeTier === 0.000085` → `tickSpacing = 1`
- [x] **Hybrid 手續費計算**：`computePendingFees` 在 PancakeSwap 上 CALL_EXCEPTION（無 `feeGrowthGlobal` selector）；改為混合策略：Aerodrome → `fetchAerodromeGaugeFees()`（voter → gauge → `stakedContains` → `pendingFees` 或 `collect.staticCall`），Uniswap/PancakeSwap → `collect.staticCall({ from: owner })`，最終 fallback `tokensOwed0/1`
- [x] **BB lowerPrice 夾值 Bug 修正**：移除 `Math.max(0.00000001, lowerPrice)`，Aerodrome tick-ratio 價格 ~2.9e-12 被夾成 `1e-8` 導致 `tickOffsetLower < 0`，最終 BB 顯示 `99.69 ~ 0.029`（上下顛倒）；改為 `Math.max(sma - maxOffset, sma - k * stdDev)` 確保下界永遠 > 0
- [x] **Startup 執行順序修正**：啟動時改為 `PoolScanner → PositionScanner → BBEngine → RiskManager`（`activePositions` 先填充，BBEngine 才有池子可算），5 分鐘 cron 仍維持 `BBEngine → PositionScanner` 順序（使用預計算 BB 避免重複 API）

### ✅ 階段四：Telegram 報告優化（已完成）

- [x] **合併報告**：廢棄逐位置發送，改為 `sendConsolidatedReport` 單一訊息
- [x] **各池收益排行**：顯示全部池子 APR 由高到低，標記所有有持倉的池子
- [x] **排序指令**：`/sort size|apr|unclaimed|health`，狀態保存於 Bot 實例
- [x] **倉位標頭識別**：顯示錢包尾碼（`0xabc...1234`）與 TokenId
- [x] **手機排版優化**：`formatPositionBlock` 改為每行 ≤ 40 字元，分組顯示
- [x] **/explain 指令**：發送完整指標計算公式說明
- [x] **建倉時間戳**：`syncFromChain` 自動查詢 NFT mint Transfer 事件，快取於 in-memory
- [x] **總覽區塊**：報告最上方新增總倉位 USD、Unclaimed、總獲利 USD+%（`PnlCalculator.calculatePortfolioSummary()`）
- [x] **開倉資訊取代淨APR**：改顯示 `⏳ 開倉 X天X小時 · 獲利 +X.XX%`，邏輯集中於 `PnlCalculator.calculateOpenInfo()`
- [x] **Breakeven 優化**：IL ≥ 0 時顯示「盈利中」取代天數
- [x] **Compound 獨立換行**：`🔄 Compound` 另起一行，不再與 Breakeven 同行
- [x] **價格區間樹狀格式**：`├ 你的` / `└ BB` 改善 CJK 與 ASCII 標籤的對齊問題
- [x] **ILCalculator → PnlCalculator**：重命名並新增 `calculateOpenInfo()`、`calculatePortfolioSummary()`；錢包計數改用 `/^0x[0-9a-fA-F]{40}$/` 正則過濾
- [x] **倉位標頭改版**：移除 APR，改顯示 `倉位 $xxx | 本金 $xxx | 健康 xx/100`；新增 `PnlCalculator.getInitialCapital(tokenId)` static method 讀取 `.env` 設定值
- [x] **組合總覽加入本金**：`PortfolioSummary` 新增 `totalInitialCapital` 欄位，Telegram 總覽區塊顯示合計本金

### ✅ 階段五：系統穩定性與強化（已完成）

- [x] **狀態持久化**：`PriceBuffer`、`volCache`、`openTimestampCache`、Bot 排序偏好 存入 `data/state.json`（`src/utils/stateManager.ts`）
- [x] **記憶體管理**：`volCache` 集中至 `src/utils/cache.ts`，改用 `lru-cache`（max: 100）
- [x] **動態 Gas Oracle**：`src/utils/rpcProvider.ts` 新增 `fetchGasCostUSD()`，即時取得 `maxFeePerGas × GAS_UNITS × ETH_PRICE`，5 分鐘快取；`RiskManager.analyzePosition()` 接受 `gasCostUSD?` 參數
- [x] **Pool Address 輸入校驗**：`PoolScanner.fetchPoolStats()` 加入 `/^0x[0-9a-fA-F]{40}$/` 驗證
- [x] **rpcRetry 補強**：除 rate-limit 外，新增對 `SERVER_ERROR`（502/503）的重試邏輯，避免公共節點瞬斷直接失敗
- [x] **ChainEventScanner**：`src/services/ChainEventScanner.ts`，取代 `OpenTimestampService.ts`，以 `ScanHandler` 介面統一所有 `getLogs` 掃描邏輯（分塊 2000 blocks、連續失敗上限 3 次、chunk delay 100ms）；`OpenTimestampHandler` 移入此模組；`PositionScanner.syncFromChain()` 改為透過 `chainEventScanner.scan()` 批次掃描
- [x] **Aerodrome unclaimed fees 修正**：`collect.staticCall` 補上 `{ from: owner }`，讓 `isAuthorizedForToken` 驗證通過；舊版無 from 導致 Aerodrome 手續費永遠為 $0
- [x] **addPrice 門檻修正**：從 `< 1e-9` 改為 `<= 0`，修正 Aerodrome tick-ratio（~2.9e-12）被誤判為無效價格的問題
- [x] **BB fallback 最小資料量**：從 `< 2` 改為 `< 5` 筆才 fallback，避免冷啟動時 std dev ≈ 0 導致 BB 帶寬接近零；fallback 標籤從 `'Unknown'` 改為 `'資料累積中'`
- [x] **logger.ts 強化**：新增 `section()` 分隔線方法、level icon（`·` / `!` / `✖`）、INFO 訊息套用 service 顏色
- [x] **週期分隔線**：每 5 分鐘 cron 加入 `─── 5m cycle ───` / `─── ready ───` 視覺分隔
- [x] **訊息類別 emoji**：`⛓` 鏈上、`🌐` API 請求、`💾` 快取、`📍` 倉位、`✅` 完成、`🔄` 重新觸發
- [x] **去除重複前綴**：移除所有訊息內 `[ServiceName]` 冗餘前綴（tag 已標示）
- [x] **positions.log 格式重構**：改為純文字結構化格式，每筆快照排版如下：
  - `positionLogger` 使用 `printf` 純文字格式（`src/utils/logger.ts`）
  - `PositionRecord` 新增 `apr` 欄位，`scanPosition` 存入 `poolStats.apr`
  - `formatPositionLog()` 改為帶時間戳標頭的結構化純文字（`src/services/PositionScanner.ts`）
  - 每個 5 分鐘週期前輸出 `═══ [timestamp] Snapshot ═══` 分隔線
- [x] **Aerodrome staked 手續費重構**：staked 倉位改為 `voter.gauges()` → `gauge.pendingFees(tokenId)` → `collect.staticCall({from: gauge})` → `tokensOwed` 四級 fallback；unstaked 使用 pool feeGrowth 數學計算；解決舊版 staked 倉位 unclaimed 永遠為 $0 的問題
- [x] **第三幣獎勵支援**：`PositionRecord` 新增 `unclaimed2` / `fees2USD` / `token2Symbol`；PancakeSwap staked → `masterchef.pendingCake(tokenId)`；Aerodrome staked → `gauge.earned(depositorWallet, tokenId)`；`unclaimedFeesUSD` 已含第三幣 USD 值
- [x] **isStaked 自動偵測**：`ownerOf` 回傳非已知錢包 → `isStaked=true`；`depositorWallet` 透過 `gauge.stakedContains()` 或 `masterchef.userPositionInfos()` 反查實際持有者
- [x] **BBEngine EWMA stdDev**：資料 ≥ 5 筆（`MIN_CANDLES_FOR_EWMA`）時改用 EWMA（`α=0.3, β=0.7`）平滑後計算 stdDev，取代原始方差；不足時改由 30D 年化波動率換算 1H stdDev（`sma × vol / √8760`），確保冷啟動也有合理帶寬
- [x] **k 值調整**：震盪市 `1.2 → 1.5`，趨勢市 `1.8 → 2.0`，regime 標籤以 `k ≤ 1.5` 分界
- [x] **常數集中化**：BB 參數（`BB_K_LOW_VOL`、`BB_K_HIGH_VOL`、`BB_MAX_OFFSET_PCT`、`EWMA_ALPHA/BETA`、`MIN_CANDLES_FOR_EWMA`）、區塊掃描參數（`BLOCK_SCAN_CHUNK`、`BLOCK_LOOKBACK`、`COLLECTED_FEES_MAX_FAILURES`）、Gas 常數全數移至 `constants.ts`
- [x] **ChainEventScanner 重構**：`OpenTimestampService.ts` 廢棄，所有 `getLogs` 掃描邏輯集中至 `ChainEventScanner.ts`；新增 `ScanHandler` 介面，未來新增事件類型無需修改核心掃描迴圈
- [x] **Subgraph 停用**：`SUBGRAPHS` 常數清空（endpoints 已注解），所有池子直接使用 GeckoTerminal
- [x] **INITIAL_INVESTMENT_USD 維護**：已改為 `.env` 編號變數（`INITIAL_INVESTMENT_<tokenId>`）
- [x] **TRACKED_TOKEN_IDS 維護**：已改為 `.env` 編號變數（`TRACKED_TOKEN_<tokenId>=<DEX>`）
- [x] **Round-robin RPC**：`nextProvider()` 串行呼叫自動輪換節點，分散負載
- [x] **移除死節點**：`base.meowrpc.com` 返回 308，已從 `RPC_FALLBACKS` 移除
- [x] **State 恢復 positions**：重啟時若 wallet 配置未變，直接從 `state.json` 恢復 tokenId 清單，跳過 `syncFromChain`（省 20-50s）
- [x] **首次啟動 timestamp 背景補齊**：`syncFromChain(true)` 跳過 getLogs 掃描（避免掃 3M blocks 耗時 10–20 分鐘）；`PositionScanner.fillMissingTimestamps()` 在每次 5 分鐘 cron 背景非同步補齊缺少 `openTimestampMs` 的倉位，補齊後更新 `this.positions` 供下個週期顯示
- [x] **DexScreener 價格快取**：BBEngine 的 WETH/cbBTC 價格快取 2 分鐘，同週期只打一次 API

### ✅ 階段六：穩定性補強（已完成）

- [x] **SIGTERM 優雅關機**：`index.ts` 加入 `gracefulShutdown()` handler，同時監聽 `SIGTERM`（Railway redeploy）與 `SIGINT`（Ctrl+C），觸發時呼叫 `saveState()` 寫入 `state.json` 後 `process.exit(0)`
- [x] **PriceBuffer 冷啟動缺口**：`BBEngine.ts` 新增 `refreshPriceBuffer(poolAddress, currentTick)`；`index.ts` 啟動時在 `runPoolScanner` 完成後、`runPositionScanner` 之前，對所有 `latestPools` 補一次 `refreshPriceBuffer`，確保 buffer 的當前小時 entry 在第一次 `computeDynamicBB` 前已是最新 on-chain 價格，避免 crash 未執行 SIGTERM 時缺 1-2 筆導致 stdDev 偏低
- [x] **GeckoTerminal 全局 rate limiter**：`geckoRequest(fn)` wrapper（`src/utils/rpcProvider.ts`）：並發 1、最小間隔 1500ms（≤ 40 req/min）；BBEngine `fetchDailyVol()` 與 PoolScanner `fetchPoolVolume()` 均改用 `geckoRequest()`；重試改指數退避（429 → `15s × attempt + jitter`，其他 → `5s × attempt + jitter`）；所有 GeckoTerminal 請求加 `User-Agent: DexBot/1.0`
- [x] **DexScreener 呼叫補 timeout**：`PoolScanner.fetchPoolStats()` 的 DexScreener `axios.get` 補上 `{ timeout: 8000 }`
- [x] **Telegram 錯誤通知**：`index.ts` 新增 `sendCriticalAlert(key, msg)`（30 分鐘 cooldown）；`runPoolScanner` 回傳 0 pools 及 `runPositionScanner` catch 時觸發推播
- [x] **環境變數驗證**：`env.ts` 新增 `validateEnv()`，檢查 `BOT_TOKEN`、`CHAT_ID`、`WALLET_ADDRESS_1`；`main()` 啟動時優先呼叫，缺少則 `process.exit(1)`
- [x] **SIGINT ×3 修正**：grammY `bot.start()` 自動註冊 SIGINT handler，導致 3 個 handler 同時跑，`state.json.tmp` rename 競態失敗；加入 `isShuttingDown` 旗標，第一個 handler 執行後其餘直接 return
- [x] **啟動首次掃描幣價 $0 修正**：啟動順序 `PositionScanner → BBEngine`，首次 `aggregateAll` 時 `latestBBs` 為空（`bb=null`），`wethPrice / cbbtcPrice / aeroPrice` 全取到 0；`PositionAggregator` 改為 `bb=null` 時 fallback 到 `getTokenPrices()`
- [x] **Aerodrome staked 手續費 0/0 修正**：`gauge.pendingFees()` 靜默失敗（此版本 gauge 未實作），`collect.staticCall({from:gauge})` 也回傳 0（費用由 gauge 追蹤，不在 NPM）；新增第 3 層 fallback `computePendingFees()`（pool feeGrowth 數學計算，與 unstaked 相同邏輯）
- [x] **Timestamp 無限重試修正**：公共節點非 archive node，binary search 結果不穩定，但無失敗計數導致每 cycle 重跑；新增 `timestampFailures: Map<string, number>`，失敗超過 `config.TIMESTAMP_MAX_FAILURES`（= 3）次後寫入 `openTimestampMs = -1`（顯示 N/A），停止重試

### ✅ 階段七：計算精度、優化與測試（已完成）

- [x] **avg30DBandwidth 修正**：`index.ts` 的 `previousBandwidths` 改為 `bandwidthWindows: Record<string, number[]>` 滾動窗口（保留最近 8640 筆 = 30D × 288 次/天），`avg30DBandwidth` 改為計算窗口均值；`BANDWIDTH_WINDOW_MAX` 移至 `constants.ts`；窗口資料納入 `state.json` 持久化，重啟後自動恢復
- [x] **PoolScanner 平行化**：`scanAllCorePools` 改為 `Promise.allSettled` 平行掃描（移除串行 jitter delay）；GeckoTerminal 並發由 `geckoLimiter` 統一管控（≤ 2）
- [x] **GeckoTerminal URL 統一**：`PoolScanner.fetchPoolVolume()` 改用 `config.API_URLS.GECKOTERMINAL_OHLCV`，與 BBEngine 一致
- [x] **`latestBBs` / `latestRisks` 清理**：`runPositionScanner` 更新 `activePositions` 後，移除無對應持倉的 BB 與風險快取條目
- [x] **Rebalance Gas 即時化**：`getRebalanceSuggestion` 新增 `gasCostUSD?` 參數；`withdrawSingleSide` 策略加入划算性前置判斷（`unclaimedFeesUSD ≤ gasCost × 2` → 降級 `wait`）；`estGasCost` 改用即時 gas；`updateAllPositions` / `scanPosition` 透傳 `gasCostUSD`，`index.ts` 在 `runPositionScanner` 中呼叫 `fetchGasCostUSD()` 提供
- [x] **BBEngine 方向性偏移（SD offset）**：`rebalance.ts` `withdrawSingleSide` 以 `currentPrice vs sma` 方向決定偏移量（`sdOffset = 0.3σ × direction`）；強勢時中心上移，弱勢時下移，讓單邊建倉更貼近均值回歸路徑
- [x] **rebalance.ts 死 import 移除**：`import { BBEngine }` 從未使用，改為從 `../types` import `BBResult`，消除對 BBEngine 的直接依賴
- [x] **FeeCalculator CAKE 快取移除**：內部重複的 `fetchCakePrice()` 與 `tokenPrices.ts` 功能重疊；改為直接使用傳入的 `cakePrice` 參數
- [x] **POOL_SCAN_LIST 集中至 config**：`scanAllCorePools()` 原本硬編碼池清單；改為讀取 `config.POOL_SCAN_LIST`，新增池子只需改 `constants.ts` 一個地方
- [x] **BandwidthTracker 獨立工具類**：30D bandwidth 窗口原本散落在 `index.ts`；集中至 `src/utils/BandwidthTracker.ts`，提供 `update() / snapshot() / restore()`，接入 `state.json` 持久化
- [x] **latestRisks 全域 Map 消除**：`index.ts` 維護的 `Record<string, RiskAnalysis>` 改為將 `riskAnalysis?: RiskAnalysis` 嵌入 `PositionRecord`，省去全域狀態同步

### ✅ 階段八：PositionScanner 解耦（已完成）

God Class 拆解為 Pipeline 架構，已完成：

```
PositionScanner.fetchAll() → RawChainPosition[]
      ↓
PositionAggregator.aggregateAll(rawPositions, latestBBs, latestPools)
  └── FeeCalculator（手續費 + 第三幣獎勵）→ 基礎 PositionRecord（USD 價值 + Fee 正規化）
      ↓
index.ts runPositionScanner() PnL enrichment loop
  └── PnlCalculator（initialCapital / ilUSD / openedDays / profitRate）
      ↓
PositionScanner.updatePositions(assembled)
      ↓
index.ts runRiskManager()
  ├── RiskManager（Health Score、Drift、EOQ、avg30DBandwidth）
  └── RebalanceService（再平衡建議，使用已計算的 breakevenDays）
```

- [x] **階段一：型別集中化**：`src/types/index.ts` 集中 `PositionRecord`、`BBResult`、`RiskAnalysis`、`PoolStats`、`RebalanceSuggestion`、`RawPosition`、`RawChainPosition`、`FeeQueryResult`、`RewardsQueryResult`、`AggregateInput` 等所有共用型別
- [x] **階段二：拆分 `FeeCalculator`**：`src/services/FeeCalculator.ts`，純 RPC 手續費計算（Uniswap / PancakeSwap / Aerodrome 三路 + 第三幣獎勵）
- [x] **階段三：建立 `PositionAggregator`**：`src/services/PositionAggregator.ts`，接收 `RawChainPosition + BBResult + PoolStats`，只產出 USD 價值與手續費正規化的基礎 `PositionRecord`；業務指標（PnL / Risk / Rebalance）全部拉到 index.ts Pipeline 處理
- [x] **階段四：精簡 PositionScanner**：只負責狀態管理、倉位發現、鏈上資料讀取、時間戳補齊；移除對 RiskManager / PnlCalculator / RebalanceService 的直接耦合
- [x] **階段五：index.ts 明確化協調**：`fetchAll()` → `aggregateAll()` → PnL enrichment → `updatePositions()` → `runRiskManager()` 五段明確 Pipeline

目標依賴關係（已達成）：
- `PositionScanner` → `FeeCalculator`、`ChainEventScanner`
- `PositionAggregator` → `FeeCalculator` 只（不再 import RiskManager / PnlCalculator / rebalance）
- `index.ts` 協調所有業務計算

### 🔵 階段九：架構整理與維運（待處理）

- [x] **整合共用型別**：`PoolStats`、`BBResult`、`PositionRecord`、`RiskAnalysis` 及所有跨模組型別移至 `src/types/index.ts`（已於階段八完成）
- [x] **新增 Dockerfile**：multi-stage build（builder → runner）+ `.dockerignore`；README.md 新增 Railway 部署步驟（Volume 掛載、環境變數設定）
- [ ] **README 常見問題章節**：新增「常見錯誤排除」與「如何看 log」說明，降低部署門檻
- [ ] **Docker Compose healthcheck**：`docker-compose.yml` 加入 `healthcheck`，讓 Docker 能偵測容器是否卡死
- [ ] **GitHub Actions CI**：push / PR 時自動跑 `tsc --noEmit` + `jest`，防止帶有型別錯誤的程式碼合入

### 🟡 階段十：IL 精算與財務模型重構（待討論）

**背景**
目前 `PnlCalculator` 的 `ilUSD` 定義為 `LP現值 + unclaimed - 本金`，`RiskManager` Breakeven 使用 `|cumulativeIL| / dailyFeesUSD`。在以下場景會失準：
- 已收取手續費再投入後本金基數模糊
- Aerodrome / PancakeSwap 的 `tokensOwed` 尚未 claim 時未計入 `positionValueUSD`
- 倉位部分關閉後初始本金定義不一致

**實作前需確認**

1. **本金定義**：`INITIAL_INVESTMENT_USD` 指「首次入金」還是「累計加減倉後的淨投入」？目前為靜態 env，是否改為支援動態加減倉紀錄？
2. **已領取手續費**：`ilUSD` 目前不含已領取費用（無鏈上歷史），是否需要追蹤 `collectedFeesUSD`？若需要，要掃描 `Collect` event 累加。
3. **SDK 精算必要性**：`@uniswap/v3-sdk` `Position` 精算結果與現行誤差預計 < 1%，在沒有測試保護前是否值得優先投入？
4. **Health Score 公式**：`50 + roi × 1000` 線性映射在極端值（全損 / 超高報酬）的表現是否符合預期？

**改進步驟（確認上述各點後執行）**

- [ ] **步驟一**：以 `@uniswap/v3-sdk` `Position` 替換 `positionValueUSD` 計算（`amount0 × price0 + amount1 × price1`）
- [ ] **步驟二**：`PositionRecord` 新增 `collectedFeesUSD` 欄位；掃描 `Collect` event 累加或由用戶手動設定
- [ ] **步驟三**：`ilUSD` 改為 `LP現值 + unclaimed + collected - 本金`，PnL 涵蓋全部已實現收益
- [ ] **步驟四**：`RiskManager.analyzePosition` 的 `cumulativeIL` 傳入改用精算後 `ilUSD`
- [ ] **步驟五**：補充邊界條件單元測試（依賴階段十一），確保重構前後數字一致

### 🟡 階段十一：Jest 測試覆蓋（待討論）

**背景**
`tests/` 目錄目前幾乎空白，對核心計算（IL、BB、Health Score、rebalance 策略）的任何重構都缺乏安全網，且與階段十的財務模型重構互為前置條件。

**實作前需確認**

1. **測試策略優先序**：建議先覆蓋「純計算函式」（BBEngine、RiskManager、PnlCalculator、rebalance.ts）再做「整合流程」；後者需要 mock RPC，成本高且 CI 不穩定。
2. **Mock 深度**：`PositionScanner` 強耦合 RPC，建議以**階段八解耦完成**為前提才進行整合測試。
3. **測試資料**：BB / IL 計算優先使用固定數值覆蓋邏輯邊界；真實鏈上快照測試留待後期補充。
4. **CI RPC Key**：GitHub Actions 跑整合測試時是否需要注入 `RPC_URL` secret？純計算單元測試不需要。

**改進步驟**

- [ ] **步驟一**：建立測試基礎設施（`jest.config.ts`、`tsconfig.test.json`、共用 fixture helper）
- [ ] **步驟二**：`BBEngine` 單元測試 — EWMA stdDev、k 值選取、lowerPrice 下界保護、fallback（< 5 筆資料）
- [ ] **步驟三**：`RiskManager` 單元測試 — Health Score 邊界（capital=0、roi 極端值）、Drift 計算、EOQ threshold
- [ ] **步驟四**：`PnlCalculator` 單元測試 — absolutePNL、openInfo、portfolioSummary（含 null capital）
- [ ] **步驟五**：`rebalance.ts` 單元測試 — 三種策略選取邏輯、SD offset 方向、Gas 划算性降級
- [ ] **步驟六**：GitHub Actions CI — push / PR 自動跑 `tsc --noEmit` + `jest`（純計算，不需 RPC secret）

### 🟡 階段十二：回測策略模擬（待討論）

**背景**
`BacktestEngine.ts` 目前只做靜態 BB 計算，無法量化「持倉不動 vs 觸發 BB 後再平衡」的實際報酬差異。加入 simulation loop 後可在歷史資料上驗證 rebalance 策略是否划算。

**實作前需確認**

1. **再平衡成本模型**：每次再平衡成本 = Gas + Swap slippage。slippage 如何估算？使用固定比例（如 0.1%）還是依池子深度動態計算？
2. **複利假設**：回測中收取的手續費是否自動再投入 LP？兩種假設結論差異顯著，需統一。
3. **資料粒度**：GeckoTerminal 免費 API 只提供 1D OHLCV，BB 計算需要 1H。用 1D 資料時 intra-day 觸發點無法精確還原，是否可接受？
4. **回測範圍**：僅支援現有池子還是允許輸入自訂池地址？
5. **輸出格式**：純 console log、JSON export、還是透過 Telegram 指令觸發並回傳摘要？

**改進步驟**

- [ ] **步驟一**：`BacktestEngine.ts` 新增 `runSimulation(poolAddress, days)` — 從 GeckoTerminal 拉取 N 天日線 OHLCV
- [ ] **步驟二**：實作 `HoldStrategy` — 持倉不動時的 IL + 手續費收益（基於 V3 流動性數學）
- [ ] **步驟三**：實作 `RebalanceStrategy` — 每日收盤後判斷是否觸發 BB；觸發則扣除 Gas + slippage，以新 BB 重建倉位
- [ ] **步驟四**：輸出比較表：`[日期 | Hold PnL | Rebalance PnL | 再平衡次數 | 累計 Gas]`
- [ ] **步驟五**：Telegram `/backtest <days>` 指令觸發，結果以訊息回傳（文字摘要 + 關鍵數字）

### ✅ 階段十三：耦合問題修復（已完成）

從 log 分析與靜態依賴分析識別出的耦合問題，按優先度排列。

#### 🔴 高優先（資料一致性 / 重複計算）— 已完成

- [x] **PositionAggregator 重複呼叫 RiskManager（P0）**：`aggregateAll()` 內部以 `bandwidth=0` 呼叫 `RiskManager.analyzePosition()`，`runRiskManager()` 再以正確 bandwidth 呼叫，結果被覆蓋；移除 `PositionAggregator` 內的 RiskManager 呼叫，統一由 `runRiskManager()` 負責，`pos.overlapPercent/breakevenDays/healthScore` 寫回到 `appState.positions` 元素
- [x] **PositionAggregator 職責過多（P1）**：同時呼叫 `PnlCalculator`、`RiskManager`、`RebalanceService`；拆為純聚合（`assemble()` 只計算 USD 價值與 Fee 正規化）與外層 Pipeline（index.ts 協調 PnL enrichment → Risk → Rebalance）；`gasCostUSD` 從 `AggregateInput` 移除
- [x] **index.ts 全域狀態提取為 AppState**：`latestPools`、`activePositions`、`latestBBs`、`lastUpdates` 提取至 `src/utils/AppState.ts`（`AppState` class 單例 `appState`）；`lastUpdated` 改為 readonly 鍵防止外部直接覆蓋；新增 `pruneStaleBBs()` 取代 inline 迴圈
- [x] **TelegramBot 直接 import 服務層（P1）**：移除 `PoolScanner`、`RiskManager`、`BBEngine`、`PnlCalculator` 等服務 import；改從 `../types` 引入型別；Bot 只接收 `entries[]`，計算邏輯從 `PositionRecord` 欄位直接讀取

#### 🟡 中優先（分層違反 / 可測試性）

- [ ] **PositionScanner 全靜態類**：所有方法與狀態為 `static`，無法 mock、無法並行測試；改為可實例化類（`export const positionScanner = new PositionScanner()`），為後續 Jest 覆蓋率鋪路
- [ ] **BBEngine 全域 PriceBuffer**：`globalPriceBuffer` 為模組級單例，無法注入、無法隔離測試；改為允許注入或每池一個實例

#### 🟢 低優先（重複邏輯整合）

- [x] **tickToPrice 重複實作**：`PositionAggregator`、`PositionScanner`、`BBEngine` 各自實作 tick → price；集中至 `src/utils/math.ts` 的 `tickToPrice(tick, dec0, dec1)` export；`PositionAggregator` 已改用統一版本
- [x] **Token symbol / decimal 推斷重複**：新增 `src/utils/tokenInfo.ts`（`getTokenDecimals`、`getTokenSymbol`、`TOKEN_DECIMALS`）；`PositionAggregator` 和 `PositionScanner` 均改用統一版本，移除各自的 inline `TOKEN_DEC` map
- [ ] **Wallet 地址正則重複**：`/^0x[0-9a-fA-F]{40}$/` 散布於 `PnlCalculator`、`PoolScanner`、`TelegramBot`；集中至 `src/utils/validation.ts`
- [ ] **分散的型別宣告**：`PnlCalculator` 和 `ChainEventScanner` 內定義並匯出了多個公用型別；依「型別管理規範」應集中至 `src/types/index.ts`

---

### 🔴 階段十四：效能、安全與架構地雷（待處理）

#### 🔴 高優先（資料安全 / 穩定性）

- [x] **positions.log Health/Drift 永遠顯示預設值 0**：`logSnapshots` 在 `runPositionScanner()` 內呼叫，此時 `runRiskManager()` 尚未執行，所有 `healthScore/overlapPercent/breakevenDays` 均為初始值 0；修正：移除 `runPositionScanner()` 內的 `logSnapshots` 呼叫，改在 `runRiskManager()` 末尾（Risk + Rebalance 均完成後）呼叫，傳入 `appState.positions`
- [x] **positions.log 時區不一致（標頭 UTC，內文本地時間差 8 小時）**：`formatPositionLog` 使用 `now.getHours()/getMinutes()`（本地時間），標頭 `logSnapshots` 使用 `toISOString()`（UTC），導致標頭顯示 08:05、內文顯示 16:05；修正：`formatPositionLog` 改用 `now.getUTCHours()/getUTCMinutes()`，全面統一 UTC
- [x] **冷啟動 BB isFallback 未標記**：`prices1H.length < MIN_CANDLES_FOR_EWMA` 時走 vol-derived 路徑但 `isFallback` 未設為 `true`，`regime` 仍顯示 'Low Vol/High Vol'，UI 無法區分「資料累積中」與正常狀態；修正：新增 `isWarmupFallback` flag，冷啟動時設 `isFallback: true`、`regime: '資料累積中'`；log 補充 `(warmup)` 標記
- [x] **Cron Job Overlap 競態保護**：`buildCronJob` 無 mutex lock；若單次執行超過 5 分鐘（RPC timeout 重試疊加），第二個 cron 被觸發，兩條 coroutine 同時讀寫 `appState` 與 `state.json`，可能導致資料毀損；在閉包外加入 `let isCycleRunning = false`，進入時 `if (isCycleRunning) { log.warn; return; }`，整個 cycle 包在 `try/finally` 中，結束後設回 `false`
- [x] **aggregateAll 序列 RPC 改並行**：目前 `for...of` 逐個 `await FeeCalculator.fetchUnclaimedFees` + `fetchThirdPartyRewards`；20 個倉位即為幾十次序列 RPC，節點抖動時極易超時；改用 `p-limit`（concurrency = `config.AGGREGATE_CONCURRENCY`，預設 4）+ `Promise.allSettled`，比照 `PoolScanner` 的平行化做法；`AGGREGATE_CONCURRENCY` 集中至 `constants.ts`
- [x] **Timestamp 背景搜尋即時儲存**：原本 `fillMissingTimestamps` 需等待下一個 cron 週期才會被 `saveState` 寫入 `state.json`，導致重啟中間若發生中斷會流失已搜尋到的資料；修正：將 `saveState` 包為 trigger callback 傳入 `fillMissingTimestamps`，每找到一筆就立刻持久化儲存。
- [x] **啟動時的非同步 Timestamp 搜尋**：啟動 `main()` 完成所有 sync 與首次掃描、且 `isStartupComplete` 後，立刻觸發背景的 `fillMissingTimestamps()` 而非等待第一個 10m cron，加速冷啟動時新倉位資料的補齊。

#### 🟡 中優先（Single Source of Truth / SRP）

- [x] **RiskManager 魔術數字集中至 config**：`RiskManager.ts` 自定義 `static readonly DRIFT_WARNING_PCT = 80` 與 `RED_ALERT_BREAKEVEN_DAYS = 30`，與 `config.DRIFT_WARNING_PCT` 形成兩個真理來源；全數移至 `constants.ts`（新增 `RED_ALERT_BREAKEVEN_DAYS`、`HIGH_VOLATILITY_FACTOR`），`RiskManager` 改讀 `config.*`，移除所有 `static readonly` 常數
- [x] **formatPositionLog 提煉至 `formatter.ts`**：`PositionScanner.ts` 塞了近 100 行 `formatPositionLog` / `formatTokenCompact`（下標零、對齊、compactAmount）；Scanner 職責是鏈上資料抓取，不該含 UI 排版；提煉至 `src/utils/formatter.ts`，`TelegramBot` 與 console logger 共用同一套工具
- [x] **Telegram /bbk 指令**：`AppState` 新增 `bbKLowVol / bbKHighVol`（預設讀 config）；`BBEngine.computeDynamicBB` 改讀 `appState` 而非 `config`；`/bbk <low> <high>` 指令透過 `setBbkCallback` 更新 AppState 並持久化至 `state.json`；positions.log 標頭與 Telegram 報告底部均顯示目前 k 值
- [x] **Telegram /help 指令**：新增 `/help` 列出所有指令（sort / interval / bbk / explain）；更新 `/explain` 補充 BB k 值、再平衡策略、獲利率公式說明
- [x] **關閉倉位自動剔除**：`updatePositions()` 偵測 `liquidity=0` 時加入 `closedTokenIds` Set 並移除追蹤；`syncFromChain` / `restoreDiscoveredPositions` 跳過已關閉 tokenId；`getClosedSnapshot()` / `restoreClosedTokenIds()` 接入 `state.json` 持久化，重啟不重新掃描已關倉 NFT

#### 🟢 低優先（精度地雷，階段十前置）

- [ ] **浮點數精度地雷（為階段十打底）**：`PositionAggregator` 用 `Math.pow(1.0001, tick)` 與 IEEE-754 雙精度計算 LP 值；大 tick 或幣價懸殊池（如 SHIB/ETH）會累積精度流失，導致 PnL 與 Uniswap 介面差距擴大；進入階段十 IL 精算前，應優先廢棄浮點數，改用 `@uniswap/v3-sdk` 的 `TickMath` 與 `Position` 物件做淨值計算

---

## 6. 未來展望

以下為 V1 穩定後可探索的策略方向，不在當前實作範圍內，僅作為架構演進參考。

### 方向一：Delta-Neutral 整合對沖策略

**痛點**：V3 LP 最大問題是「賺了手續費，賠了幣價跌幅」。

**方向**：整合永續合約 DEX（Hyperliquid、GMX 或 Base 上的 Perp 協議）。

**實作場景**：DexBot 偵測到 WETH/USDC LP 倉位後，自動計算對 WETH 的多頭曝險（Delta），並建議在永續合約市場開出等值空單對沖。LP 倉位因此轉變為純手續費收益機，完全免疫幣價波動。

**技術前置條件**：
- 接入 Hyperliquid 或 GMX API，取得即時資金費率與開倉成本
- `PositionRecord` 新增 `deltaExposure` 欄位（由 `PositionAggregator` 根據 V3 流動性數學計算）
- 對沖建議納入 `RebalanceSuggestion`，並在 Telegram 報告中呈現

---

### 方向二：跨池跨協議資金遷移套利（Cross-Pool Migration）

**痛點**：現有 Bot 只針對「已持有倉位」做再平衡，忽略「別的池子更香」的機會。

**方向**：建立多維度資本效率掃描器，主動比較同交易對在不同 DEX / 費率層的 APR 差異。

**實作場景**：WETH/cbBTC 在 Uniswap 0.05% APR 掉到 20%，同期 Aerodrome 同交易對 APR 飆至 80%；扣除 Gas 與滑價後，遷移回本週期僅 2 天，Bot 推播遷移建議。

**技術前置條件**：
- `PoolScanner` 擴展為掃描更多候選池（超出現有 POOL_SCAN_LIST）
- 新增 `MigrationAnalyzer`：計算遷移成本（Gas × 2 + 滑價估計）與 APR 差異回本期
- Telegram 新指令 `/migrate` 觸發即時遷移機會掃描

---

### 方向三：Smart Money 追蹤與逆向工程

**痛點**：`PositionAggregator`、`ChainEventScanner` 的基礎設施目前只服務自己的錢包。

**方向**：將監控目標擴展至「歷史績效前 5% 的頂級 LP 地址」，建立聰明錢追蹤清單。

**實作場景**：分析歷史 NFT Mint/Burn/Collect 事件找出長期獲利巨鯨；當這些地址突然撤走流動性或對新池開出極窄區間，Bot 推播「🐋 聰明錢動作警報」供跟單或離場參考。長期可包裝為 SaaS 付費訂閱服務。

**技術前置條件**：
- `ChainEventScanner` 新增 `SmartMoneyHandler`（ScanHandler 介面），掃描指定地址的 LP 行為
- 新增外部錢包監控清單（`SMART_MONEY_ADDRESSES` env 變數）
- Telegram 新增聰明錢動作推播頻道分組

---

### 方向四：LVR 監控與毒性交易流防禦

**痛點**：Bollinger Bands 是統計學指標，LP 的真實虧損主要來自套利者（Arbitrageurs），學術上稱為 LVR（Loss Versus Rebalancing）。

**方向**：超越技術分析，改用鏈上原生的 Order Flow 特徵評估風險。

**實作場景**：監控池子 Swap 方向與頻率；若偵測到明顯單向毒性交易流（CEX 砸盤 → 鏈上套利機器人倒貨），不等價格碰到布林下軌就提早觸發「☠️ 毒性交易流警告」，建議暫時抽離流動性，等 CEX/DEX 價格回歸平衡後再放回。

**技術前置條件**：
- `ChainEventScanner` 新增 `SwapFlowHandler`：統計近 N 個 block 內 Swap 的 token0→token1 vs token1→token0 比率
- 新增 `ToxicFlowDetector`：計算單向流比率門檻（如 > 80% 同向視為毒性）
- 整合至 `RiskManager.analyzePosition()`，新增 `toxicFlowWarning` 欄位

---

### 方向五：期權對沖 IL（Panoptic / Smilee）

**原理**：在 Uniswap V3 提供流動性，數學上等同於「賣出賣權（Short Put）」。

**方向**：對接 DeFi 期權協議（Panoptic、Smilee），在開 LP 時同步計算期權保費，達到最大虧損鎖死、手續費收益無限的完美部位。

**實作場景**：Bot 建議開出偏窄 LP 區間時，同步計算在 Panoptic 買入對應深度價外（OTM）選擇權的成本；若期權保費遠低於預期手續費收入，推播「💡 建議買入 IL 保險」。

**技術前置條件**：
- 接入 Panoptic 或 Smilee API，取得指定 Strike / Expiry 的期權報價
- 新增 `OptionsHedgeCalculator`：輸入 LP 區間與預期持倉天數，輸出保費 vs 預期費收的損益平衡點
- 整合至 `RebalanceSuggestion`，作為可選對沖建議欄位

---