/**
 * Building blocks of the 082F Engine-v2 strategy, ported 1:1 from
 * CVDBot-prodaction `cvdbot/strategy/s082f/*` (cvd.py, pivots.py,
 * divergence.py, exits.py).
 *
 * Arithmetic intentionally uses IEEE `number`, exactly like the Python oracle
 * (Python `float`), so that results are bit-identical and parity can be checked
 * trade-by-trade. Do not "improve" the formulas here without re-running parity.
 */

export type Side = "long" | "short";

/** True taker delta: buy = takerBuyBase, sell = volume - takerBuyBase. */
export function computeDelta(volume: number, takerBuyBase: number): number {
  const buyVolume = takerBuyBase;
  const sellVolume = volume - takerBuyBase;
  return buyVolume - sellVolume;
}

export class CvdAccumulator {
  cvd = 0;

  update(volume: number, takerBuyBase: number): { delta: number; cvd: number } {
    const delta = computeDelta(volume, takerBuyBase);
    this.cvd += delta;
    return { delta, cvd: this.cvd };
  }
}

/**
 * Streaming fractal pivot with `right`-bar delayed discovery.
 * The centre must be the unique max (high) / unique min (low) of the full
 * `[left + right + 1]` window. Only the last window is kept in memory
 * (the Python version keeps the whole history; results are identical).
 */
export class PivotDetector {
  private readonly window: number[] = [];
  private index = 0;

  constructor(
    readonly left: number,
    readonly right: number,
    readonly mode: "high" | "low",
  ) {}

  update(value: number): { index: number; price: number } | null {
    this.window.push(value);
    const size = this.left + this.right + 1;
    if (this.window.length > size) {
      this.window.shift();
    }
    const currentIndex = this.index;
    this.index += 1;
    if (currentIndex < this.left + this.right) {
      return null;
    }
    const center = this.window[this.left] as number;
    let extreme = this.window[0] as number;
    let count = 0;
    for (const v of this.window) {
      if (this.mode === "high" ? v > extreme : v < extreme) {
        extreme = v;
      }
    }
    if (center !== extreme) {
      return null;
    }
    for (const v of this.window) {
      if (v === center) {
        count += 1;
      }
    }
    if (count !== 1) {
      return null;
    }
    return { index: currentIndex - this.right, price: center };
  }

  dumpState(): { window: number[]; index: number } {
    return { window: [...this.window], index: this.index };
  }

  loadState(state: { window: number[]; index: number }): void {
    this.window.length = 0;
    this.window.push(...state.window);
    this.index = state.index;
  }
}

export interface PivotRef {
  price: number;
  cvd: number;
  index: number;
  time: number;
}

export interface DivergenceMeta {
  prevPivotTime: number;
  currPivotTime: number;
  currPivotIndex: number;
  prevPriceExtreme: number;
  currPriceExtreme: number;
  prevCvdExtreme: number;
  currCvdExtreme: number;
}

/**
 * Regular divergence against the previous same-type pivot, strict inequalities.
 * Bearish: price HH and CVD LH. Bullish: price LL and CVD HL.
 * The previous pivot is replaced on every confirmed pivot.
 */
export class DivergenceDetector {
  prevHigh: PivotRef | null = null;
  prevLow: PivotRef | null = null;

  onPivotHigh(index: number, price: number, cvd: number, time: number): DivergenceMeta | null {
    const prev = this.prevHigh;
    let meta: DivergenceMeta | null = null;
    if (prev !== null && price > prev.price && cvd < prev.cvd) {
      meta = metaOf(prev, { price, cvd, index, time });
    }
    this.prevHigh = { price, cvd, index, time };
    return meta;
  }

  onPivotLow(index: number, price: number, cvd: number, time: number): DivergenceMeta | null {
    const prev = this.prevLow;
    let meta: DivergenceMeta | null = null;
    if (prev !== null && price < prev.price && cvd > prev.cvd) {
      meta = metaOf(prev, { price, cvd, index, time });
    }
    this.prevLow = { price, cvd, index, time };
    return meta;
  }
}

function metaOf(prev: PivotRef, curr: PivotRef): DivergenceMeta {
  return {
    prevPivotTime: prev.time,
    currPivotTime: curr.time,
    currPivotIndex: curr.index,
    prevPriceExtreme: prev.price,
    currPriceExtreme: curr.price,
    prevCvdExtreme: prev.cvd,
    currCvdExtreme: curr.cvd,
  };
}

export type ExitOutcome =
  | "SL"
  | "TP"
  | "SL&TP same bar -> SL"
  | "SL&TP same bar -> TP";

/**
 * Intrabar SL/TP on a closed bar. If both are touched, the bar colour decides
 * (historical 082f rule): green bar -> long SL / short TP, red bar -> long TP / short SL.
 */
export function resolveExitIntrabar(
  side: Side,
  o: number,
  h: number,
  l: number,
  c: number,
  stop: number,
  takeProfit: number,
): { price: number; outcome: ExitOutcome } | null {
  const hitSl = side === "long" ? l <= stop : h >= stop;
  const hitTp = side === "long" ? h >= takeProfit : l <= takeProfit;
  if (!hitSl && !hitTp) {
    return null;
  }
  if (hitSl && !hitTp) {
    return { price: stop, outcome: "SL" };
  }
  if (hitTp && !hitSl) {
    return { price: takeProfit, outcome: "TP" };
  }
  if (c >= o) {
    return side === "long"
      ? { price: stop, outcome: "SL&TP same bar -> SL" }
      : { price: takeProfit, outcome: "SL&TP same bar -> TP" };
  }
  return side === "long"
    ? { price: takeProfit, outcome: "SL&TP same bar -> TP" }
    : { price: stop, outcome: "SL&TP same bar -> SL" };
}
