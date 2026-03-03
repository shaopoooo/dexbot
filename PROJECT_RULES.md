# PROJECT_RULES.md - V1 Multi-DEX Strategy (Small Cap Edition)

## 1. 核心定位與目標 (Core Objective)
* **資本規模**：$20,000 USD (單池上限 100%)。
* **執行模式**：純監測 + 手動執行 (Telegram Bot 推播訊號)。
* **收益目標**：每月 $250–500 Net (年化目標 15%–30%)。
* **技術選型**：Node.js + TS, @uniswap/v3-sdk, grammyjs (Telegram)。

---

## 2. APR Scanner 模組 (池地址與計算公式)
每 5 分鐘掃描 Base 鏈核心池子，鎖定最高手續費效率區。

* **核心池地址表 (Base Network)**：
    * **Pancake V3 (0.01%)**: `0xC211e1f853A898Bd1302385CCdE55f33a8C4B3f3`
    * **Pancake V3 (0.05%)**: `0xd974d59e30054cf1abeded0c9947b0d8baf90029`
    * **Uniswap V3 (0.05%)**: `0x7aea2e8a3843516afa07293a10ac8e49906dabd1`
    * **Uniswap V3 (0.3%)**: `0x8c7080564b5a792a33ef2fd473fba6364d5495e5`

* **APR 計算公式**：
    * `24h Fees = 24h Volume × Fee Tier`
    * `APR = (24h Fees / TVL) × 365`

---

## 3. 動態布林通道引擎 (BB Engine)
* **指標設定**：20 SMA / 1H Timeframe。
* **定量動態 k 值**：
    * **30D 年化波動率 < 40% (震盪市)**：$k = 1.8$。
    * **30D 年化波動率 ≥ 40% (趨勢市)**：$k = 2.5$。
* **Tick 轉換**：使用 `@uniswap/v3-sdk` 之 `TickMath` 並配合 `nearestUsableTick`。

---

## 4. 錢包監測與 Drift 分析 (Portfolio Analysis)
* **單一倉位結構**：$20k 全額投入，不設 Buffer 倉位。
* **Drift 門檻**：實際區間與建議區間重合度 < 80% 時，推播 `STRATEGY_DRIFT_WARNING`。

---

## 5. 最優複利算法 (EOQ Compounding)
* **觸發門檻**：`Threshold = sqrt(2 * P * G * Fee_Rate_24h)`。
* **訊號發送**：`Unclaimed Fees > Threshold` 時發送 `COMPOUND_SIGNAL`。

---

## 6. 風險管理與健康評分 (Health & Risk)
* **Health Score**：`Score = (Fee_Income / IL_Risk_Weight) * 100` (上限 100 分)。
* **IL Breakeven Days**：`Cumulative IL USD / (24h Fees / 24)` (以天數計)。
* **關鍵預警**：
    * **IL Breakeven Days > 30 天**：標記為 `RED_ALERT` (建議減倉)。
    * **Bandwidth > 2× 30D Avg**：標記為 `HIGH_VOLATILITY_AVOID` (建議觀望)。

---

## 7. 數據報告格式 (Telegram 範例)
每 5 分鐘或觸發預警時發送：

> **[2026-03-02 17:05] 最高 APR 池: Pancake 0.01% (APR 67.2%)**
> **建議 BB 區間**: 0.0298 – 0.0312 cbBTC/WETH
> **Unclaimed**: $12.4 | **IL**: -$8.7 | **Breakeven**: 14 天
> **Compound Signal**: ✅ Unclaimed $12.4 > Threshold $7.1
> **Health Score**: 94/100 | **Regime**: Low Vol

---

## 8. Phase 1：執行路線圖 (Roadmap)
1. **APR Scanner + Telegram Bot**：最優先實作，確保每天能實時看到報表與最高收益池。
2. **Backtester**：並行運作，跑 2025/06 ～ 2026/03 震盪行情驗證 IL 侵蝕率。
3. **策略校準**：根據回測結果，微調 $k$ 值切換閾值與非對稱偏置邏輯。

---

## 9. 測試與驗證 (Test & Validation)
* **離線回測**：加入 2 小時執行延遲模擬手動操作。
* **乾跑測試**：Bot 啟動 7 天不實盤，校準 Subgraph 數據延遲。
* **小規模實測**：$1,000 USD (5% 資本) 進行 14 天實盤流程測試。

---

## 10. 安全性備註 (Security Notes)
關於使用 `npm audit` 檢測出的相依套件漏洞 (如 `cookie`, `serialize-javascript`, `elliptic`, 等)：
* **無攻擊面 (No Attack Surface)**：本 Bot 為純背景 Node.js 執行腳本，無外部對接的 Web Server 接收 payload 或 cookie。
* **無動態合約編譯**：Bot 執行期間不會用到 `solc` 或測試套件 `mocha`，不會觸發相關 RCE 或任意目錄寫入風險。
* **無私鑰簽發操作**：目前定位為**純監測與本地推播**，未引入錢包私鑰進行鏈上寫入交易，因此牽涉 `elliptic` 之簽名問題在當前架構下風險為 0。故在純監測階段，可安全忽略這些升級警告。