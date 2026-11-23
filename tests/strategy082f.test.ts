import { describe, expect, it } from "vitest";
import { Engine082f, Engine082fLimit1Bar, type EngineEvent } from "../src/strategy/engine082f.js";
import { PivotDetector, resolveExitIntrabar, computeDelta } from "../src/strategy/primitives.js";
import { resolvePool } from "../src/strategy/productionPool.js";
import { checkScenario, loadScenarios } from "./parity/runParity.js";
import { generate } from "./parity/synthetic.js";

describe("082F parity with the Python oracle (CVDBot-prodaction)", () => {
  for (const sc of loadScenarios()) {
    it(`${sc.name}: bit-exact trades, equity and funnel`, () => {
      expect(checkScenario(sc)).toEqual([]);
    });
  }
});

describe("primitives", () => {
  it("true delta = takerBuy - (volume - takerBuy)", () => {
    expect(computeDelta(10, 7)).toBe(4);
    expect(computeDelta(10, 2)).toBe(-6);
  });

  it("pivot needs a unique extreme in the full window and is known `right` bars later", () => {
    const p = new PivotDetector(2, 2, "high");
    const seq = [1, 2, 5, 3, 2, 1];
    const found = seq.map((v) => p.update(v));
    expect(found.slice(0, 4)).toEqual([null, null, null, null]);
    expect(found[4]).toEqual({ index: 2, price: 5 });
    const eq = new PivotDetector(1, 1, "high");
    expect([4, 4, 1].map((v) => eq.update(v))[2]).toBeNull();
  });

  it("same-bar SL&TP uses candle colour", () => {
    expect(resolveExitIntrabar("long", 10, 13, 8, 11, 9, 12)?.outcome).toBe("SL&TP same bar -> SL");
    expect(resolveExitIntrabar("long", 11, 13, 8, 10, 9, 12)?.outcome).toBe("SL&TP same bar -> TP");
    expect(resolveExitIntrabar("short", 10, 13, 8, 11, 12, 9)?.outcome).toBe("SL&TP same bar -> TP");
  });
});

describe("engine state", () => {
  it("dump/load mid-stream reproduces an uninterrupted run", () => {
    const bars = generate(1, 12000, 0, 0.006);
    const ref = new Engine082fLimit1Bar({ symbol: "T", rrTarget: 2 });
    bars.forEach((b) => ref.on15mBar(b));
    ref.flush();

    const a = new Engine082fLimit1Bar({ symbol: "T", rrTarget: 2 });
    const cut = 7001;
    bars.slice(0, cut).forEach((b) => a.on15mBar(b));
    const state = JSON.parse(JSON.stringify(a.dumpState()));
    const b2 = new Engine082fLimit1Bar({ symbol: "T", rrTarget: 2 });
    b2.loadState(state);
    bars.slice(cut).forEach((b) => b2.on15mBar(b));
    b2.flush();
    expect(a.trades.concat(b2.trades)).toEqual(ref.trades);
    expect(b2.equity).toBe(ref.equity);
  });
});

describe("optional fixes (off by default to keep parity)", () => {
  it("checkExitsAfterImmediateFill changes results only through the bar after an immediate fill", () => {
    const bars = generate(1, 12000, 0, 0.006);
    const parity = new Engine082fLimit1Bar({ symbol: "T", rrTarget: 2 });
    const fixed = new Engine082fLimit1Bar({ symbol: "T", rrTarget: 2, checkExitsAfterImmediateFill: true });
    bars.forEach((b) => {
      parity.on15mBar(b);
      fixed.on15mBar(b);
    });
    parity.flush();
    fixed.flush();
    expect(fixed.trades.length).toBeGreaterThan(0);
    expect(fixed.trades.map((t) => t.exitTime)).not.toEqual(parity.trades.map((t) => t.exitTime));
  });

  it("entry guard can cap quantity or reject", () => {
    const events: EngineEvent[] = [];
    const eng = new Engine082fLimit1Bar({
      symbol: "T",
      rrTarget: 2,
      entryGuard: ({ qty, entry, equity }) =>
        qty * entry > equity * 2 ? { reject: "LEVERAGE" } : { qty },
      onEvent: (e) => events.push(e),
    });
    generate(1, 12000, 0, 0.006).forEach((b) => eng.on15mBar(b));
    const opened = events.filter((e) => e.type === "PositionOpened");
    const rejected = events.filter((e) => e.type === "EntryRejected");
    expect(opened.length + rejected.length).toBeGreaterThan(0);
    for (const e of opened) {
      if (e.type === "PositionOpened") {
        expect(e.position.qty * e.position.entry).toBeLessThanOrEqual(e.equityBefore * 2);
      }
    }
  });
});

describe("production pool", () => {
  it("PHASE50 has 35 symbols with RR 1..4", () => {
    const pool = resolvePool("PHASE50_TOP35_2026_09");
    expect(Object.keys(pool)).toHaveLength(35);
    expect(pool.BTCUSDT).toBe(3);
    expect(Object.values(pool).every((rr) => rr >= 1 && rr <= 4)).toBe(true);
  });
});

describe("filters and market mode", () => {
  const bars = generate(7, 12000, 0, 0.006);
  const hourlyClose = new Map<number, number>();
  for (const b of bars) hourlyClose.set(Math.floor(b.openTime / 3_600_000) * 3_600_000, b.close);

  for (const entryMode of ["market", "limit1bar"] as const) {
    it(`${entryMode}: trend filter only lets trend-aligned setups through (checked independently)`, () => {
      const N = 168;
      const opened: Array<{ side: string; time: number }> = [];
      const filtered: string[] = [];
      const eng = new Engine082f({
        symbol: "T",
        rrTarget: 2,
        entryMode,
        trendFilterHours: N,
        onEvent: (e) => {
          if (e.type === "LimitSignal" || (e.type === "PositionOpened" && e.position.fillReason === "MARKET")) {
            opened.push({ side: e.type === "LimitSignal" ? e.side : e.position.side, time: e.time });
          }
          if (e.type === "SetupFiltered") filtered.push(e.reason);
        },
      });
      bars.forEach((b) => eng.on15mBar(b));
      expect(opened.length).toBeGreaterThan(5);
      expect(filtered.filter((r) => r === "COUNTER_TREND").length).toBeGreaterThan(5);
      for (const o of opened) {
        const now = hourlyClose.get(o.time) as number;
        const ref = hourlyClose.get(o.time - N * 3_600_000) as number;
        expect(o.side === "long" ? now > ref : now < ref).toBe(true);
      }
    });
  }

  it("min stop filter", () => {
    const eng = new Engine082f({ symbol: "T", rrTarget: 2, entryMode: "market", minStopPct: 0.8 });
    bars.forEach((b) => eng.on15mBar(b));
    eng.flush();
    expect(eng.trades.length).toBeGreaterThan(0);
    for (const t of eng.trades) expect((Math.abs(t.entry - t.stop) / t.entry) * 100).toBeGreaterThanOrEqual(0.8);
    expect(eng.funnel.filteredStop).toBeGreaterThan(0);
  });

  it("market mode dump/load mid-stream reproduces an uninterrupted run", () => {
    const opts = { symbol: "T", rrTarget: 3, entryMode: "market" as const, trendFilterHours: 72 };
    const ref = new Engine082f(opts);
    bars.forEach((b) => ref.on15mBar(b));
    ref.flush();
    const a = new Engine082f(opts);
    bars.slice(0, 5003).forEach((b) => a.on15mBar(b));
    const b2 = new Engine082f(opts);
    b2.loadState(JSON.parse(JSON.stringify(a.dumpState())));
    bars.slice(5003).forEach((b) => b2.on15mBar(b));
    b2.flush();
    expect(a.trades.concat(b2.trades)).toEqual(ref.trades);
  });
});
