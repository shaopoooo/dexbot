# DexInfoBot 🤖📈

DexInfoBot 是一個針對 Base 網路上的集中流動性 (Concentrated Liquidity) DEX（如 **Uniswap V3** 與 **PancakeSwap V3**）量身打造的自動化風險監控與部位追蹤機器人。
它可以自動撈取全網最高 APR 的資金池，同時透過 RPC 直接掃描使用者的真實錢包，計算出每個 LP 位位的**動態布林通道 (BB)**、**無常損失 (IL)** 解套天數，最後透過 Telegram 推播完整的健康度健檢報告！

---

## ✨ 核心特色 (Features)

* **🔄 自動化多維度排程 (Decoupled Cron Services)**
  * **PoolScanner**: 每 10 分鐘自動掃描 The Graph 子圖，列出網路上目前 APR 最高的資金池。
  * **PositionScanner**: 每 10 分鐘透過 Base Network RPC 自動拉取錢包內的真實 NFT 持倉資訊與未領取收費 (Unclaimed Fees)。
  * **BBEngine**: 每分鐘即時計算各追蹤池的歷史常態分佈範圍波動 (Bollinger Bands)。
  * **RiskManager**: 每 3 分鐘運算各倉位的精確風險分數 (Health Score)、無常損失解套天數、與策略偏離 (Drift) 百分比。
* **📱 Telegram 即時示警 (Smart Notifications)**
  * 自動統整四大引擎產出的數據，定時（例：每小時）推播整理好的報表至 Telegram。
  * 提供 `RED_ALERT` (IL 解套困難)、`HIGH_VOLATILITY_AVOID` (市場震盪過大) 與 `STRATEGY_DRIFT_WARNING` (價格嚴重偏離自訂區間) 等自動警示。
  * **嚴謹的時間同步防呆機制**：在背景資料未更新完畢前，機器人會暫緩發送舊資料，並在報告底部標註各獨立服務的最後更新時間戳記 (Timestamps)。

---

## 🚀 快速開始 (Getting Started)

### 1. 安裝套件 (Install Dependencies)
請確定你已經安裝了 Node.js (v18+) 與 TypeScript。
```bash
npm install
```

### 2. 環境變數設定 (Environment Variables)
請複製環境變數範例檔，並填入你自己的 API Token 與錢包地址：
```bash
cp .env.sample .env
```
修改 `.env` 檔案的內容：
```ini
# Telegram Bot Token (透過 @BotFather 申請)
BOT_TOKEN=your_telegram_bot_token_here

# 你的 Telegram Chat ID (用來接收推播)
CHAT_ID=your_chat_id_here

# [重要] 目標錢包地址：機器人將會自動追蹤此位址擁有的 V3 LP NFT
WALLET_ADDRESS=0xYourWalletAddressHere

# 也可以自訂 RPC 與 Graph URL (預設已有 Base 主網配置)
# RPC_URL=https://mainnet.base.org
```

### 3. 編譯與執行 (Build & Run)
```bash
# 啟動並長駐執行 (結合排程)
npm run start
# 或直接透過 ts-node 啟動開發者模式
npx ts-node src/index.ts
```
> 執行後，你可以透過 Telegram 傳送 `/start` 給你的機器人來確認連接狀態，它會先默默在背景載入一次所有的資料，接著就會依照排程設定準時為你播報風險數據！

---

## 🏗 系統架構與核心服務 (Services Architecture)

DexInfoBot 採用輕量微服務型態在單一 Node 進程中執行，依靠暫存快取 (In-Memory State) 與嚴密的非同步排程 (Cron) 維持各模組的獨立運作：

### 1. PoolScanner (資金池掃描服務)
負責作為系統的眼睛。它會定時爬取 The Graph 子圖 (Subgraphs) 或使用 GeckoTerminal API 作為備援，找出 Base 網路上 Uniswap V3 與 PancakeSwap V3 當前「交易量最大、APR 最高」的核心資金池。這有助於在 Rebalance 建議時，提示玩家是否該將資金遷移到收益更好的池子。

### 2. PositionScanner (部位掃描服務)
負責分析你的持倉現況。它會直接透過 RPC 呼叫 NonfungiblePositionManager (NPM) 智能合約，查詢你錢包內擁有的所有 LP NFT。它會解析出你的資金所在的 tick 區間、目前池子的市價，並透過 static call 精準算出你「尚未領取的手續費 (Unclaimed Fees)」。這個服務負責產出最終餵給 Telegram 的 `PositionRecord` 快照。

### 3. BBEngine (布林通道引擎)
系統的量化大腦。它負責抓取資金池過去 X 天的歷史價格與波動率 (Volatility)，並配合 Exponential Weighted Moving Average (EWMA) 平滑化處理，算出一個「最具統計機率優勢」的動態價格區間（布林通道，Bollinger Bands）。當市場波動加劇時，它會給出較寬的建議區間；市場盤整時，則收窄區間以提昇資金效率 (Capital Efficiency)。

### 4. ILCalculatorService (無常損失運算服務)
這個模組負責算出你到底虧了還是賺了。在 DeFi 領域中，IL (Impermanent Loss) 有兩種截然不同的計算方式，**本系統目前採用的是「絕對美元盈虧 (Absolute PNL)」以求最直觀的資金控管。**

*   **第一種：傳統無常損失 (HODL IL)**
    *   **定義**：「如果你當初把幣死抱著不放 (HODL)，對比你現在把他們丟去當 LP，你少賺（或多虧）了多少錢？」
    *   **情境**：你拿 1 ETH ($5000) 和 5000 USDC 組 LP。一個月後 ETH 漲到 $10000。
    *   **死抱不動現值**：1 ETH ($10000) + 5000 USDC = `$15,000`。
    *   **LP 合約現值 (因 AMM 賣出 ETH)**：剩 0.2 ETH ($2000) + 12000 USDC = `$14,000`。
    *   **HODL IL** = $14000 - $15000 = `-$1,000 🔴` (代表組 LP 這個動作本身是不划算的)。

*   **第二種：絕對美元盈虧 (Absolute PNL) —— 【系統採用】**
    *   **定義**：「不管過程發生什麼事，我當初從銀行尻了多少 USD 出來投資，現在這些資產總共值多少 USD？」
    *   **情境**：同上。
    *   **當初投入本金**：`$10,000`。
    *   **LP 合約現值**：`$14,000`。
    *   **Absolute PNL** = $14000 - $10000 = `+$4,000 🟢`。
    *   **系統設定**：請在 `src/config/index.ts` 的 `INITIAL_INVESTMENT_USD` 中，手動填入你的 Token ID 以及當初投入的絕對美元本金，系統就會在每次報表中精準算出這筆含幣價漲跌的絕對盈虧！

### 5. RebalanceService (動態重組建議服務)
當部位掃描發現市價已經偏離（Drift）你當初設定的區間時，此服務會被觸發。它會根據偏離的嚴重程度、目前的手續費是否足以支付瓦斯費 (Gas)、以及最新的 BB 建議區間，提供精確的重組建議：
*   **等待回歸 (Wait)**: 偏離不大，零成本等待。
*   **DCA 定投平衡**: 準確推算出要買入多少美元 (USD) 的單一弱勢代幣，才能重新將該倉位補齊至 50/50 的完美數學比例，並放入下一個建議區間。
*   **撤資單邊建倉 (Withdraw Single Side)**: 如果嚴重偏離且不想掏出新台幣，系統會指導你用「手上僅存的單一幣種（例如滿手 ETH）」，在市價的單邊掛出一個精準的逆向網格區間，等待價格均值回歸，達到零成本解套。

### 6. RiskManager (風險控管模組)
負責將所有的數據融合並打分數。它會計算出綜合的 **健康分數 (Health Score)**，並算出最重要的指標 **回本天數 (Breakeven Days)** —— 即「依照目前的 24 小時手續費收益，需要幾天才能把當前的累積虧損 (IL) 賺回來」。如果回本天數過長 (例如 > 30 天)，它將觸發最高級別的 `RED_ALERT` 警報。

## 📜 依賴設定檔 (Config)
如果你需要新增監控的 Base 資金池名單或是自訂 DEX 的 Contract ABI 與 Address，請直接修改 `src/config/index.ts`。

## 📝 備註與授權 (License & Notes)
* 本機器人專門為 **Base Network** 所撰寫，若需遷移至 Arbitrum 或以太坊主網，請調整 `config` 內的 `RPC_URL` 與 `NPM_ADDRESSES` (非同質化代幣倉位管理器地址)。
* Disclaimer: 本工具僅為觀測與提醒用途，DeFi 投資本身具備風險，無常損失 (Impermanent Loss) 的劇烈變化不在保證之內，請妥善規劃您的部位資金。
