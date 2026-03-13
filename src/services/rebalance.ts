import { BBResult } from '../types';
import { createServiceLogger } from '../utils/logger';
import { config } from '../config';
import { RebalanceSuggestion } from '../types';

export type { RebalanceSuggestion };

const log = createServiceLogger('RebalanceService');

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
        token1Symbol: string,
        gasCostUSD?: number,
        bbLowerAdj?: number,   // decimal-adjusted lower BB price (pos.bbMinPrice)
        bbUpperAdj?: number,   // decimal-adjusted upper BB price (pos.bbMaxPrice)
    ): RebalanceSuggestion | null {
        try {
            const gasCost = gasCostUSD ?? config.REBALANCE_GAS_COST_USD;

            // 方向性偏移：以 currentPrice 相對 SMA 的偏差方向決定單邊建倉中心點偏移量
            // sd = 1σ 價格標準差（由 BB 帶寬反推）；offset = 0.3σ × 方向
            const sd = currentBB.k > 0 ? (currentBB.upperPrice - currentBB.sma) / currentBB.k : 0;
            const sdOffset = 0.3 * sd * (currentPrice > currentBB.sma ? 1 : -1);

            // 步驟 1: 計算超出百分比 (driftPercent)
            // 使用 decimal-adjusted 的 BB 邊界（與 currentPrice 同單位），
            // 避免與 BBResult.upperPrice/lowerPrice（raw tick-ratio）或 minPriceRatio/maxPriceRatio（USD）混用。
            const bbLower = bbLowerAdj ?? 0;
            const bbUpper = bbUpperAdj ?? 0;
            if (bbLower === 0 || bbUpper === 0) return null; // BB 尚未就緒
            let driftPercent = 0;
            if (currentPrice > bbUpper) {
                driftPercent = ((currentPrice - bbUpper) / bbUpper) * 100;
            } else if (currentPrice < bbLower) {
                driftPercent = ((bbLower - currentPrice) / bbLower) * 100 * -1;
            }
            if (Math.abs(driftPercent) < config.REBALANCE_DRIFT_MIN_PCT) return null;

            // 步驟 2: 產生新 BB 區間 (shallow copy 避免 mutate appState.bbs 裡的 BBResult)
            const newBB = { ...currentBB };

            // 步驟 3: 決定推薦策略 (基於超出程度 + Breakeven + EOQ)
            let recommendedStrategy: RebalanceSuggestion['recommendedStrategy'] = 'wait';
            let strategyName = '';
            let notes = '';

            const threshold = config.EOQ_THRESHOLD; // 你的 EOQ Threshold

            if (Math.abs(driftPercent) < config.REBALANCE_WAIT_DRIFT_PCT && breakevenDays < config.REBALANCE_WAIT_BREAKEVEN_DAYS) {
                recommendedStrategy = 'wait';
                strategyName = '等待回歸';
                notes = '超出小，等待價格回歸（零成本，IL 無鎖定）';
            } else if (Math.abs(driftPercent) < config.REBALANCE_DCA_DRIFT_PCT && unclaimedFeesUSD > threshold) {

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
                    // SD offset：強勢時中心上移 0.3σ，弱勢時下移 0.3σ，讓接盤區間更貼近均值回歸路徑
                    remainingToken = token1Symbol;
                    singleSideMin = newBB.minPriceRatio;
                    singleSideMax = newBB.sma + sdOffset;
                    // 必須嚴格保證上限低於市價，否則立刻需要另一邊代幣
                    if (singleSideMax >= currentPrice) {
                        singleSideMax = currentPrice * config.REBALANCE_PRICE_UPPER_MARGIN;
                    }
                } else {
                    // 價格跌過頭 (向下飄移)，我們手上 100% 都是 Token0 (Base，通常為 cbBTC 等)
                    // 策略：用手上的 Token0 在市價「上方」賣出，等待價格漲回均線 (SMA)
                    // SD offset：弱勢時中心下移 0.3σ（賣單下移，更積極），強勢時上移（更保守）
                    remainingToken = token0Symbol;
                    singleSideMin = newBB.sma + sdOffset;
                    singleSideMax = newBB.maxPriceRatio;
                    // 必須嚴格保證下限高於市價
                    if (singleSideMin <= currentPrice) {
                        singleSideMin = currentPrice * config.REBALANCE_PRICE_LOWER_MARGIN;
                    }
                }

                // 划算性檢查：Gas 超過 Unclaimed × 50% 時降級為等待
                if (unclaimedFeesUSD <= gasCost * 2) {
                    recommendedStrategy = 'wait';
                    strategyName = '等待回歸';
                    notes = `再平衡 Gas ($${gasCost.toFixed(2)}) 超過 Unclaimed Fees 的一半，等待費用累積後再操作`;
                    newBB.minPriceRatio = currentBB.minPriceRatio;
                    newBB.maxPriceRatio = currentBB.maxPriceRatio;
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

            const estGasCost = recommendedStrategy === 'withdrawSingleSide' ? gasCost : 0;

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