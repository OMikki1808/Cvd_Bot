/**
 * Shared-equity paper portfolio on top of per-symbol 082F engines.
 *
 * Mirrors CVDBot-prodaction BinanceSignalBinanceMarginPaperRuntime:
 *   - one shared equity; every engine sizes from it; realized PnL updates it;
 *   - max active positions (Python: 15, but there it crashes the process —
 *     here the entry is skipped instead).
 * Adds what the Python runtime does not model:
 *   - fees (bps of notional, both sides) and slippage (bps, on market-type exits);
 *   - optional per-position and total leverage caps.
 *
 * Used by both the backtester and the live PAPER runtime so they cannot drift.
 */

import {
  Engine082f,
  type Bar15m,
  type ClosedTrade,
  type EngineEvent,
  type EntryGuard,
  type EntryMode,
} from "../strategy/engine082f.js";

export interface CostModel {
  /** Taker fee, bps of notional: market entries and SL / reverse / EOD exits. */
  takerFeeBps: number;
  /** Maker fee, bps of notional: limit entries and TP (resting limit) exits. */
  makerFeeBps: number;
  /** Adverse slippage in bps on market-type exits (SL, reverse close, EOD). */
  slippageBps: number;
}

/** Binance VIP0 presets (no BNB discount). */
export const VENUE_COSTS: Record<string, CostModel> = {
  spot: { takerFeeBps: 10, makerFeeBps: 10, slippageBps: 5 },
  futures: { takerFeeBps: 5, makerFeeBps: 2, slippageBps: 5 },
  none: { takerFeeBps: 0, makerFeeBps: 0, slippageBps: 0 },
};

export interface RiskLimits {
  /** Max simultaneously open positions; 0 = unlimited. */
  maxActivePositions: number;
  /** Max notional of one position as a multiple of equity; 0 = unlimited (Python behaviour). */
  maxPositionLeverage: number;
  /** Max total open notional as a multiple of equity; 0 = unlimited. */
  maxTotalLeverage: number;
  /** "cap" shrinks qty to fit the leverage limits, "reject" skips the entry. */
  leverageMode: "cap" | "reject";
}

export interface PortfolioOptions {
  symbolRr: Record<string, number>;
  startingEquity: number;
  riskPercent: number;
  costs: CostModel;
  limits: RiskLimits;
  /** Each symbol gets its own equity (reproduces per-symbol research tables). */
  isolated?: boolean;
  checkExitsAfterImmediateFill?: boolean;
  immediateFillAtMarket?: boolean;
  entryMode?: EntryMode;
  trendFilterHours?: number;
  minStopPct?: number;
  onEvent?: (event: EngineEvent, portfolio: PaperPortfolio) => void;
  /**
   * Idempotent close ledger. Called before equity is updated; return false if this
   * close (same setupId + exitTime) was already applied, e.g. a bar replayed after
   * a crash — equity is then left untouched.
   */
  closeLedger?: (trade: NetTrade) => boolean;
}

export interface NetTrade extends ClosedTrade {
  fees: number;
  slippage: number;
  netPnl: number;
  portfolioEquityAfter: number;
}

export const NO_COSTS: CostModel = { takerFeeBps: 0, makerFeeBps: 0, slippageBps: 0 };
export const NO_LIMITS: RiskLimits = {
  maxActivePositions: 0,
  maxPositionLeverage: 0,
  maxTotalLeverage: 0,
  leverageMode: "cap",
};

const MARKET_EXITS = new Set(["SL", "SL&TP same bar -> SL", "Reverse divergence close", "EOD close"]);

export class PaperPortfolio {
  readonly engines = new Map<string, Engine082f>();
  equity: number;
  peakEquity: number;
  maxDrawdown = 0;
  feesPaid = 0;
  slippagePaid = 0;
  readonly trades: NetTrade[] = [];
  /** Per-symbol equity when `isolated` is on. */
  readonly isolatedEquity = new Map<string, number>();

  constructor(private readonly opts: PortfolioOptions) {
    this.equity = opts.startingEquity;
    this.peakEquity = opts.startingEquity;
    for (const [symbol, rr] of Object.entries(opts.symbolRr)) {
      const engine = new Engine082f({
        symbol,
        rrTarget: rr,
        riskPercent: opts.riskPercent,
        initialCapital: opts.startingEquity,
        checkExitsAfterImmediateFill: opts.checkExitsAfterImmediateFill ?? false,
        immediateFillAtMarket: opts.immediateFillAtMarket ?? false,
        entryMode: opts.entryMode ?? "limit1bar",
        trendFilterHours: opts.trendFilterHours ?? 0,
        minStopPct: opts.minStopPct ?? 0,
        entryGuard: this.guardFor(symbol),
        onEvent: (e) => this.onEngineEvent(e),
      });
      this.engines.set(symbol, engine);
      if (opts.isolated) {
        this.isolatedEquity.set(symbol, opts.startingEquity);
      }
    }
  }

  get symbols(): string[] {
    return [...this.engines.keys()];
  }

  openPositions(): number {
    let n = 0;
    for (const e of this.engines.values()) if (e.position) n += 1;
    return n;
  }

  openNotional(): number {
    let n = 0;
    for (const e of this.engines.values()) if (e.position) n += e.position.qty * e.position.entry;
    return n;
  }

  on15mBar(symbol: string, bar: Bar15m): void {
    const engine = this.engines.get(symbol);
    if (!engine) {
      throw new Error(`unknown symbol ${symbol}`);
    }
    if (!this.opts.isolated) {
      engine.equity = this.equity;
    }
    engine.on15mBar(bar);
  }

  flush(): void {
    for (const e of this.engines.values()) {
      if (!this.opts.isolated) e.equity = this.equity;
      e.flush();
    }
  }

  /** Re-sync engine equity after restoring state (shared mode). */
  syncEngines(): void {
    if (this.opts.isolated) return;
    for (const e of this.engines.values()) e.equity = this.equity;
  }

  private guardFor(symbol: string): EntryGuard | undefined {
    const { limits } = this.opts;
    if (!limits.maxActivePositions && !limits.maxPositionLeverage && !limits.maxTotalLeverage) {
      return undefined;
    }
    return ({ qty, entry, equity }) => {
      if (limits.maxActivePositions && this.openPositions() >= limits.maxActivePositions) {
        return { reject: "MAX_ACTIVE_POSITIONS" };
      }
      const eq = this.opts.isolated ? equity : this.equity;
      let maxNotional = Number.POSITIVE_INFINITY;
      if (limits.maxPositionLeverage) {
        maxNotional = Math.min(maxNotional, eq * limits.maxPositionLeverage);
      }
      if (limits.maxTotalLeverage && !this.opts.isolated) {
        maxNotional = Math.min(maxNotional, eq * limits.maxTotalLeverage - this.openNotional());
      }
      const notional = qty * entry;
      if (notional <= maxNotional) {
        return { qty };
      }
      if (limits.leverageMode === "reject" || maxNotional <= 0) {
        return { reject: `LEVERAGE_LIMIT ${symbol} notional=${notional.toFixed(2)} max=${maxNotional.toFixed(2)}` };
      }
      return { qty: maxNotional / entry };
    };
  }

  private onEngineEvent(event: EngineEvent): void {
    if (event.type === "PositionClosed") {
      this.applyClose(event.trade);
    }
    this.opts.onEvent?.(event, this);
  }

  private applyClose(t: ClosedTrade): void {
    const { takerFeeBps, makerFeeBps, slippageBps } = this.opts.costs;
    const entryBps = t.fillReason === "MARKET" ? takerFeeBps : makerFeeBps;
    const marketExit = MARKET_EXITS.has(t.outcome);
    const exitBps = marketExit ? takerFeeBps : makerFeeBps;
    const fees = (t.qty * t.entry * entryBps + t.qty * t.exitPrice * exitBps) / 10_000;
    const slippage = marketExit ? (t.qty * t.exitPrice * slippageBps) / 10_000 : 0;
    const netPnl = t.pnl - fees - slippage;
    if (this.opts.closeLedger) {
      const projected = this.opts.isolated
        ? (this.isolatedEquity.get(t.symbol) ?? 0) + netPnl
        : this.equity + netPnl;
      if (!this.opts.closeLedger({ ...t, fees, slippage, netPnl, portfolioEquityAfter: projected })) {
        this.syncEngines();
        return;
      }
    }
    this.feesPaid += fees;
    this.slippagePaid += slippage;

    let equityAfter: number;
    const engine = this.engines.get(t.symbol);
    if (this.opts.isolated) {
      equityAfter = (this.isolatedEquity.get(t.symbol) ?? 0) + netPnl;
      this.isolatedEquity.set(t.symbol, equityAfter);
      if (engine) engine.equity = equityAfter;
      this.equity += netPnl;
    } else {
      this.equity += netPnl;
      equityAfter = this.equity;
      this.syncEngines();
    }
    this.peakEquity = Math.max(this.peakEquity, this.equity);
    if (this.peakEquity > 0) {
      this.maxDrawdown = Math.max(this.maxDrawdown, (this.peakEquity - this.equity) / this.peakEquity);
    }
    this.trades.push({ ...t, fees, slippage, netPnl, portfolioEquityAfter: equityAfter });
  }
}
