export const env = {
    RPC_URL: process.env.RPC_URL || 'https://mainnet.base.org',
    WALLET_ADDRESSES: (() => {
        const wallets: string[] = [];
        let i = 1;
        while (process.env[`WALLET_ADDRESS_${i}`]) {
            wallets.push(process.env[`WALLET_ADDRESS_${i}`]!.trim());
            i++;
        }
        return wallets;
    })(),
    SUBGRAPH_API_KEY: process.env.SUBGRAPH_API_KEY || '',
    BOT_TOKEN: process.env.BOT_TOKEN || '',
    CHAT_ID: process.env.CHAT_ID || '',

    // 初始投入本金：INITIAL_INVESTMENT_<tokenId>=<USD>
    INITIAL_INVESTMENT_USD: (() => {
        const map: Record<string, number> = {};
        for (const [key, val] of Object.entries(process.env)) {
            if (key.startsWith('INITIAL_INVESTMENT_') && val) {
                map[key.replace('INITIAL_INVESTMENT_', '')] = parseFloat(val);
            }
        }
        return map;
    })(),

    // 手動追蹤鎖倉 TokenId：TRACKED_TOKEN_<tokenId>=<Uniswap|PancakeSwap|Aerodrome>
    TRACKED_TOKEN_IDS: (() => {
        const map: Record<string, 'Uniswap' | 'PancakeSwap' | 'Aerodrome'> = {};
        for (const [key, val] of Object.entries(process.env)) {
            if (key.startsWith('TRACKED_TOKEN_') && val) {
                map[key.replace('TRACKED_TOKEN_', '')] = val as 'Uniswap' | 'PancakeSwap' | 'Aerodrome';
            }
        }
        return map;
    })(),
};

/** 驗證必填環境變數，缺少時輸出錯誤並中止程式 */
export function validateEnv(): void {
    const missing: string[] = [];
    if (!process.env.BOT_TOKEN)       missing.push('BOT_TOKEN');
    if (!process.env.CHAT_ID)         missing.push('CHAT_ID');
    if (!process.env.WALLET_ADDRESS_1) missing.push('WALLET_ADDRESS_1');
    if (missing.length > 0) {
        console.error(`[env] 缺少必填環境變數: ${missing.join(', ')}\n請確認 .env 檔案或部署環境的環境變數設定。`);
        process.exit(1);
    }
}
