import { describe, expect, it } from "vitest";
import { MultiTfStructure, SwingStructure, parseStructureSpec, tfBucket } from "../src/strategy/marketStructure.js";
import { Engine082f } from "../src/strategy/engine082f.js";
import { runBacktest } from "../src/backtest/runBacktest.js";
import { NO_COSTS, NO_LIMITS } from "../src/portfolio/paperPortfolio.js";
import { generate } from "./parity/synthetic.js";

const bar = (i: number, high: number, low: number, close: number) => ({ time: i, high, low, close });

describe("ICT swing hierarchy", () => {
  it("promotes STH -> ITH -> LTH and flips trend on breaks", () => {
    const s = new SwingStructure(1);
    // highs form STHs at 2, 6, 10, 14, 18 with values 5, 7, 6, 9, 8 ; lows mirror small
    const highs = [1, 2, 5, 2, 1, 2, 7, 2, 1, 2, 6, 2, 1, 2, 9, 2, 1, 2, 8, 2, 1];
    highs.forEach((h, i) => s.onBar(bar(i, h, 0.5, h - 0.1)));
    expect(s.lastSwing("high", "st")?.price).toBe(8);
    // ITHs: 7 (5<7>6) and 9 (6<9>8)
    expect(s.lastSwing("high", "it")?.price).toBe(9);
    // LTH: needs ITH triple; 7 < 9 > ? not yet -> none
    expect(s.lastSwing("high", "lt")).toBeNull();
    // closes broke STH 5 (bar 6) and ITH 7 (bar 14) on the way up; no LTH yet
    expect(s.trend).toEqual({ st: "bull", it: "bull", lt: "neutral" });

    // Mirror image for lows: STL/ITL hierarchy and a bearish break.
    const m = new SwingStructure(1);
    highs.forEach((h, i) => m.onBar(bar(i, 100, -h, -h + 0.1)));
    expect(m.lastSwing("low", "it")?.price).toBe(-9);
    expect(m.trend.it).toBe("bear");
    m.onBar(bar(21, 100, -8.6, -8.5));
    expect(m.trend.st).toBe("bear");
    // a close above the last STL-side high? none defined -> stays bear
    m.onBar(bar(22, 100, -1, -1));
    expect(m.trend.st).toBe("bear");
  });

  it("parses filter specs", () => {
    expect(parseStructureSpec("1d:st+~4h:it+-1h:st")).toEqual([
      { tf: "1d", level: "st", mode: "with" },
      { tf: "4h", level: "it", mode: "notAgainst" },
      { tf: "1h", level: "st", mode: "against" },
    ]);
    expect(parseStructureSpec("none")).toEqual([]);
    expect(() => parseStructureSpec("2d:st")).toThrow();
  });

  it("weekly buckets start on Monday 00:00 UTC", () => {
    const wed = Date.UTC(2025, 0, 8, 13); // Wed 2025-01-08
    expect(new Date(tfBucket("1w", wed)).toISOString()).toBe("2025-01-06T00:00:00.000Z");
  });

  it("HTF bar is only used after its last 15m bar has closed", () => {
    const m = new MultiTfStructure("4h:st");
    const bars = generate(3, 4000, 0, 0.006);
    const seen: string[] = [];
    for (const b of bars) {
      m.on15mBar(b);
      seen.push(m.check("long") ?? "ok");
    }
    // Replaying a prefix must reproduce the same answers (pure function of the past).
    const m2 = new MultiTfStructure("4h:st");
    const prefix = bars.slice(0, 2500);
    const seen2 = prefix.map((b) => {
      m2.on15mBar(b);
      return m2.check("long") ?? "ok";
    });
    expect(seen2).toEqual(seen.slice(0, 2500));
    expect(new Set(seen).size).toBeGreaterThan(1);
  });
});

describe("no lookahead: changing the future never changes past trades", () => {
  const base = generate(11, 9000, 0, 0.006);
  const T = base[6000]!.openTime;
  const altered = base.map((b) => (b.openTime >= T ? { ...b, close: b.close * 1.03, high: b.high * 1.05, low: b.low * 0.97, takerBuyBase: b.volume - b.takerBuyBase } : b));
  const variants = [
    { name: "limit1bar 1h + 1d:st+4h:st", entryMode: "limit1bar", structureSpec: "1d:st+4h:st" },
    { name: "market 1h + 4h:it", entryMode: "market", structureSpec: "4h:it" },
    { name: "market 15m + 1h:st + absorption", entryMode: "market", triggerMinutes: 15, structureSpec: "1h:st", absorption: { minDeltaRatio: 0.5, minCloseLocation: 0.5, lookback: 20 } },
    { name: "market 1h + pullback 1d:st+-4h:st + trend", entryMode: "market", structureSpec: "1d:st+-4h:st", trendFilterHours: 72 },
  ] as const;
  for (const v of variants) {
    it(v.name, () => {
      const run = (bars: typeof base) =>
        runBacktest({
          bars: new Map([["X", bars]]),
          symbolRr: { X: 2 },
          startingEquity: 10_000,
          riskPercent: 1,
          costs: NO_COSTS,
          limits: NO_LIMITS,
          isolated: true,
          checkExitsAfterImmediateFill: true,
          immediateFillAtMarket: true,
          closeOnLastBar: true,
          ...v,
        }).trades.filter((t) => t.exitTime < T - 3_600_000);
      const a = run(base);
      expect(a.length).toBeGreaterThan(0);
      expect(run(altered)).toEqual(a);
    });
  }
});

describe("trigger timeframe", () => {
  it("closeOnLastBar gives the same trades as Python's late close on clean data", () => {
    const bars = generate(1, 12000, 0, 0.006);
    const late = new Engine082f({ symbol: "T", rrTarget: 2 });
    const early = new Engine082f({ symbol: "T", rrTarget: 2, closeOnLastBar: true });
    bars.forEach((b) => {
      late.on15mBar(b);
      early.on15mBar(b);
    });
    late.flush();
    early.flush();
    expect(early.trades).toEqual(late.trades);
  });

  it("15m trigger trades more often than 1h", () => {
    const bars = generate(1, 12000, 0, 0.006);
    const count = (m: number) => {
      const e = new Engine082f({ symbol: "T", rrTarget: 2, entryMode: "market", triggerMinutes: m, closeOnLastBar: true });
      bars.forEach((b) => e.on15mBar(b));
      e.flush();
      return e.trades.length;
    };
    expect(count(15)).toBeGreaterThan(count(60) * 2);
  });
});
