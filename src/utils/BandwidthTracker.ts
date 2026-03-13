/**
 * BandwidthTracker — rolling 30D bandwidth window per pool
 *
 * 集中管理各池子的 bandwidth 滾動窗口，供 RiskManager.analyzePosition()
 * 取得 avg30DBandwidth 參數。與 state.json 持久化整合：snapshot / restore。
 */
import { config } from '../config';

class BandwidthTracker {
    private windows: Record<string, number[]> = {};

    /** 新增本次週期的 bandwidth，回傳目前窗口均值（即 avg30DBandwidth）。 */
    update(poolKey: string, currentBandwidth: number): number {
        if (!this.windows[poolKey]) this.windows[poolKey] = [];
        this.windows[poolKey].push(currentBandwidth);
        if (this.windows[poolKey].length > config.BANDWIDTH_WINDOW_MAX) {
            this.windows[poolKey].shift();
        }
        const win = this.windows[poolKey];
        return win.reduce((s, v) => s + v, 0) / win.length;
    }

    snapshot(): Record<string, number[]> {
        return { ...this.windows };
    }

    restore(saved: Record<string, number[]>): void {
        for (const [k, v] of Object.entries(saved)) {
            this.windows[k] = v;
        }
    }
}

export const bandwidthTracker = new BandwidthTracker();
