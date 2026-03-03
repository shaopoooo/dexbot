import { config } from './src/config';
import axios from 'axios';

// 貼上你 config.ts 裡的 Uniswap Base Subgraph URL
const UNISWAP_URL = config.SUBGRAPHS.Uniswap;
const TARGET_POOL = '0x8c7080564b5a792a33ef2fd473fba6364d5495e5'.toLowerCase();

async function run() {
    console.log(`🔍 正在肉搜 Messari Subgraph 中的池子: ${TARGET_POOL}\n`);

    // ==========================================
    // 測試 1：池子到底存不存在於 liquidityPools？
    // ==========================================
    try {
        console.log('--- 測試 1: 尋找 LiquidityPool 本體 ---');
        const q1 = `{
            liquidityPool(id: "${TARGET_POOL}") {
                id
                name
                totalValueLockedUSD
            }
        }`;
        const res1 = await axios.post(UNISWAP_URL, { query: q1 });
        if (res1.data?.data?.liquidityPool) {
            console.log(`✅ 找到池子本體！名稱: ${res1.data.data.liquidityPool.name}`);
            console.log(`💰 TVL: $${parseFloat(res1.data.data.liquidityPool.totalValueLockedUSD).toFixed(2)}\n`);
        } else {
            console.error(`❌ 找不到池子本體！這代表 Subgraph 可能沒有收錄這個 0.3% 的池子，或是 ID 不是這個地址。\n`);
        }
    } catch (e: any) { console.error(e.message); }

    // ==========================================
    // 測試 2：使用 id_starts_with 強制撈出 Snapshot
    // ==========================================
    try {
        console.log('--- 測試 2: 使用 id_starts_with 繞過關聯 ---');
        const q2 = `{
            liquidityPoolDailySnapshots(first: 3, orderBy: timestamp, orderDirection: desc, where: { id_starts_with: "${TARGET_POOL}" }) {
                id
                timestamp
                dailyVolumeUSD
            }
        }`;
        const res2 = await axios.post(UNISWAP_URL, { query: q2 });
        const days = res2.data?.data?.liquidityPoolDailySnapshots ?? [];
        if (days.length > 0) {
            console.log(`✅ 成功撈到 ${days.length} 筆資料！原來是要用 id_starts_with！`);
            console.log(`第一筆的 ID 長這樣: ${days[0].id}\n`);
        } else {
            console.error(`❌ id_starts_with 也撈不到資料。\n`);
        }
    } catch (e: any) { console.error(e.message); }

    // ==========================================
    // 測試 3：隨便抓全網最近的 3 筆，看長什麼樣子
    // ==========================================
    try {
        console.log('--- 測試 3: 盲測全網最新 3 筆 Snapshot ---');
        const q3 = `{
            liquidityPoolDailySnapshots(first: 3, orderBy: timestamp, orderDirection: desc) {
                id
                pool { id }
                dailyVolumeUSD
            }
        }`;
        const res3 = await axios.post(UNISWAP_URL, { query: q3 });
        const randomDays = res3.data?.data?.liquidityPoolDailySnapshots ?? [];
        if (randomDays.length > 0) {
            console.log(`✅ 盲測成功！Subgraph 是活著的。看看別人家的資料長怎樣：`);
            randomDays.forEach((d: any, i: number) => {
                console.log(`   [${i}] Snapshot ID: ${d.id} | Pool ID: ${d.pool?.id} | Vol: $${parseFloat(d.dailyVolumeUSD).toFixed(2)}`);
            });
            console.log(`\n💡 如果 Pool ID 是大寫，或格式很奇怪，請把這段貼給我看！`);
        } else {
            console.error(`❌ 盲測失敗，整個資料庫的 Snapshot 都是空的。這代表這個 Subgraph 壞了或還在同步。\n`);
        }
    } catch (e: any) { console.error(e.message); }
}

run();