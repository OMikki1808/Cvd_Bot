/**
 * 082F Engine-v2, limit entry with one-hour validity (V082F_ENGINE_V2_LIMIT_1BAR).
 *
 * 1:1 port of CVDBot-prodaction
 *   cvdbot/strategy/v082f_engine_v2_limit_1bar/engine.py
 *   (class RuntimeStrategy082FEngineV2Limit1Bar)
 *
 * Rules (decision timeframe 1H, built from four contiguous Binance SPOT 15m bars):
 *   - True CVD: delta = takerBuy - (volume - takerBuy), CVD = cumulative sum.
 *   - Fractal pivots left=3 / right=3 (unique extreme), known `right` bars later.
 *   - Bullish divergence: pivot low LL + CVD HL vs previous pivot low (strict).
 *     Bearish divergence: pivot high HH + CVD LH vs previous pivot high (strict).
 *   - Confirmation: candle right after the divergence (pivot) candle.
 *     long:  close[pivot+1] > open[pivot];  short: close[pivot+1] < open[pivot].
 *   - On confirmation: LIMIT order at close[pivot+1], valid for the next hour.
 *     Filled immediately if the current close is already marketable,
 *     otherwise on any 15m bar of the next hour that touches the limit.
 *   - Stop = divergence pivot extreme (no buffer). TP = entry ± RR * risk.
 *   - Size = equity * risk% / |entry - stop|.
 *   - Exits on 1H bars after the entry bar: SL/TP (same-bar rule by candle colour),
 *     opposite divergence closes at candle close.
 *   - One position / one pending order per symbol.
 *
 * Parity notes (kept on purpose, see docs/STRATEGY_SOURCE.md):
 *   - After an IMMEDIATE_FILL the next 1H bar is not checked for SL/TP
 *     (`checkExitsAfterImmediateFill=false` reproduces Python; set true to fix).
 *   - An hour with != 4 contiguous 15m bars is dropped (DATA_UNTRUSTED).
 */

import {
  CvdAccumulator,
  DivergenceDetector,
  PivotDetector,
  resolveExitIntrabar,
  type DivergenceMeta,
  type Side,
} from "./primitives.js";

export const STRATEGY_VERSION = "V082F_ENGINE_V2_LIMIT_1BAR";
export const STRATEGY_VERSION_MARKET = "V082F_ENGINE_V2";
export const STRATEGY_NAME = "cvd_divergence_082f_engine_v2_limit_1bar";
export const STRATEGY_SEMANTICS = "CVD_DIVERGENCE_082F_ENGINE_V2_BINANCE_TRUE_CVD_V1";

const MIN15 = 900_000;
const HOUR = 3_600_000;
const BAR_BUFFER = 64;

export const hourOpen = (ms: number): number => Math.floor(ms / HOUR) * HOUR;

export interface Bar15m {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  takerBuyBase: number;
}

export interface Position {
  setupId: string;
  side: Side;
  entry: number;
  stop: number;
  takeProfit: number;
  qty: number;
  entryTime: number;
  fillReason: FillReason;
  divergenceTime: number;
  confirmationTime: number;
}

export type FillReason = "IMMEDIATE_FILL" | "FILLED_NEXT_HOUR" | "MARKET";

/**
 * limit1bar = production V082F_ENGINE_V2_LIMIT_1BAR (confirm on the bar after the pivot, limit entry).
 * market    = V082F_ENGINE_V2 (cvdbot/strategy/s082f/engine.py): the bar where the divergence is
 *             discovered is the "divergence candle"; confirm on the next bar, enter at its close,
 *             stop at the divergence candle low/high.
 */
export type EntryMode = "limit1bar" | "market";

export interface PendingLimitOrder {
  side: Side;
  divergenceTime: number;
  confirmationTime: number;
  orderPlacedTime: number;
  limitPrice: number;
  stop: number;
  rr: number;
  expiryTime: number;
  expiryIdx: number;
  meta: DivergenceMeta;
}

export interface ClosedTrade {
  symbol: string;
  side: Side;
  setupId: string;
  divergenceTime: number;
  confirmationTime: number;
  entryTime: number;
  exitTime: number;
  entry: number;
  stop: number;
  takeProfit: number;
  exitPrice: number;
  qty: number;
  rr: number;
  pnl: number;
  outcome: string;
  fillReason: FillReason;
  equityAfter: number;
}

export type EngineEvent =
  | { type: "DataUntrusted"; symbol: string; time: number; reason: string; detail?: Record<string, number> }
  | { type: "DivergenceDetected"; symbol: string; side: Side; time: number; meta: DivergenceMeta }
  | { type: "ConfirmationPassed"; symbol: string; side: Side; time: number; divergenceTime: number; confirmationTime: number }
  | { type: "ConfirmationFailed"; symbol: string; side: Side; time: number; divergenceTime: number; confirmationTime: number }
  | { type: "RecoverySuppressedNewSetup"; symbol: string; side: Side; time: number; divergenceTime: number }
  | {
      type: "LimitSignal";
      symbol: string;
      side: Side;
      time: number;
      setupId: string;
      entry: number;
      stop: number;
      takeProfit: number;
      rr: number;
      equity: number;
      riskCash: number;
      qty: number;
      notional: number;
    }
  | { type: "LimitCancelled"; symbol: string; side: Side; time: number; setupId: string; entry: number; reason: string }
  | { type: "EntryRejected"; symbol: string; side: Side; time: number; setupId: string; reason: string }
  | { type: "SetupFiltered"; symbol: string; side: Side; time: number; reason: string }
  | { type: "PositionOpened"; symbol: string; time: number; position: Position; riskCash: number; equityBefore: number }
  | { type: "PositionClosed"; symbol: string; time: number; trade: ClosedTrade };

/** Optional execution-layer guard (leverage / max positions). Not part of the Python oracle. */
/**
 * Absorption on the confirmation bar: aggressive flow AGAINST the trade that price absorbed.
 * long:  delta < 0 (sellers hit the bid) yet the bar closes in the upper part of its range;
 * short: delta > 0 (buyers lift the offer) yet the bar closes in the lower part.
 * |delta| must be at least `minDeltaRatio` × average |delta| of the last `lookback` bars.
 */
export interface AbsorptionOptions {
  minDeltaRatio: number;
  minCloseLocation: number;
  lookback: number;
}

export type EntryGuard = (req: {
  symbol: string;
  side: Side;
  entry: number;
  stop: number;
  qty: number;
  equity: number;
}) => { qty: number } | { reject: string };

export interface EngineOptions {
  symbol: string;
  rrTarget: number;
  pivotLeft?: number;
  pivotRight?: number;
  riskPercent?: number;
  initialCapital?: number;
  startTradeIndex?: number;
  /** false = byte-for-byte Python behaviour; true = also check SL/TP on the bar after an immediate fill. */
  checkExitsAfterImmediateFill?: boolean;
  /**
   * limit1bar only. Python fills an immediately marketable limit at the LIMIT price even though
   * the market is already better (an exchange would fill at the market). true = fill at the
   * current close instead (realistic). false = Python parity.
   */
  immediateFillAtMarket?: boolean;
  /** Default "limit1bar" (production). */
  entryMode?: EntryMode;
  /**
   * Trend filter (not in the Python engines; 0 = off). Long only if the 1H close is above
   * the close `trendFilterHours` hourly bars ago, short only if below.
   */
  trendFilterHours?: number;
  /** Skip setups whose stop is closer than this % of entry (0 = off). Fees eat tight stops. */
  minStopPct?: number;
  /**
   * Decision ("trigger") timeframe in minutes, built from 15m bars: 15, 30, 60 (default, = Python), 120, 240.
   * All rules (CVD, pivots, divergence, confirmation, limit validity, SL/TP checks) run on this timeframe.
   */
  triggerMinutes?: number;
  /**
   * Close the trigger bar as soon as its last 15m bar arrives (realistic, no 15-minute decision lag).
   * Python waits for the first 15m bar of the next period. Same trade sequence on clean data;
   * differs only when a gap follows a complete bar (Python then drops the complete bar).
   */
  closeOnLastBar?: boolean;
  /**
   * External direction filter (e.g. higher-timeframe market structure). Called at decision time
   * with the side and the decision bar time; return a reason string to block the setup.
   */
  directionFilter?: (side: Side, time: number) => string | null;
  /** Allowed trade directions (default both). */
  sides?: "both" | "long" | "short";
  /** Absorption confirmation (market mode); see AbsorptionOptions. Off when undefined. */
  absorption?: AbsorptionOptions;
  entryGuard?: EntryGuard;
  onEvent?: (event: EngineEvent) => void;
}

interface MarketPending {
  side: Side;
  confirmIdx: number;
  divergenceTime: number;
  divOpen: number;
  divHigh: number;
  divLow: number;
}

interface HourBar {
  time: number;
  open: number;
  close: number;
  cvd: number;
  high?: number;
  low?: number;
  delta?: number;
}

export interface EngineState {
  strategyVersion: string;
  symbol: string;
  rrTarget: number;
  equity: number;
  peakEquity: number;
  maxDrawdown: number;
  position: Position | null;
  positionOpenIdx: number | null;
  pendingLimit: PendingLimitOrder | null;
  cvd: number;
  pivotHigh: { window: number[]; index: number };
  pivotLow: { window: number[]; index: number };
  divPrevHigh: DivergenceDetector["prevHigh"];
  divPrevLow: DivergenceDetector["prevLow"];
  bars: HourBar[];
  barsOffset: number;
  index: number;
  lastTime: number | null;
  lastClose: number;
  currentHourMs: number | null;
  hourBars: Bar15m[];
  hourTrusted: boolean;
  last15mMs: number | null;
  funnel: Record<string, number>;
  entryMode?: EntryMode;
  pendingLong?: MarketPending | null;
  pendingShort?: MarketPending | null;
  closesHist?: number[];
}

export class Engine082f {
  readonly symbol: string;
  readonly rrTarget: number;
  readonly pivotLeft: number;
  readonly pivotRight: number;
  readonly riskPercent: number;
  readonly initialCapital: number;
  readonly startTradeIndex: number;
  readonly checkExitsAfterImmediateFill: boolean;
  readonly entryMode: EntryMode;
  readonly immediateFillAtMarket: boolean;
  readonly trendFilterHours: number;
  readonly minStopPct: number;
  readonly triggerMs: number;
  readonly barsPerTrigger: number;
  readonly closeOnLastBar: boolean;
  readonly absorption: AbsorptionOptions | undefined;
  readonly sides: "both" | "long" | "short";
  directionFilter: ((side: Side, time: number) => string | null) | undefined;
  entryGuard: EntryGuard | undefined;
  onEvent: ((event: EngineEvent) => void) | undefined;

  equity: number;
  peakEquity: number;
  maxDrawdown = 0;
  position: Position | null = null;
  positionOpenIdx: number | null = null;
  pendingLimit: PendingLimitOrder | null = null;
  readonly trades: ClosedTrade[] = [];
  funnel: Record<string, number> = {
    divergenceBullish: 0,
    divergenceBearish: 0,
    confirmLongPass: 0,
    confirmShortPass: 0,
    confirmLongFail: 0,
    confirmShortFail: 0,
    entriesLong: 0,
    entriesShort: 0,
    reverseCloses: 0,
    limitOrdersPlaced: 0,
    immediateFills: 0,
    nextHourFills: 0,
    limitCancelled: 0,
    entriesRejected: 0,
    untrustedHours: 0,
    filteredTrend: 0,
    filteredStop: 0,
    filteredStructure: 0,
    filteredAbsorption: 0,
  };

  private readonly cvdAcc = new CvdAccumulator();
  private readonly pivotHigh: PivotDetector;
  private readonly pivotLow: PivotDetector;
  private readonly div = new DivergenceDetector();
  /** Last BAR_BUFFER hourly bars; absolute index = barsOffset + position in array. */
  private bars: HourBar[] = [];
  private barsOffset = 0;
  private index = 0;
  private lastTime: number | null = null;
  private lastClose = 0;
  private currentHourMs: number | null = null;
  private hourBars: Bar15m[] = [];
  private hourTrusted = true;
  private last15mMs: number | null = null;
  private suppressNewSetups = false;
  private pendingLong: MarketPending | null = null;
  private pendingShort: MarketPending | null = null;
  private closesHist: number[] = [];

  constructor(opts: EngineOptions) {
    this.symbol = opts.symbol;
    this.rrTarget = opts.rrTarget;
    this.pivotLeft = opts.pivotLeft ?? 3;
    this.pivotRight = opts.pivotRight ?? 3;
    this.riskPercent = opts.riskPercent ?? 1;
    this.initialCapital = opts.initialCapital ?? 10_000;
    this.startTradeIndex = opts.startTradeIndex ?? 2;
    this.checkExitsAfterImmediateFill = opts.checkExitsAfterImmediateFill ?? false;
    this.entryMode = opts.entryMode ?? "limit1bar";
    this.immediateFillAtMarket = opts.immediateFillAtMarket ?? false;
    this.trendFilterHours = opts.trendFilterHours ?? 0;
    this.minStopPct = opts.minStopPct ?? 0;
    const tm = opts.triggerMinutes ?? 60;
    if (![15, 30, 60, 120, 240].includes(tm)) throw new Error(`triggerMinutes must be 15/30/60/120/240, got ${tm}`);
    this.triggerMs = tm * 60_000;
    this.barsPerTrigger = this.triggerMs / MIN15;
    this.closeOnLastBar = opts.closeOnLastBar ?? false;
    this.directionFilter = opts.directionFilter;
    this.absorption = opts.absorption;
    this.sides = opts.sides ?? "both";
    this.entryGuard = opts.entryGuard;
    this.onEvent = opts.onEvent;
    this.equity = this.initialCapital;
    this.peakEquity = this.initialCapital;
    this.pivotHigh = new PivotDetector(this.pivotLeft, this.pivotRight, "high");
    this.pivotLow = new PivotDetector(this.pivotLeft, this.pivotRight, "low");
  }

  /** Open time of the last accepted 15m bar (for gap detection / recovery). */
  get last15mOpenTime(): number | null {
    return this.last15mMs;
  }

  setRecoveryMode(enabled: boolean): void {
    this.suppressNewSetups = enabled;
  }

  on15mBar(bar: Bar15m): void {
    const ts = bar.openTime;
    const hour = Math.floor(ts / this.triggerMs) * this.triggerMs;
    if (this.last15mMs !== null && ts - this.last15mMs !== MIN15) {
      this.hourTrusted = false;
      this.emit({
        type: "DataUntrusted",
        symbol: this.symbol,
        time: ts,
        reason: "15M_GAP",
        detail: { prev15mMs: this.last15mMs, curr15mMs: ts },
      });
    }
    this.last15mMs = ts;

    if (this.currentHourMs === null) {
      this.currentHourMs = hour;
    } else if (hour !== this.currentHourMs) {
      this.closeCurrentHour();
      this.currentHourMs = hour;
      this.hourBars = [];
      this.hourTrusted = true;
    }
    this.hourBars.push({ ...bar });
    this.tryFillPendingLimit(bar);
    if (this.closeOnLastBar && ts + MIN15 === hour + this.triggerMs) {
      this.closeCurrentHour();
      this.hourBars = [];
    }
  }

  /** Close the forming hour and liquidate everything (end of backtest). */
  flush(): void {
    this.closeCurrentHour();
    this.finalize();
  }

  private tryFillPendingLimit(bar: Bar15m): void {
    const order = this.pendingLimit;
    if (order === null || this.position !== null) {
      return;
    }
    const currHour = Math.floor(bar.openTime / this.triggerMs) * this.triggerMs;
    if (currHour <= order.orderPlacedTime || currHour > order.expiryTime) {
      return;
    }
    const touched = order.side === "long" ? bar.low <= order.limitPrice : bar.high >= order.limitPrice;
    if (!touched) {
      return;
    }
    this.fillPendingLimit(order, bar.openTime, "FILLED_NEXT_HOUR");
  }

  private closeCurrentHour(): void {
    if (this.currentHourMs === null) {
      return;
    }
    const bars = this.hourBars;
    if (bars.length === 0) {
      return;
    }
    let contiguous = true;
    for (let i = 1; i < bars.length; i++) {
      if ((bars[i] as Bar15m).openTime - (bars[i - 1] as Bar15m).openTime !== MIN15) {
        contiguous = false;
      }
    }
    if (bars.length !== this.barsPerTrigger || !this.hourTrusted || !contiguous) {
      this.funnel.untrustedHours = (this.funnel.untrustedHours ?? 0) + 1;
      this.emit({
        type: "DataUntrusted",
        symbol: this.symbol,
        time: this.currentHourMs,
        reason: bars.length !== this.barsPerTrigger || !this.hourTrusted ? "HOUR_NOT_COMPLETE_OR_UNTRUSTED" : "NON_CONTIGUOUS_15M",
        detail: { barsSeen: bars.length },
      });
      return;
    }
    let high = (bars[0] as Bar15m).high;
    let low = (bars[0] as Bar15m).low;
    let volume = 0;
    let takerBuy = 0;
    for (const b of bars) {
      if (b.high > high) high = b.high;
      if (b.low < low) low = b.low;
      volume += b.volume;
      takerBuy += b.takerBuyBase;
    }
    this.onHourCandle(
      this.currentHourMs,
      (bars[0] as Bar15m).open,
      high,
      low,
      (bars[bars.length - 1] as Bar15m).close,
      volume,
      takerBuy,
    );
  }

  private bar(absIndex: number): HourBar {
    const b = this.bars[absIndex - this.barsOffset];
    if (b === undefined) {
      throw new Error(`${this.symbol}: hourly bar ${absIndex} is outside the in-memory window`);
    }
    return b;
  }

  /** Feed a closed, trusted 1H candle (also used directly by tests). */
  onHourCandle(
    time: number,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
    takerBuyBase: number,
  ): void {
    const i = this.index;
    const { cvd, delta } = this.cvdAcc.update(volume, takerBuyBase);
    this.bars.push({ time, open, close, cvd, high, low, delta });
    if (this.bars.length > BAR_BUFFER) {
      this.bars.shift();
      this.barsOffset += 1;
    }
    this.lastTime = time;
    this.lastClose = close;
    if (this.trendFilterHours > 0) {
      this.closesHist.push(close);
      if (this.closesHist.length > this.trendFilterHours + 1) this.closesHist.shift();
    }

    let bear: DivergenceMeta | null = null;
    let bull: DivergenceMeta | null = null;

    const ph = this.pivotHigh.update(high);
    if (ph !== null) {
      const ref = this.bar(ph.index);
      bear = this.div.onPivotHigh(ph.index, ph.price, ref.cvd, ref.time);
    }
    const pl = this.pivotLow.update(low);
    if (pl !== null) {
      const ref = this.bar(pl.index);
      bull = this.div.onPivotLow(pl.index, pl.price, ref.cvd, ref.time);
    }
    if (bull) {
      this.funnel.divergenceBullish = (this.funnel.divergenceBullish ?? 0) + 1;
      this.emit({ type: "DivergenceDetected", symbol: this.symbol, side: "long", time, meta: bull });
    }
    if (bear) {
      this.funnel.divergenceBearish = (this.funnel.divergenceBearish ?? 0) + 1;
      this.emit({ type: "DivergenceDetected", symbol: this.symbol, side: "short", time, meta: bear });
    }

    this.index += 1;
    if (i < this.startTradeIndex) {
      return;
    }

    // 1) SL/TP exits, only on candles after the entry candle.
    if (this.position !== null && this.positionOpenIdx !== null && i > this.positionOpenIdx) {
      const hit = resolveExitIntrabar(
        this.position.side,
        open,
        high,
        low,
        close,
        this.position.stop,
        this.position.takeProfit,
      );
      if (hit !== null) {
        this.closePosition(hit.price, hit.outcome, time);
      }
    }

    // 2) Opposite divergence closes at candle close.
    if (this.position !== null) {
      if ((this.position.side === "long" && bear) || (this.position.side === "short" && bull)) {
        this.funnel.reverseCloses = (this.funnel.reverseCloses ?? 0) + 1;
        this.closePosition(close, "Reverse divergence close", time);
      }
    }

    if (this.entryMode === "market") {
      this.marketStep(i, time, open, high, low, close, bull, bear);
      return;
    }

    // 3) Expire the pending limit exactly at its expiry candle close.
    if (this.pendingLimit !== null && i === this.pendingLimit.expiryIdx && this.position === null) {
      this.cancelPending(this.pendingLimit, time, "LIMIT_EXPIRED_NOT_FILLED");
    }

    // 4) New divergences -> historical confirmation check -> place limit.
    if (bull) {
      this.processDivergence(i, "long", bull, time);
    }
    if (bear) {
      this.processDivergence(i, "short", bear, time);
    }
  }

  /** V082F_ENGINE_V2 steps 3-4: register pending setups, confirm exactly on the next bar. */
  private marketStep(
    i: number,
    time: number,
    open: number,
    high: number,
    low: number,
    close: number,
    bull: DivergenceMeta | null,
    bear: DivergenceMeta | null,
  ): void {
    if (bull) {
      this.pendingLong = { side: "long", confirmIdx: i + 1, divergenceTime: time, divOpen: open, divHigh: high, divLow: low };
    }
    if (bear) {
      this.pendingShort = { side: "short", confirmIdx: i + 1, divergenceTime: time, divOpen: open, divHigh: high, divLow: low };
    }
    for (const pending of [this.pendingLong, this.pendingShort]) {
      if (pending === null || i !== pending.confirmIdx) continue;
      const side = pending.side;
      const ok = side === "long" ? close > pending.divOpen : close < pending.divOpen;
      const key = `confirm${side === "long" ? "Long" : "Short"}${ok ? "Pass" : "Fail"}`;
      this.funnel[key] = (this.funnel[key] ?? 0) + 1;
      this.emit({
        type: ok ? "ConfirmationPassed" : "ConfirmationFailed",
        symbol: this.symbol,
        side,
        time,
        divergenceTime: pending.divergenceTime,
        confirmationTime: time,
      });
      if (ok && this.position === null) {
        if (this.suppressNewSetups) {
          this.emit({ type: "RecoverySuppressedNewSetup", symbol: this.symbol, side, time, divergenceTime: pending.divergenceTime });
        } else {
          this.openMarket(pending, close, time);
        }
      }
      if (side === "long") this.pendingLong = null;
      else this.pendingShort = null;
    }
  }

  private openMarket(pending: MarketPending, entry: number, time: number): void {
    const side = pending.side;
    const stop = side === "long" ? pending.divLow : pending.divHigh;
    const rpu = side === "long" ? entry - stop : stop - entry;
    if (rpu <= 1e-12) return;
    if (this.filtered(side, entry, stop, time, this.index - 1)) return;
    const riskCash = this.equity * (this.riskPercent / 100);
    let qty = riskCash / rpu;
    if (qty <= 0) return;
    const takeProfit = side === "long" ? entry + rpu * this.rrTarget : entry - rpu * this.rrTarget;
    const setupId = this.setupId(side, pending.divergenceTime, time);
    if (this.entryGuard) {
      const verdict = this.entryGuard({ symbol: this.symbol, side, entry, stop, qty, equity: this.equity });
      if ("reject" in verdict) {
        this.funnel.entriesRejected = (this.funnel.entriesRejected ?? 0) + 1;
        this.emit({ type: "EntryRejected", symbol: this.symbol, side, time, setupId, reason: verdict.reject });
        return;
      }
      qty = verdict.qty;
    }
    this.position = {
      setupId,
      side,
      entry,
      stop,
      takeProfit,
      qty,
      entryTime: time,
      fillReason: "MARKET",
      divergenceTime: pending.divergenceTime,
      confirmationTime: time,
    };
    this.positionOpenIdx = this.index - 1;
    const key = side === "long" ? "entriesLong" : "entriesShort";
    this.funnel[key] = (this.funnel[key] ?? 0) + 1;
    this.emit({ type: "PositionOpened", symbol: this.symbol, time, position: { ...this.position }, riskCash, equityBefore: this.equity });
  }

  /** Optional filters (trend, min stop). Returns true if the setup must be skipped. */
  private filtered(side: Side, entry: number, stop: number, time: number, confirmIdx: number): boolean {
    let reason: string | null = null;
    if (this.sides !== "both" && this.sides !== side) {
      reason = "SIDE_DISABLED";
      this.funnel.filteredSide = (this.funnel.filteredSide ?? 0) + 1;
    } else if (this.absorption && !this.isAbsorption(side, confirmIdx)) {
      reason = "NO_ABSORPTION";
      this.funnel.filteredAbsorption = (this.funnel.filteredAbsorption ?? 0) + 1;
    } else if (this.minStopPct > 0 && (Math.abs(entry - stop) / entry) * 100 < this.minStopPct) {
      reason = "MIN_STOP_PCT";
      this.funnel.filteredStop = (this.funnel.filteredStop ?? 0) + 1;
    } else if (this.trendFilterHours > 0) {
      const ref = this.closesHist.length > this.trendFilterHours ? this.closesHist[0] : undefined;
      const now = this.lastClose;
      const ok = ref !== undefined && (side === "long" ? now > ref : now < ref);
      if (!ok) {
        reason = ref === undefined ? "TREND_WARMUP" : "COUNTER_TREND";
        this.funnel.filteredTrend = (this.funnel.filteredTrend ?? 0) + 1;
      }
    }
    if (reason === null && this.directionFilter) {
      const blocked = this.directionFilter(side, time);
      if (blocked !== null) {
        reason = blocked;
        this.funnel.filteredStructure = (this.funnel.filteredStructure ?? 0) + 1;
      }
    }
    if (reason === null) return false;
    this.emit({ type: "SetupFiltered", symbol: this.symbol, side, time, reason });
    return true;
  }

  private isAbsorption(side: Side, confirmIdx: number): boolean {
    const a = this.absorption;
    if (!a) return true;
    const bar = this.bars[confirmIdx - this.barsOffset];
    if (!bar || bar.delta === undefined || bar.high === undefined || bar.low === undefined) return false;
    const start = Math.max(this.barsOffset, confirmIdx - a.lookback);
    let sum = 0;
    let n = 0;
    for (let k = start; k < confirmIdx; k++) {
      const d = this.bars[k - this.barsOffset]?.delta;
      if (d !== undefined) {
        sum += Math.abs(d);
        n += 1;
      }
    }
    if (n === 0) return false;
    const avg = sum / n;
    const range = bar.high - bar.low;
    if (range <= 0) return false;
    const loc = (bar.close - bar.low) / range;
    const against = side === "long" ? bar.delta < 0 : bar.delta > 0;
    const strong = Math.abs(bar.delta) >= a.minDeltaRatio * avg;
    const closeOk = side === "long" ? loc >= a.minCloseLocation : 1 - loc >= a.minCloseLocation;
    return against && strong && closeOk;
  }

  private processDivergence(i: number, side: Side, meta: DivergenceMeta, time: number): void {
    const pivotIdx = meta.currPivotIndex;
    const confirmIdx = pivotIdx + 1;
    if (confirmIdx >= this.index) {
      return;
    }
    const divOpen = this.bar(pivotIdx).open;
    const confirm = this.bar(confirmIdx);
    const ok = side === "long" ? confirm.close > divOpen : confirm.close < divOpen;
    if (!ok) {
      const key = side === "long" ? "confirmLongFail" : "confirmShortFail";
      this.funnel[key] = (this.funnel[key] ?? 0) + 1;
      this.emit({
        type: "ConfirmationFailed",
        symbol: this.symbol,
        side,
        time,
        divergenceTime: meta.currPivotTime,
        confirmationTime: confirm.time,
      });
      return;
    }
    const key = side === "long" ? "confirmLongPass" : "confirmShortPass";
    this.funnel[key] = (this.funnel[key] ?? 0) + 1;
    this.emit({
      type: "ConfirmationPassed",
      symbol: this.symbol,
      side,
      time,
      divergenceTime: meta.currPivotTime,
      confirmationTime: confirm.time,
    });
    if (this.suppressNewSetups) {
      this.emit({
        type: "RecoverySuppressedNewSetup",
        symbol: this.symbol,
        side,
        time,
        divergenceTime: meta.currPivotTime,
      });
      return;
    }
    this.placeLimitOrder(i, side, meta, confirm.time, confirm.close, time);
  }

  private placeLimitOrder(
    i: number,
    side: Side,
    meta: DivergenceMeta,
    confirmationTime: number,
    limitPrice: number,
    now: number,
  ): void {
    if (this.position !== null || this.pendingLimit !== null) {
      return;
    }
    if (this.filtered(side, limitPrice, meta.currPriceExtreme, now, meta.currPivotIndex + 1)) {
      return;
    }
    const order: PendingLimitOrder = {
      side,
      divergenceTime: meta.currPivotTime,
      confirmationTime,
      orderPlacedTime: now,
      limitPrice,
      stop: meta.currPriceExtreme,
      rr: this.rrTarget,
      expiryTime: now + this.triggerMs,
      expiryIdx: i + 1,
      meta,
    };
    this.pendingLimit = order;
    this.funnel.limitOrdersPlaced = (this.funnel.limitOrdersPlaced ?? 0) + 1;

    const rpu = side === "long" ? limitPrice - order.stop : order.stop - limitPrice;
    if (rpu > 1e-12) {
      const riskCash = this.equity * (this.riskPercent / 100);
      const qty = riskCash / rpu;
      if (qty > 0) {
        this.emit({
          type: "LimitSignal",
          symbol: this.symbol,
          side,
          time: now,
          setupId: this.setupId(side, order.divergenceTime, now),
          entry: limitPrice,
          stop: order.stop,
          takeProfit: side === "long" ? limitPrice + rpu * this.rrTarget : limitPrice - rpu * this.rrTarget,
          rr: this.rrTarget,
          equity: this.equity,
          riskCash,
          qty,
          notional: qty * limitPrice,
        });
      }
    }

    const px = this.lastClose;
    const marketable = (side === "long" && px <= limitPrice) || (side === "short" && px >= limitPrice);
    if (marketable) {
      this.fillPendingLimit(order, now, "IMMEDIATE_FILL");
    }
  }

  private fillPendingLimit(order: PendingLimitOrder, fillTime: number, reason: FillReason): void {
    if (this.pendingLimit === null) {
      return;
    }
    const entry =
      reason === "IMMEDIATE_FILL" && this.immediateFillAtMarket ? this.lastClose : order.limitPrice;
    const stop = order.stop;
    const rpu = order.side === "long" ? entry - stop : stop - entry;
    if (rpu <= 1e-12) {
      return;
    }
    const riskCash = this.equity * (this.riskPercent / 100);
    let qty = riskCash / rpu;
    if (qty <= 0) {
      return;
    }
    const takeProfit = order.side === "long" ? entry + rpu * this.rrTarget : entry - rpu * this.rrTarget;
    const setupId = this.setupId(order.side, order.divergenceTime, fillTime);

    if (this.entryGuard) {
      const verdict = this.entryGuard({
        symbol: this.symbol,
        side: order.side,
        entry,
        stop,
        qty,
        equity: this.equity,
      });
      if ("reject" in verdict) {
        this.funnel.entriesRejected = (this.funnel.entriesRejected ?? 0) + 1;
        this.emit({
          type: "EntryRejected",
          symbol: this.symbol,
          side: order.side,
          time: fillTime,
          setupId,
          reason: verdict.reject,
        });
        this.cancelPending(order, fillTime, `ENTRY_REJECTED:${verdict.reject}`);
        return;
      }
      qty = verdict.qty;
    }

    this.position = {
      setupId,
      side: order.side,
      entry,
      stop,
      takeProfit,
      qty,
      entryTime: fillTime,
      fillReason: reason,
      divergenceTime: order.divergenceTime,
      confirmationTime: order.confirmationTime,
    };
    // Python sets position_open_idx = self._index. For an immediate fill that is
    // the *next* hourly bar, so that bar's SL/TP is skipped (parity quirk).
    this.positionOpenIdx =
      reason === "IMMEDIATE_FILL" && this.checkExitsAfterImmediateFill ? this.index - 1 : this.index;
    const key = order.side === "long" ? "entriesLong" : "entriesShort";
    this.funnel[key] = (this.funnel[key] ?? 0) + 1;
    if (reason === "IMMEDIATE_FILL") {
      this.funnel.immediateFills = (this.funnel.immediateFills ?? 0) + 1;
    } else {
      this.funnel.nextHourFills = (this.funnel.nextHourFills ?? 0) + 1;
    }
    this.pendingLimit = null;
    this.emit({
      type: "PositionOpened",
      symbol: this.symbol,
      time: fillTime,
      position: { ...this.position },
      riskCash,
      equityBefore: this.equity,
    });
  }

  private cancelPending(order: PendingLimitOrder, time: number, reason: string): void {
    this.funnel.limitCancelled = (this.funnel.limitCancelled ?? 0) + 1;
    this.emit({
      type: "LimitCancelled",
      symbol: this.symbol,
      side: order.side,
      time,
      setupId: this.setupId(order.side, order.divergenceTime, order.confirmationTime),
      entry: order.limitPrice,
      reason,
    });
    this.pendingLimit = null;
  }

  private closePosition(exitPx: number, outcome: string, time: number): void {
    const pos = this.position;
    if (pos === null) {
      return;
    }
    let pnl: number;
    let rr: number;
    if (pos.side === "long") {
      pnl = (exitPx - pos.entry) * pos.qty;
      rr = (exitPx - pos.entry) / Math.abs(pos.entry - pos.stop);
    } else {
      pnl = (pos.entry - exitPx) * pos.qty;
      rr = (pos.entry - exitPx) / Math.abs(pos.entry - pos.stop);
    }
    this.equity += pnl;
    this.peakEquity = Math.max(this.peakEquity, this.equity);
    if (this.peakEquity > 1e-12) {
      this.maxDrawdown = Math.max(this.maxDrawdown, (this.peakEquity - this.equity) / this.peakEquity);
    }
    const trade: ClosedTrade = {
      symbol: this.symbol,
      side: pos.side,
      setupId: pos.setupId,
      divergenceTime: pos.divergenceTime,
      confirmationTime: pos.confirmationTime,
      entryTime: pos.entryTime,
      exitTime: time,
      entry: pos.entry,
      stop: pos.stop,
      takeProfit: pos.takeProfit,
      exitPrice: exitPx,
      qty: pos.qty,
      rr,
      pnl,
      outcome,
      fillReason: pos.fillReason,
      equityAfter: this.equity,
    };
    this.trades.push(trade);
    this.position = null;
    this.positionOpenIdx = null;
    this.emit({ type: "PositionClosed", symbol: this.symbol, time, trade });
  }

  finalize(): void {
    if (this.pendingLimit !== null && this.position === null) {
      this.cancelPending(this.pendingLimit, this.lastTime ?? 0, "EOD_LIMIT_CANCELLED");
    }
    if (this.position !== null) {
      this.closePosition(this.lastClose, "EOD close", this.lastTime ?? 0);
    }
  }

  private setupId(side: Side, divergenceTime: number, t: number): string {
    return `082f-${this.entryMode}:${this.symbol}:${side}:${new Date(divergenceTime).toISOString()}:${new Date(t).toISOString()}`;
  }

  private emit(event: EngineEvent): void {
    this.onEvent?.(event);
  }

  dumpState(): EngineState {
    return {
      strategyVersion: STRATEGY_VERSION,
      symbol: this.symbol,
      rrTarget: this.rrTarget,
      equity: this.equity,
      peakEquity: this.peakEquity,
      maxDrawdown: this.maxDrawdown,
      position: this.position ? { ...this.position } : null,
      positionOpenIdx: this.positionOpenIdx,
      pendingLimit: this.pendingLimit ? structuredClone(this.pendingLimit) : null,
      cvd: this.cvdAcc.cvd,
      pivotHigh: this.pivotHigh.dumpState(),
      pivotLow: this.pivotLow.dumpState(),
      divPrevHigh: this.div.prevHigh ? { ...this.div.prevHigh } : null,
      divPrevLow: this.div.prevLow ? { ...this.div.prevLow } : null,
      bars: this.bars.map((b) => ({ ...b })),
      barsOffset: this.barsOffset,
      index: this.index,
      lastTime: this.lastTime,
      lastClose: this.lastClose,
      currentHourMs: this.currentHourMs,
      hourBars: this.hourBars.map((b) => ({ ...b })),
      hourTrusted: this.hourTrusted,
      last15mMs: this.last15mMs,
      funnel: { ...this.funnel },
      entryMode: this.entryMode,
      pendingLong: this.pendingLong ? { ...this.pendingLong } : null,
      pendingShort: this.pendingShort ? { ...this.pendingShort } : null,
      closesHist: [...this.closesHist],
    };
  }

  loadState(s: EngineState): void {
    if (s.strategyVersion !== STRATEGY_VERSION || s.symbol !== this.symbol || (s.entryMode ?? "limit1bar") !== this.entryMode) {
      throw new Error(`state mismatch: ${s.strategyVersion}/${s.symbol}/${s.entryMode} vs ${this.symbol}/${this.entryMode}`);
    }
    this.equity = s.equity;
    this.peakEquity = s.peakEquity;
    this.maxDrawdown = s.maxDrawdown;
    this.position = s.position ? { ...s.position } : null;
    this.positionOpenIdx = s.positionOpenIdx;
    this.pendingLimit = s.pendingLimit ? structuredClone(s.pendingLimit) : null;
    this.cvdAcc.cvd = s.cvd;
    this.pivotHigh.loadState(s.pivotHigh);
    this.pivotLow.loadState(s.pivotLow);
    this.div.prevHigh = s.divPrevHigh ? { ...s.divPrevHigh } : null;
    this.div.prevLow = s.divPrevLow ? { ...s.divPrevLow } : null;
    this.bars = s.bars.map((b) => ({ ...b }));
    this.barsOffset = s.barsOffset;
    this.index = s.index;
    this.lastTime = s.lastTime;
    this.lastClose = s.lastClose;
    this.currentHourMs = s.currentHourMs;
    this.hourBars = s.hourBars.map((b) => ({ ...b }));
    this.hourTrusted = s.hourTrusted;
    this.last15mMs = s.last15mMs;
    this.funnel = { ...s.funnel };
    this.pendingLong = s.pendingLong ? { ...s.pendingLong } : null;
    this.pendingShort = s.pendingShort ? { ...s.pendingShort } : null;
    this.closesHist = [...(s.closesHist ?? [])];
  }
}

/** Backwards-compatible name. */
export const Engine082fLimit1Bar = Engine082f;
export type Engine082fLimit1Bar = Engine082f;
