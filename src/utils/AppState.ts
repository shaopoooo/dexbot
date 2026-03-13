/**
 * AppState — single source of truth for the three shared mutable arrays.
 *
 * Replaces the module-level `let latestPools / activePositions / latestBBs`
 * vars in index.ts. All pipeline functions read and write through this object
 * so it's easy to reason about data ownership and to mock in tests.
 */
import { PoolStats, PositionRecord, BBResult } from '../types';

class AppState {
    pools: PoolStats[] = [];
    positions: PositionRecord[] = [];
    bbs: Record<string, BBResult> = {};

    readonly lastUpdated = {
        poolScanner:     0,
        positionScanner: 0,
        bbEngine:        0,
        riskManager:     0,
    };

    /** Remove BB entries whose pools are no longer in activePositions. */
    pruneStaleBBs(): void {
        const active = new Set(this.positions.map(p => p.poolAddress.toLowerCase()));
        for (const k of Object.keys(this.bbs)) {
            if (!active.has(k)) delete this.bbs[k];
        }
    }
}

export const appState = new AppState();
