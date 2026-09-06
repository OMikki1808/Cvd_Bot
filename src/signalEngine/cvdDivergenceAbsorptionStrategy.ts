import { Dec } from "../domain/decimal.js";
import type {
  AbsorptionSignal,
  ClosedCandle,
  DivergenceSignal,
  HoldResult,
  PivotPoint,
  StrategyResult,
  StrategySignal,
} from "../domain/types.js";
import type { StrategyConfig } from "../config/schema.js";
import { CvdAccumulator } from "../indicators/cvd.js";
import { detectConfirmedPivots } from "../indicators/pivots.js";
import { detectBearishDivergence, detectBullishDivergence } from "../indicators/divergence.js";
import { detectAbsorption } from "../indicators/absorption.js";

export interface PendingDivergence {
  divergence: DivergenceSignal;
  confirmedAtIndex: number;
}

export interface SymbolStrategyState {
  symbol: string;
  candles: ClosedCandle[];
  deltas: Dec[];
  cvds: Dec[];
  volumes: Dec[];
  pivotHighs: PivotPoint[];
  pivotLows: PivotPoint[];
  pending: PendingDivergence | null;
  lastProcessedOpenTime: number | null;
  lastSignalCandleOpenTime: number | null;
  lastSignalSide: "LONG" | "SHORT" | null;
  warmedUp: boolean;
  resyncing: boolean;
}

export interface StrategyDeps {
  now: () => number;
  onLog: (level: "debug" | "info", msg: string, extra: Record<string, unknown>) => void;
}

const HOLD = (reason: string): HoldResult => ({ side: "HOLD", reason });

export class CvdDivergenceAbsorptionStrategy {
  readonly name = "cvd_divergence_absorption";
  private readonly states = new Map<string, SymbolStrategyState>();
  private readonly cvdBySymbol = new Map<string, CvdAccumulator>();

  constructor(
    private readonly config: StrategyConfig,
    private readonly deps: StrategyDeps,
  ) {}

  getState(symbol: string): SymbolStrategyState {
    let state = this.states.get(symbol);
    if (!state) {
      state = {
        symbol,
        candles: [],
        deltas: [],
        cvds: [],
        volumes: [],
        pivotHighs: [],
        pivotLows: [],
        pending: null,
        lastProcessedOpenTime: null,
        lastSignalCandleOpenTime: null,
        lastSignalSide: null,
        warmedUp: false,
        resyncing: false,
      };
      this.states.set(symbol, state);
      this.cvdBySymbol.set(symbol, new CvdAccumulator(this.config.warmupBars * 3));
    }
    return state;
  }

  /**
   * Rebuild from closed-candle history without emitting signals (reconnect / warmup).
   */
  resync(symbol: string, history: readonly ClosedCandle[]): void {
    this.states.delete(symbol);
    this.cvdBySymbol.delete(symbol);
    const state = this.getState(symbol);
    state.resyncing = true;
    for (const candle of history) {
      this.onClosedCandle(candle);
    }
    state.resyncing = false;
    state.warmedUp = state.candles.length >= this.minWarmupBars();
    this.deps.onLog("info", "cvd_state_restored", {
      symbol,
      bars: state.candles.length,
      cvd: state.cvds[state.cvds.length - 1]?.toString() ?? "0",
      warmedUp: state.warmedUp,
    });
  }

  minWarmupBars(): number {
    return Math.max(
      this.config.warmupBars,
      this.config.pivotLeft + this.config.pivotRight + this.config.divRangeLower + 2,
      this.config.atrPeriod + 2,
      this.config.deltaSmaPeriod,
      this.config.volumeSmaPeriod,
    );
  }

  onClosedCandle(candle: ClosedCandle): StrategyResult {
    const state = this.getState(candle.symbol);
    if (state.lastProcessedOpenTime !== null && candle.openTime === state.lastProcessedOpenTime) {
      return HOLD("duplicate_candle");
    }

    const cvdAcc = this.cvdBySymbol.get(candle.symbol);
    if (!cvdAcc) {
      return HOLD("missing_cvd_accumulator");
    }
    const point = cvdAcc.applyClosedCandle(candle);
    if (!point) {
      return HOLD("duplicate_candle");
    }

    state.candles.push(candle);
    state.deltas.push(point.delta);
    state.cvds.push(point.cvd);
    state.volumes.push(candle.volume);
    state.lastProcessedOpenTime = candle.openTime;

    const cap = this.config.warmupBars * 3;
    if (state.candles.length > cap) {
      const drop = state.candles.length - cap;
      state.candles.splice(0, drop);
      state.deltas.splice(0, drop);
      state.cvds.splice(0, drop);
      state.volumes.splice(0, drop);
      const reindex = (p: PivotPoint): PivotPoint => ({ ...p, index: p.index - drop });
      state.pivotHighs = state.pivotHighs.map(reindex).filter((p) => p.index >= 0);
      state.pivotLows = state.pivotLows.map(reindex).filter((p) => p.index >= 0);
      if (state.pending) {
        state.pending = {
          ...state.pending,
          confirmedAtIndex: state.pending.confirmedAtIndex - drop,
          divergence: {
            ...state.pending.divergence,
            current: reindex(state.pending.divergence.current),
            previous: reindex(state.pending.divergence.previous),
          },
        };
        if (state.pending.divergence.current.index < 0 || state.pending.confirmedAtIndex < 0) {
          state.pending = null;
        }
      }
    }

    if (!state.warmedUp) {
      state.warmedUp = state.candles.length >= this.minWarmupBars();
      if (state.warmedUp && !state.resyncing) {
        this.deps.onLog("info", "strategy_warmup_completed", {
          symbol: candle.symbol,
          bars: state.candles.length,
        });
      }
    }

    if (!state.warmedUp) {
      this.updatePivotsAndPending(state, { emitLogs: false });
      return HOLD("insufficient_warmup");
    }

    const { newDivergence } = this.updatePivotsAndPending(state, { emitLogs: !state.resyncing });

    const absorption = detectAbsorption(state.candles, state.deltas, state.volumes, {
      deltaSmaPeriod: this.config.deltaSmaPeriod,
      volumeSmaPeriod: this.config.volumeSmaPeriod,
      atrPeriod: this.config.atrPeriod,
      deltaMult: this.config.absorptionDeltaMult,
      volumeMult: this.config.absorptionVolumeMult,
      rangeAtrMult: this.config.absorptionRangeAtrMult,
      closeLocation: this.config.absorptionCloseLocation,
    });

    if (absorption && !state.resyncing) {
      this.deps.onLog("info", "absorption_detected", {
        symbol: candle.symbol,
        kind: absorption.kind,
        openTime: absorption.openTime,
        delta: absorption.delta.toString(),
      });
    }

    this.expirePending(state);

    if (absorption && !state.pending) {
      return HOLD("absorption_without_divergence");
    }

    if (state.pending && !absorption) {
      if (newDivergence) {
        return HOLD("divergence_without_absorption");
      }
      return HOLD("awaiting_absorption");
    }

    if (state.pending && absorption) {
      const wantKind = state.pending.divergence.kind === "BULLISH" ? "BULLISH" : "BEARISH";
      if (absorption.kind !== wantKind) {
        return HOLD("absorption_kind_mismatch");
      }
      if (state.lastSignalCandleOpenTime === candle.openTime) {
        return HOLD("duplicate_signal");
      }
      const side = absorption.kind === "BULLISH" ? "LONG" : "SHORT";
      if (state.lastSignalSide === side && state.lastSignalCandleOpenTime === candle.openTime) {
        return HOLD("duplicate_signal");
      }

      const signal = this.buildSignal(state, candle, point.cvd, point.delta, state.pending.divergence, absorption);
      state.lastSignalCandleOpenTime = candle.openTime;
      state.lastSignalSide = side;
      state.pending = null;
      if (!state.resyncing) {
        this.deps.onLog("info", "signal_generated", {
          symbol: candle.symbol,
          side,
          entry: signal.entry.toString(),
          stopLoss: signal.stopLoss.toString(),
          takeProfit: signal.takeProfit.toString(),
          rr: signal.rr.toString(),
          cvd: signal.cvd.toString(),
        });
        return signal;
      }
      return HOLD("resync");
    }

    if (newDivergence) {
      return HOLD(state.resyncing ? "resync" : "divergence_without_absorption");
    }
    return HOLD(state.resyncing ? "resync" : "no_setup");
  }

  private updatePivotsAndPending(
    state: SymbolStrategyState,
    opts: { emitLogs: boolean },
  ): { newDivergence: DivergenceSignal | null } {
    const found = detectConfirmedPivots(state.candles, state.cvds, {
      left: this.config.pivotLeft,
      right: this.config.pivotRight,
    });
    let newDivergence: DivergenceSignal | null = null;

    if (found.low) {
      const already = state.pivotLows.some((p) => p.openTime === found.low!.openTime);
      if (!already) {
        const div = detectBullishDivergence(found.low, state.pivotLows, {
          rangeLower: this.config.divRangeLower,
          rangeUpper: this.config.divRangeUpper,
        });
        state.pivotLows.push(found.low);
        if (div) {
          newDivergence = div;
          state.pending = { divergence: div, confirmedAtIndex: state.candles.length - 1 };
          if (opts.emitLogs && !state.resyncing) {
            this.deps.onLog("info", "divergence_detected", {
              symbol: state.symbol,
              kind: "BULLISH",
              pivotOpenTime: found.low.openTime,
            });
          }
        }
      }
    }

    if (found.high) {
      const already = state.pivotHighs.some((p) => p.openTime === found.high!.openTime);
      if (!already) {
        const div = detectBearishDivergence(found.high, state.pivotHighs, {
          rangeLower: this.config.divRangeLower,
          rangeUpper: this.config.divRangeUpper,
        });
        state.pivotHighs.push(found.high);
        if (div) {
          newDivergence = div;
          state.pending = { divergence: div, confirmedAtIndex: state.candles.length - 1 };
          if (opts.emitLogs && !state.resyncing) {
            this.deps.onLog("info", "divergence_detected", {
              symbol: state.symbol,
              kind: "BEARISH",
              pivotOpenTime: found.high.openTime,
            });
          }
        }
      }
    }

    return { newDivergence };
  }

  private expirePending(state: SymbolStrategyState): void {
    if (!state.pending) {
      return;
    }
    const age = state.candles.length - 1 - state.pending.confirmedAtIndex;
    if (age > this.config.confirmationWindow) {
      state.pending = null;
    }
  }

  private buildSignal(
    state: SymbolStrategyState,
    candle: ClosedCandle,
    cvd: Dec,
    delta: Dec,
    divergence: DivergenceSignal,
    absorption: AbsorptionSignal,
  ): StrategySignal {
    const side = divergence.kind === "BULLISH" ? "LONG" : "SHORT";
    const entry = candle.close;
    const bufferTicks = Dec.from(this.config.slBufferTicks);
    // tick unknown here; risk layer applies tick rounding. Strategy uses price buffer of 0
    // plus the absorption/pivot extreme. slBufferTicks is applied in risk with tickSize.
    const pivotExtreme = divergence.current.price;
    let stopLoss: Dec;
    if (side === "LONG") {
      stopLoss = pivotExtreme.min(absorption.low);
    } else {
      stopLoss = pivotExtreme.max(absorption.high);
    }

    return {
      strategyName: this.name,
      symbol: candle.symbol,
      timeframe: candle.timeframe,
      side,
      candleOpenTime: candle.openTime,
      timestamp: this.deps.now(),
      entry,
      stopLoss,
      takeProfit: Dec.zero(), // filled by risk with RR
      rr: Dec.zero(),
      cvd,
      delta,
      divergence,
      absorption,
    };
  }

  clearLastSignal(symbol: string): void {
    const state = this.states.get(symbol);
    if (state) {
      state.lastSignalCandleOpenTime = null;
      state.lastSignalSide = null;
    }
  }
}
