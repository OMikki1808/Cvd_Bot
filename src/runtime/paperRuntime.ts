/**
 * Live PAPER runtime: Binance SPOT 15m stream -> per-symbol 082F engines ->
 * shared paper portfolio. Modeled on CVDBot-prodaction
 * BinanceSignalBinanceMarginPaperRuntime, with these differences:
 *   - every bar is processed through one serial queue (no interleaving);
 *   - engine state + account are persisted after every bar and restored on start;
 *   - gaps (startup, reconnect, missed WS message) are refilled from REST;
 *     replayed bars run in recovery mode (no brand-new setups, existing
 *     orders/positions still progress), exactly like the Python runtime;
 *   - processing errors are logged and the symbol is resynced on the next bar
 *     instead of crashing the process;
 *   - fees/slippage/leverage caps come from the shared PaperPortfolio.
 */

import type { AppConfig } from "../config/schema.js";
import type { AppDatabase } from "../db/database.js";
import type { AppLogger } from "../logging/logger.js";
import { BinanceKlineStream, BinanceSpotRest, latestClosed15mOpen, MIN15 } from "../exchange/binanceSpot.js";
import { PaperPortfolio, type NetTrade } from "../portfolio/paperPortfolio.js";
import type { Bar15m, EngineEvent, EngineState } from "../strategy/engine082f.js";
import { formatEvent, type Notifier } from "../telegram/telegramNotifier.js";
import { sleep } from "../retry/retry.js";

type BarStatus = "accepted" | "duplicate" | "out_of_order" | "gap";

export class PaperRuntime {
  readonly portfolio: PaperPortfolio;
  private queue: Promise<void> = Promise.resolve();
  private silent = false;
  private stopped = false;
  private reconnectAttempt = 0;
  private readonly needsResync = new Set<string>();

  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly db: AppDatabase,
    private readonly rest: Pick<BinanceSpotRest, "fetch15mRange" | "assertSymbolsTrading">,
    private readonly stream: Pick<BinanceKlineStream, "connect" | "disconnect">,
    private readonly notifier: Notifier,
    private readonly clock: () => number = Date.now,
  ) {
    this.portfolio = new PaperPortfolio({
      symbolRr: config.symbolRr,
      startingEquity: config.startingEquity,
      riskPercent: config.riskPercent,
      costs: { takerFeeBps: config.takerFeeBps, makerFeeBps: config.makerFeeBps, slippageBps: config.slippageBps },
      limits: {
        maxActivePositions: config.maxActivePositions,
        maxPositionLeverage: config.maxPositionLeverage,
        maxTotalLeverage: config.maxTotalLeverage,
        leverageMode: config.leverageMode,
      },
      checkExitsAfterImmediateFill: config.checkExitsAfterImmediateFill,
      immediateFillAtMarket: config.immediateFillAtMarket,
      entryMode: config.entryMode,
      trendFilterHours: config.trendFilterHours,
      minStopPct: config.minStopPct,
      closeLedger: (t) =>
        this.db.recordClose(t, {
          startingEquity: this.config.startingEquity,
          equity: t.portfolioEquityAfter,
          peakEquity: Math.max(this.portfolio.peakEquity, t.portfolioEquityAfter),
          maxDrawdown: this.portfolio.maxDrawdown,
        }),
      onEvent: (e) => this.onEngineEvent(e),
    });
  }

  async start(): Promise<void> {
    await this.rest.assertSymbolsTrading(this.portfolio.symbols);
    this.restoreAccount();
    this.restoreEngines();
    this.silent = true;
    try {
      for (const symbol of this.portfolio.symbols) {
        await this.recoverToLatest(symbol, "startup");
      }
    } finally {
      this.silent = false;
    }
    this.logger.info(
      {
        symbols: this.portfolio.symbols.length,
        equity: this.portfolio.equity,
        openPositions: this.portfolio.openPositions(),
        pool: this.config.poolVersion,
      },
      "runtime_started",
    );
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stream.disconnect();
    await this.queue;
    this.persistAll();
  }

  private connect(): void {
    if (this.stopped) return;
    this.stream.connect(this.portfolio.symbols, {
      onClosedBar: (symbol, bar) => this.enqueue(() => this.onLiveBar(symbol, bar)),
      onDisconnected: (reason) => void this.reconnect(reason),
    });
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.stopped) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5));
    this.logger.warn({ reason, attempt: this.reconnectAttempt, delay }, "ws_reconnecting");
    await sleep(delay);
    this.stream.disconnect();
    this.enqueue(async () => {
      for (const symbol of this.portfolio.symbols) {
        await this.recoverToLatest(symbol, "reconnect");
      }
      this.reconnectAttempt = 0;
    });
    await this.queue;
    this.connect();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue.then(task).catch((err: unknown) => {
      this.logger.error({ err }, "runtime_task_failed");
    });
  }

  private async onLiveBar(symbol: string, bar: Bar15m): Promise<void> {
    if (!this.portfolio.engines.has(symbol)) return;
    if (this.needsResync.has(symbol)) {
      await this.recoverToLatest(symbol, "resync_after_error");
    }
    const status = this.processBar(symbol, bar, false, "ws");
    if (status === "gap") {
      const last = this.portfolio.engines.get(symbol)?.last15mOpenTime ?? null;
      if (last !== null) {
        await this.recoverRange(symbol, last + MIN15, bar.openTime - MIN15, "ws_gap");
      }
      this.processBar(symbol, bar, false, "ws_after_gap");
    }
  }

  private processBar(symbol: string, bar: Bar15m, recovery: boolean, source: string): BarStatus {
    const engine = this.portfolio.engines.get(symbol);
    if (!engine) return "out_of_order";
    const last = engine.last15mOpenTime;
    if (last !== null) {
      if (bar.openTime < last) {
        this.logger.warn({ symbol, source, openTime: bar.openTime, last }, "bar_out_of_order");
        return "out_of_order";
      }
      if (bar.openTime === last) return "duplicate";
      if (bar.openTime - last !== MIN15) return "gap";
    }
    engine.setRecoveryMode(recovery);
    try {
      this.portfolio.on15mBar(symbol, bar);
      this.needsResync.delete(symbol);
    } catch (err) {
      // Roll the engine back to the last persisted state; the next bar resyncs from REST.
      this.needsResync.add(symbol);
      this.logger.error({ err, symbol, source, openTime: bar.openTime }, "bar_processing_failed");
      const saved = this.db.loadEngineState(symbol);
      if (saved) engine.loadState(saved as EngineState);
      this.portfolio.syncEngines();
      return "out_of_order";
    } finally {
      engine.setRecoveryMode(false);
    }
    this.db.saveEngineState(symbol, engine.dumpState());
    this.saveAccount();
    return "accepted";
  }

  private async recoverToLatest(symbol: string, context: string): Promise<void> {
    const engine = this.portfolio.engines.get(symbol);
    if (!engine) return;
    const end = latestClosed15mOpen(this.clock());
    const last = engine.last15mOpenTime;
    const start = last === null ? end - this.config.warmupDays * 96 * MIN15 + MIN15 : last + MIN15;
    if (start > end) return;
    await this.recoverRange(symbol, start, end, last === null ? "warmup_seed" : context);
  }

  private async recoverRange(symbol: string, start: number, end: number, context: string): Promise<void> {
    if (end < start) return;
    const bars = await this.rest.fetch15mRange(symbol, start, end);
    let accepted = 0;
    const wasSilent = this.silent;
    this.silent = true;
    try {
      for (const b of bars) {
        if (this.processBar(symbol, b, true, `rest:${context}`) === "accepted") accepted += 1;
      }
    } finally {
      this.silent = wasSilent;
    }
    const expected = Math.floor((end - start) / MIN15) + 1;
    const level = accepted === expected ? "info" : "warn";
    this.logger[level]({ symbol, context, accepted, expected }, "gap_recovery");
  }

  private restoreAccount(): void {
    const acc = this.db.loadAccount();
    if (acc) {
      if (acc.startingEquity !== this.config.startingEquity) {
        this.logger.warn(
          { stored: acc.startingEquity, config: this.config.startingEquity },
          "PAPER_STARTING_EQUITY ignored: resuming stored paper account",
        );
      }
      this.portfolio.equity = acc.equity;
      this.portfolio.peakEquity = acc.peakEquity;
      this.portfolio.maxDrawdown = acc.maxDrawdown;
    } else {
      this.saveAccount();
    }
    this.portfolio.syncEngines();
  }

  private restoreEngines(): void {
    for (const [symbol, engine] of this.portfolio.engines) {
      const state = this.db.loadEngineState(symbol);
      if (!state) continue;
      try {
        engine.loadState(state as EngineState);
        this.logger.info(
          { symbol, last15m: engine.last15mOpenTime, position: !!engine.position, pending: !!engine.pendingLimit },
          "engine_state_restored",
        );
      } catch (err) {
        this.logger.error({ err, symbol }, "engine_state_restore_failed_starting_fresh");
      }
    }
    this.portfolio.syncEngines();
  }

  private saveAccount(): void {
    this.db.saveAccount({
      startingEquity: this.config.startingEquity,
      equity: this.portfolio.equity,
      peakEquity: this.portfolio.peakEquity,
      maxDrawdown: this.portfolio.maxDrawdown,
    });
  }

  private persistAll(): void {
    for (const [symbol, engine] of this.portfolio.engines) {
      this.db.saveEngineState(symbol, engine.dumpState());
    }
    this.saveAccount();
  }

  private onEngineEvent(e: EngineEvent): void {
    let closed: NetTrade | undefined;
    if (e.type === "PositionClosed") {
      const last = this.portfolio.trades[this.portfolio.trades.length - 1];
      closed = last && last.setupId === e.trade.setupId && last.exitTime === e.trade.exitTime ? last : undefined;
    }
    const level = e.type === "DataUntrusted" || e.type === "EntryRejected" ? "warn" : "info";
    this.logger[level]({ ...e, silent: this.silent }, e.type);
    if (e.type !== "DivergenceDetected") {
      this.db.insertEvent(e.type, e.symbol, { ...e, recovery: this.silent });
    }
    if (!this.silent) {
      const text = formatEvent(e, this.portfolio.equity, closed);
      if (text) this.notifier.notify(text);
    }
  }
}
