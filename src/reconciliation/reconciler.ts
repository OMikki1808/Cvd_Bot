import type { PositionTracker } from "../positions/positionTracker.js";
import type { AppDatabase } from "../db/database.js";
import type { AppLogger } from "../logging/logger.js";

/**
 * PAPER reconciliation: open positions in memory must match open trades in SQLite.
 * LIVE would additionally fetch Binance positionRisk — not enabled until Before LIVE.
 */
export class Reconciler {
  constructor(
    private readonly db: AppDatabase,
    private readonly positions: PositionTracker,
    private readonly logger: AppLogger,
  ) {}

  reconcile(): { ok: boolean; issues: string[] } {
    const dbOpen = new Set(this.db.listOpenTradeIds());
    const memOpen = this.positions.allOpen();
    const issues: string[] = [];
    for (const p of memOpen) {
      if (!dbOpen.has(p.id)) {
        issues.push(`memory position ${p.id} missing in db`);
      }
    }
    const memIds = new Set(memOpen.map((p) => p.id));
    for (const id of dbOpen) {
      if (!memIds.has(id)) {
        issues.push(`db trade ${id} open but not in memory`);
      }
    }
    const ok = issues.length === 0;
    this.logger.info({ ok, issues }, "reconciliation");
    return { ok, issues };
  }
}
