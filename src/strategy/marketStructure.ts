/**
 * ICT market structure: short-, intermediate- and long-term swing points on any
 * timeframe, and a trend state per level.
 *
 *   STH  swing high: high above the highs of `strength` bars on each side (default 1 = 3-candle swing)
 *   ITH  an STH whose neighbouring STHs (previous and next) are both lower
 *   LTH  an ITH whose neighbouring ITHs are both lower
 *   (lows mirrored: STL / ITL / LTL)
 *
 * Trend per level (break of structure on a closed bar):
 *   bull after a close above the last swing high of that level,
 *   bear after a close below the last swing low of that level,
 *   neutral until the first break.
 *
 * Every swing is only known after the bars that confirm it have closed, and a
 * bar's close is tested against levels known BEFORE that bar — no lookahead.
 *
 * MultiTfStructure aggregates 15m bars into 1h / 4h / 1d / 1w (UTC, week starts Monday)
 * and answers direction filters like "1d:st+4h:st", "4h:st+~1d:it", "1d:st+-4h:st".
 */

import type { Bar15m } from "./engine082f.js";

export type Level = "st" | "it" | "lt";
export type Trend = "bull" | "bear" | "neutral";
export type Tf = "15m" | "1h" | "4h" | "1d" | "1w";

const LEVELS: Level[] = ["st", "it", "lt"];
const MIN15 = 900_000;
const TF_MS: Record<Tf, number> = {
  "15m": MIN15,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};
const MONDAY_OFFSET = 4 * 86_400_000; // 1970-01-05 was a Monday

export function tfBucket(tf: Tf, ms: number): number {
  if (tf === "1w") {
    return Math.floor((ms - MONDAY_OFFSET) / TF_MS["1w"]) * TF_MS["1w"] + MONDAY_OFFSET;
  }
  return Math.floor(ms / TF_MS[tf]) * TF_MS[tf];
}

interface Swing {
  time: number;
  price: number;
}

interface SideState {
  /** swings per level, last three are enough to promote the middle one */
  swings: Record<Level, Swing[]>;
  last: Record<Level, Swing | null>;
}

interface HtfBar {
  time: number;
  high: number;
  low: number;
  close: number;
}

export interface SwingStructureState {
  bars: HtfBar[];
  highs: SideState;
  lows: SideState;
  trend: Record<Level, Trend>;
}

const emptySide = (): SideState => ({
  swings: { st: [], it: [], lt: [] },
  last: { st: null, it: null, lt: null },
});

/** Structure on a single timeframe, fed with closed bars of that timeframe. */
export class SwingStructure {
  private bars: HtfBar[] = [];
  private highs = emptySide();
  private lows = emptySide();
  trend: Record<Level, Trend> = { st: "neutral", it: "neutral", lt: "neutral" };

  constructor(readonly strength = 1) {}

  onBar(bar: HtfBar): void {
    // 1) Break of structure against levels known before this bar.
    for (const lvl of LEVELS) {
      const hi = this.highs.last[lvl];
      const lo = this.lows.last[lvl];
      if (hi && bar.close > hi.price) this.trend[lvl] = "bull";
      else if (lo && bar.close < lo.price) this.trend[lvl] = "bear";
    }
    // 2) This bar may confirm a swing `strength` bars back.
    this.bars.push(bar);
    const n = this.strength;
    if (this.bars.length > 2 * n + 1) this.bars.shift();
    if (this.bars.length < 2 * n + 1) return;
    const c = this.bars[n] as HtfBar;
    let isHigh = true;
    let isLow = true;
    for (let k = 0; k < this.bars.length; k++) {
      if (k === n) continue;
      const b = this.bars[k] as HtfBar;
      if (!(c.high > b.high)) isHigh = false;
      if (!(c.low < b.low)) isLow = false;
    }
    if (isHigh) this.addSwing(this.highs, { time: c.time, price: c.high }, "high");
    if (isLow) this.addSwing(this.lows, { time: c.time, price: c.low }, "low");
  }

  /** Last confirmed swing of a level (for diagnostics / stops). */
  lastSwing(kind: "high" | "low", lvl: Level): Swing | null {
    return (kind === "high" ? this.highs : this.lows).last[lvl];
  }

  private addSwing(side: SideState, swing: Swing, kind: "high" | "low"): void {
    let promote: Swing | null = swing;
    for (const lvl of LEVELS) {
      if (promote === null) break;
      const list = side.swings[lvl];
      list.push(promote);
      side.last[lvl] = promote;
      if (list.length > 3) list.shift();
      promote = null;
      if (list.length === 3) {
        const [a, b, c] = list as [Swing, Swing, Swing];
        const mid = kind === "high" ? b.price > a.price && b.price > c.price : b.price < a.price && b.price < c.price;
        if (mid) promote = b;
      }
    }
  }

  dumpState(): SwingStructureState {
    return structuredClone({ bars: this.bars, highs: this.highs, lows: this.lows, trend: this.trend });
  }

  loadState(s: SwingStructureState): void {
    const c = structuredClone(s);
    this.bars = c.bars;
    this.highs = c.highs;
    this.lows = c.lows;
    this.trend = c.trend;
  }
}

export interface FilterTerm {
  tf: Tf;
  level: Level;
  /** "with": must point in the trade direction; "notAgainst": neutral is fine; "against": must oppose (pullback). */
  mode: "with" | "notAgainst" | "against";
}

/**
 * Parse "1d:st+4h:st", "4h:st+~1d:it" (~ = not against), "1d:st+-4h:st" (- = must oppose).
 * Empty string / "none" = no filter.
 */
export function parseStructureSpec(spec: string): FilterTerm[] {
  const s = spec.trim();
  if (s === "" || s === "none") return [];
  return s.split("+").map((raw) => {
    const t = raw.trim();
    const mode: FilterTerm["mode"] = t.startsWith("~") ? "notAgainst" : t.startsWith("-") ? "against" : "with";
    const body = mode === "with" ? t : t.slice(1);
    const [tf, level] = body.split(":");
    if (!tf || !(tf in TF_MS) || (level !== "st" && level !== "it" && level !== "lt")) {
      throw new Error(`bad structure term "${raw}" (expected e.g. 1d:st, 4h:it, ~1w:lt, -4h:st)`);
    }
    return { tf: tf as Tf, level, mode };
  });
}

export interface MultiTfState {
  structures: Partial<Record<Tf, SwingStructureState>>;
  forming: Partial<Record<Tf, HtfBar | null>>;
}

/** Feeds 15m bars into several timeframes and evaluates direction filters. */
export class MultiTfStructure {
  readonly terms: FilterTerm[];
  private readonly structures = new Map<Tf, SwingStructure>();
  private readonly forming = new Map<Tf, HtfBar | null>();

  constructor(spec: string, strength = 1) {
    this.terms = parseStructureSpec(spec);
    for (const t of this.terms) {
      if (!this.structures.has(t.tf)) {
        this.structures.set(t.tf, new SwingStructure(strength));
        this.forming.set(t.tf, null);
      }
    }
  }

  get active(): boolean {
    return this.terms.length > 0;
  }

  /** Must be called for every 15m bar BEFORE the engine sees it. */
  on15mBar(bar: Bar15m): void {
    for (const [tf, st] of this.structures) {
      const bucket = tfBucket(tf, bar.openTime);
      let f = this.forming.get(tf) ?? null;
      if (f && f.time !== bucket) {
        st.onBar(f); // previous bucket ended (possibly with missing 15m bars)
        f = null;
      }
      if (!f) {
        f = { time: bucket, high: bar.high, low: bar.low, close: bar.close };
      } else {
        f.high = Math.max(f.high, bar.high);
        f.low = Math.min(f.low, bar.low);
        f.close = bar.close;
      }
      if (bar.openTime + MIN15 === bucket + TF_MS[tf]) {
        st.onBar(f); // last 15m bar of the bucket: bar is closed now
        f = null;
      }
      this.forming.set(tf, f);
    }
  }

  trend(tf: Tf, level: Level): Trend {
    return this.structures.get(tf)?.trend[level] ?? "neutral";
  }

  /** null = allowed, otherwise a reason. */
  check(side: "long" | "short"): string | null {
    const want: Trend = side === "long" ? "bull" : "bear";
    const opp: Trend = side === "long" ? "bear" : "bull";
    for (const t of this.terms) {
      const tr = this.trend(t.tf, t.level);
      const ok = t.mode === "with" ? tr === want : t.mode === "notAgainst" ? tr !== opp : tr === opp;
      if (!ok) return `STRUCTURE_${t.tf}_${t.level}_${tr}`;
    }
    return null;
  }

  dumpState(): MultiTfState {
    const structures: MultiTfState["structures"] = {};
    const forming: MultiTfState["forming"] = {};
    for (const [tf, st] of this.structures) {
      structures[tf] = st.dumpState();
      const f = this.forming.get(tf);
      forming[tf] = f ? { ...f } : null;
    }
    return { structures, forming };
  }

  loadState(s: MultiTfState): void {
    for (const [tf, st] of this.structures) {
      const saved = s.structures[tf];
      if (saved) st.loadState(saved);
      const f = s.forming[tf];
      this.forming.set(tf, f ? { ...f } : null);
    }
  }
}
