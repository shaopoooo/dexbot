import { BBEngine, BBResult } from './BBEngine';
import { createServiceLogger } from '../utils/logger';
import { config } from '../config';

const log = createServiceLogger('RebalanceService');

export interface RebalanceSuggestion {
    newMinPrice: number;
    newMaxPrice: number;
    recommendedStrategy: 'wait' | 'dca' | 'withdrawSingleSide' | 'avoidSwap';
    strategyName: string; // 中文策略名稱
    driftPercent: number; // 超出百分比
    estGasCost: number; // 估算 Gas USD
    notes: string; // 推薦說明
}

/**
 * 計算在特定區間 [P_lower, P_upper] 下，當前價格 P_current 所需的 Token0 與 Token1 價值比例
 * 公式基於 Uniswap V3 流動性數學 (sqrtPrice)
 * @returns { token0Weight: number, token1Weight: number } (兩者相加為 1)
 */
function calculateV3TokenValueRatio(currentPrice: number, lowerPrice: number, upperPrice: number): { token0Weight: number, token1Weight: number } {
    // 如果當前價格超出區間，則全為單一資產
    if (currentPrice <= lowerPrice) {
        return { token0Weight: 1, token1Weight: 0 }; // 跌破下限，全倉 Token0
    }
    if (currentPrice >= upperPrice) {
        return { token0Weight: 0, token1Weight: 1 }; // 漲破上限，全倉 Token1
    }

    // 計算 sqrt 價格
    const sqrtP = Math.sqrt(currentPrice);
    const sqrtP_L = Math.sqrt(lowerPrice);
    const sqrtP_U = Math.sqrt(upperPrice);

    // 取得虛擬流動性 L 的代幣數量公式 (假設 L = 1)
    // Amount0 = L * (sqrtP_U - sqrtP) / (sqrtP * sqrtP_U)
    // Amount1 = L * (sqrtP - sqrtP_L)
    const amount0 = (sqrtP_U - sqrtP) / (sqrtP * sqrtP_U);
    const amount1 = sqrtP - sqrtP_L;

    // 換算成價值 (Value = Amount * Price)
    // 注意此處以 Token1 為計價本位 (Price = Token1 / Token0)
    const value0 = amount0 * currentPrice;
    const value1 = amount1; // amount1 已經是計價貨幣

    const totalValue = value0 + value1;
    if (totalValue === 0) return { token0Weight: 0.5, token1Weight: 0.5 }; // Fallback

    return {
        token0Weight: value0 / totalValue,
        token1Weight: value1 / totalValue
    };
}

/**
 * Rebalance Service: 偵測超出後，提供新點位建議 + 策略推薦
 * 只計算，不執行交易
 */
export class RebalanceService {
    /**
     * 計算 rebalance 建議
     * @param currentPrice 池子即時價格 (from slot0)
     * @param currentBB 當前 BBResult
     * @param poolAddress 池子地址
     * @param dex DEX 名
     * @param tickSpacing tick 間距
     * @param currentTick 當前 tick
     * @param unclaimedFeesUSD 未領取 Fees USD (for EOQ)
     * @param breakevenDays 當前 Breakeven Days
     */
    static getRebalanceSuggestion(
        currentPrice: number,
        currentBB: BBResult,
        unclaimedFeesUSD: number,
        breakevenDays: number,
        positionValueUSD: number,
        token0Symbol: string,
        token1Symbol: string
    ): RebalanceSuggestion | null {
        try {
            // 步驟 1: 計算超出百分比 (driftPercent)
            let driftPercent = 0;
            if (currentPrice > currentBB.maxPriceRatio) {
                driftPercent = ((currentPrice - currentBB.maxPriceRatio) / currentBB.maxPriceRatio) * 100;
            } else if (currentPrice < currentBB.minPriceRatio) {
                driftPercent = ((currentBB.minPriceRatio - currentPrice) / currentBB.minPriceRatio) * 100 * -1; // 負值表示下超出
            }
            if (Math.abs(driftPercent) < 5) return null; // <5% 不觸發

            // 步驟 2: 產生新 BB 區間 (不需要重複跑 BBEngine，因為 currentBB 已經包含了基於當前 tick/時間算出的最新點位建議)
            const newBB = currentBB;

            // 步驟 3: 決定推薦策略 (基於超出程度 + Breakeven + EOQ)
            let recommendedStrategy: RebalanceSuggestion['recommendedStrategy'] = 'wait';
            let strategyName = '';
            let notes = '';

            const threshold = config.EOQ_THRESHOLD; // 你的 EOQ Threshold

            if (Math.abs(driftPercent) < 10 && breakevenDays < 15) {
                recommendedStrategy = 'wait';
                strategyName = '等待回歸';
                notes = '超出小，等待價格回歸（零成本，IL 無鎖定）';
            } else if (Math.abs(driftPercent) < 20 && unclaimedFeesUSD > threshold) {
                recommendedStrategy = 'dca';
                strategyName = 'DCA 定投平衡';
                // 為了完美補齊倉位，我們需要精算 BBEngine 建議的新區間 (newBB) 實際上需要多少的 Token0/Token1 比例
                const targetRatio = calculateV3TokenValueRatio(currentPrice, newBB.minPriceRatio, newBB.maxPriceRatio);

                // 判斷哪邊資產過少 (Drift 超出邊界代表原倉位被強制換幣了)
                // 如果向上飄移 (drift > 0)，價格上漲，V3 會把 Token0 賣成 Token1，所以我們缺少 Token0
                let actionToken = driftPercent > 0 ? token0Symbol : token1Symbol;
                let deficitRatio = driftPercent > 0 ? targetRatio.token0Weight : targetRatio.token1Weight;

                // 買入量 = 總倉位所需資本 * 該代幣的目標權重
                // 在這裡把 drift 視為 100% 全失衡狀態下的精準修補
                const targetRebalanceValueUSD = positionValueUSD * deficitRatio;

                notes = `偏離中，為了能精準補入新 BB 區間 ${newBB.minPriceRatio.toFixed(6)} - ${newBB.maxPriceRatio.toFixed(6)}：\n`;
                notes += `   新區間需資金比例 ${actionToken} 佔 ${(deficitRatio * 100).toFixed(1)}%。\n`;
                notes += `   推薦定投買入約 $${targetRebalanceValueUSD.toFixed(2)} USD 的 ${actionToken} 來精準填補，再加回 LP。`;
            } else {
                recommendedStrategy = 'withdrawSingleSide';
                strategyName = '撤資單邊建倉';

                // 動態單邊建倉邏輯：
                // 1. 判斷我們手上現在滿倉的是什麼代幣
                // 2. 劃定一個「完全低於市價」或「完全高於市價」的區間來掛單等待回歸
                let singleSideMin = 0;
                let singleSideMax = 0;
                let remainingToken = '';

                if (driftPercent > 0) {
                    // 價格漲過頭 (向上飄移)，我們手上 100% 都是 Token1 (Quote，通常為 WETH 或 USDC)
                    // 策略：用手上的 Token1 在市價「下方」接盤，等待價格跌回均線 (SMA)
                    remainingToken = token1Symbol;
                    singleSideMin = newBB.minPriceRatio;
                    singleSideMax = newBB.sma;
                    // 必須嚴格保證上限低於市價，否則立刻需要另一邊代幣
                    if (singleSideMax >= currentPrice) {
                        singleSideMax = currentPrice * 0.9999;
                    }
                } else {
                    // 價格跌過頭 (向下飄移)，我們手上 100% 都是 Token0 (Base，通常為 cbBTC 等)
                    // 策略：用手上的 Token0 在市價「上方」賣出，等待價格漲回均線 (SMA)
                    remainingToken = token0Symbol;
                    singleSideMin = newBB.sma;
                    singleSideMax = newBB.maxPriceRatio;
                    // 必須嚴格保證下限高於市價
                    if (singleSideMin <= currentPrice) {
                        singleSideMin = currentPrice * 1.0001;
                    }
                }

                notes = `偏離過大，建議撤出原 LP 剩餘資產 (目前 100% 為 ${remainingToken})，\n`;
                notes += `   並以「單邊流動性」的方式（不需額外補錢）建立回歸接盤區間：\n`;
                notes += `   🎯 目標重組區間：${singleSideMin.toFixed(6)} - ${singleSideMax.toFixed(6)}\n`;
                notes += `   (💡 此舉等同於掛一個 ${remainingToken} 的區間網格單，等待價格均值回歸。至於 IL，由於缺乏你當初的精確建倉價格與歷史提領數據，系統暫時無法從鏈上回推你的真實 IL 絕對美元值，需仰賴未來實裝的資料庫套件。)`;

                // Override new limits for UI displaying
                newBB.minPriceRatio = singleSideMin;
                newBB.maxPriceRatio = singleSideMax;
            }

            // 永遠避免直接兌換
            notes += '。注意：不建議直接 ETH 換 BTC（低賣高買，IL 高）';

            // 估 Gas (Base 單次 rebalance ≈ $0.1)
            const estGasCost = recommendedStrategy === 'withdrawSingleSide' ? 0.1 : 0;

            return {
                newMinPrice: newBB.minPriceRatio,
                newMaxPrice: newBB.maxPriceRatio,
                recommendedStrategy,
                strategyName,
                driftPercent,
                estGasCost,
                notes
            };
        } catch (error) {
            log.error(`Rebalance suggestion error: ${error}`);
            return null;
        }
    }
}