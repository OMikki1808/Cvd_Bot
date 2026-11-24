import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppLogger } from "../logging/logger.js";
import type { NetTrade } from "../portfolio/paperPortfolio.js";

export interface AccountRow {
  startingEquity: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
}

/**
 * SQLite persistence: engine state per symbol, shared paper account, idempotent
 * close ledger (UNIQUE setup_id + exit_time) and an event journal.
 */
export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(path: string, logger: AppLogger) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS engine_state (
        symbol TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS closed_trades (
        setup_id TEXT NOT NULL,
        exit_time INTEGER NOT NULL,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        entry_time INTEGER NOT NULL,
        entry REAL NOT NULL,
        stop REAL NOT NULL,
        take_profit REAL NOT NULL,
        exit_price REAL NOT NULL,
        qty REAL NOT NULL,
        outcome TEXT NOT NULL,
        fill_reason TEXT NOT NULL,
        pnl REAL NOT NULL,
        fees REAL NOT NULL,
        slippage REAL NOT NULL,
        net_pnl REAL NOT NULL,
        equity_after REAL NOT NULL,
        PRIMARY KEY (setup_id, exit_time)
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        symbol TEXT,
        payload TEXT NOT NULL
      );
    `);
    logger.info({ path }, "database_initialized");
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  loadAccount(): AccountRow | null {
    const raw = this.getMeta("paper_account_v1");
    return raw ? (JSON.parse(raw) as AccountRow) : null;
  }

  saveAccount(a: AccountRow): void {
    this.setMeta("paper_account_v1", JSON.stringify(a));
  }

  loadEngineState(symbol: string): unknown | null {
    const row = this.db.prepare("SELECT state_json FROM engine_state WHERE symbol = ?").get(symbol) as
      | { state_json: string }
      | undefined;
    return row ? JSON.parse(row.state_json) : null;
  }

  saveEngineState(symbol: string, state: unknown): void {
    this.db
      .prepare(
        "INSERT INTO engine_state (symbol, state_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at",
      )
      .run(symbol, JSON.stringify(state), Date.now());
  }

  /**
   * Records a close and the resulting account in one transaction.
   * Returns false if this close was already recorded (replayed bar).
   */
  recordClose(t: NetTrade, account: AccountRow): boolean {
    this.db.exec("BEGIN");
    try {
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO closed_trades (setup_id, exit_time, symbol, side, entry_time, entry, stop, take_profit,
            exit_price, qty, outcome, fill_reason, pnl, fees, slippage, net_pnl, equity_after)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          t.setupId,
          t.exitTime,
          t.symbol,
          t.side,
          t.entryTime,
          t.entry,
          t.stop,
          t.takeProfit,
          t.exitPrice,
          t.qty,
          t.outcome,
          t.fillReason,
          t.pnl,
          t.fees,
          t.slippage,
          t.netPnl,
          t.portfolioEquityAfter,
        );
      const applied = Number(res.changes) > 0;
      if (applied) {
        this.saveAccount(account);
      }
      this.db.exec("COMMIT");
      return applied;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  insertEvent(kind: string, symbol: string | null, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, symbol, payload) VALUES (?, ?, ?, ?)")
      .run(Date.now(), kind, symbol, JSON.stringify(payload));
  }

  close(): void {
    this.db.close();
  }
}
