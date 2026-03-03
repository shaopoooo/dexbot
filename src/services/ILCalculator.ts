import { config } from '../config';

/**
 * Service to calculate Absolute USD Profit and Loss (Impermenant Loss + Fee Income PNL)
 * for a tracked LP Token ID based on user-provided initialization capital.
 */
export class ILCalculatorService {
    /**
     * Calculates the absolute USD PNL.
     * PNL IL = (Current Total Portfolio Value USD) - (Initial Invested Capital USD)
     * 
     * @param tokenId The LP NFT Token ID
     * @param livePositionValueUSD The live calculated USD value of the remaining tokens in the LP
     * @param totalCollectedAndUnclaimedFeesUSD All fees uncollected and collected to date
     * @returns { number } The absolute dollar PNL (can be positive or negative)
     */
    static calculateAbsolutePNL(
        tokenId: string,
        livePositionValueUSD: number,
        totalCollectedAndUnclaimedFeesUSD: number
    ): number | null {
        // 取得使用者當初登記的初始投資美金
        const initialInvestmentUSD = config.INITIAL_INVESTMENT_USD[tokenId];

        // 如果使用者沒有在設定黨填寫該 tokenId 的歷史本金，就無法計算 IL (Return null)
        if (typeof initialInvestmentUSD !== 'number' || initialInvestmentUSD === 0) {
            return null;
        }

        // 當前真正能拿回來的總資產價值 = 活體代幣現價價值 + 已經賺取與待領的手續費
        const currentTotalNetWorthUSD = livePositionValueUSD + totalCollectedAndUnclaimedFeesUSD;

        // 絕對收益 (PnL IL) = 現在總淨值 - 當初砸進去的錢
        const absolutePNL = currentTotalNetWorthUSD - initialInvestmentUSD;

        return absolutePNL;
    }
}
