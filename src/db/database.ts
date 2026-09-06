import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AppLogger } from "../logging/logger.js";

export class AppDatabase {
  private readonly db: DatabaseSync;

  constructor(
    path: string,
    private readonly logger: AppLogger,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        side TEXT NOT NULL,
        quantity TEXT NOT NULL,
        entry TEXT NOT NULL,
        stop_loss TEXT NOT NULL,
        take_profit TEXT NOT NULL,
        rr TEXT NOT NULL,
        exit TEXT,
        pnl TEXT,
        reason TEXT,
        opened_at INTEGER NOT NULL,
        closed_at INTEGER,
        signal_candle_open_time INTEGER NOT NULL,
        cvd TEXT,
        divergence_kind TEXT,
        absorption_kind TEXT,
        raw_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        symbol TEXT,
        payload TEXT NOT NULL
      );
    `);
    this.logger.info({ path: "sqlite" }, "database_initialized");
  }

  insertTrade(row: {
    id: string;
    symbol: string;
    side: string;
    quantity: string;
    entry: string;
    stopLoss: string;
    takeProfit: string;
    rr: string;
    openedAt: number;
    signalCandleOpenTime: number;
    cvd: string;
    divergenceKind: string;
    absorptionKind: string;
    rawJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO trades (
          id, symbol, side, quantity, entry, stop_loss, take_profit, rr,
          opened_at, signal_candle_open_time, cvd, divergence_kind, absorption_kind, raw_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.symbol,
        row.side,
        row.quantity,
        row.entry,
        row.stopLoss,
        row.takeProfit,
        row.rr,
        row.openedAt,
        row.signalCandleOpenTime,
        row.cvd,
        row.divergenceKind,
        row.absorptionKind,
        row.rawJson,
      );
  }

  closeTrade(id: string, exit: string, pnl: string, reason: string, closedAt: number): void {
    this.db
      .prepare(`UPDATE trades SET exit = ?, pnl = ?, reason = ?, closed_at = ? WHERE id = ?`)
      .run(exit, pnl, reason, closedAt, id);
  }

  insertEvent(kind: string, symbol: string | null, payload: unknown): void {
    this.db
      .prepare(`INSERT INTO events (ts, kind, symbol, payload) VALUES (?, ?, ?, ?)`)
      .run(Date.now(), kind, symbol, JSON.stringify(payload));
  }

  listOpenTradeIds(): string[] {
    const rows = this.db.prepare(`SELECT id FROM trades WHERE closed_at IS NULL`).all() as { id: string }[];
    return rows.map((r) => r.id);
  }

  close(): void {
    this.db.close();
  }
}
