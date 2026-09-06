import { describe, expect, it } from "vitest";
import { Dec } from "../src/domain/decimal.js";
import { RiskManager } from "../src/risk/riskManager.js";
import { parseConfig } from "../src/config/schema.js";
import { DEFAULT_FILTERS } from "./helpers.js";
import type { StrategySignal } from "../src/domain/types.js";
import { RiskRejectedError } from "../src/domain/errors.js";

function signal(overrides: Partial<StrategySignal> = {}): StrategySignal {
  const base: StrategySignal = {
    strategyName: "cvd_divergence_absorption",
    symbol: "BTCUSDT",
    timeframe: "5m",
    side: "LONG",
    candleOpenTime: 1,
    timestamp: 1,
    entry: Dec.from("100"),
    stopLoss: Dec.from("99"),
    takeProfit: Dec.zero(),
    rr: Dec.zero(),
    cvd: Dec.from("12"),
    delta: Dec.from("-8"),
    divergence: {
      kind: "BULLISH",
      current: { index: 10, openTime: 1, price: Dec.from("99"), cvd: Dec.from("5"), kind: "LOW" },
      previous: { index: 4, openTime: 0, price: Dec.from("100"), cvd: Dec.from("1"), kind: "LOW" },
    },
    absorption: {
      kind: "BULLISH",
      openTime: 1,
      high: Dec.from("100.4"),
      low: Dec.from("99.9"),
      close: Dec.from("100"),
      delta: Dec.from("-8"),
      volume: Dec.from("50"),
    },
  };
  return { ...base, ...overrides };
}

describe("risk manager", () => {
  const config = parseConfig({
    RISK_PERCENT: "0.5",
    DEFAULT_RR: "2",
    SYMBOL_RR: "BTCUSDT:2,SOLUSDT:1.8",
    CVD_SL_BUFFER_TICKS: "1",
  });
  const risk = new RiskManager(config);

  it("sizes from equity * risk% / stop distance", () => {
    const sized = risk.size(signal(), DEFAULT_FILTERS, {
      equity: Dec.from("10000"),
      hasOpenPosition: false,
    });
    expect(sized.signal.rr.eq("2")).toBe(true);
    const stopDist = sized.signal.entry.sub(sized.signal.stopLoss).abs();
    const expectedQty = sized.riskAmount.div(stopDist).floorToStep(DEFAULT_FILTERS.stepSize);
    expect(sized.quantity.eq(expectedQty)).toBe(true);
    expect(sized.riskAmount.eq("50")).toBe(true);
    const tpDist = sized.signal.takeProfit.sub(sized.signal.entry).abs();
    expect(tpDist.div(stopDist).eq("2")).toBe(true);
  });

  it("applies symbol-specific RR", () => {
    const btc = risk.size(signal({ symbol: "BTCUSDT" }), DEFAULT_FILTERS, {
      equity: Dec.from("10000"),
      hasOpenPosition: false,
    });
    const solFilters = { ...DEFAULT_FILTERS, symbol: "SOLUSDT" };
    const sol = risk.size(signal({ symbol: "SOLUSDT" }), solFilters, {
      equity: Dec.from("10000"),
      hasOpenPosition: false,
    });
    expect(btc.signal.rr.eq("2")).toBe(true);
    expect(sol.signal.rr.eq("1.8")).toBe(true);
    const btcStop = btc.signal.entry.sub(btc.signal.stopLoss).abs();
    const solStop = sol.signal.entry.sub(sol.signal.stopLoss).abs();
    expect(btc.signal.takeProfit.eq(btc.signal.entry.add(btcStop.mul("2")).roundToTick(DEFAULT_FILTERS.tickSize))).toBe(
      true,
    );
    expect(sol.signal.takeProfit.eq(sol.signal.entry.add(solStop.mul("1.8")).roundToTick(DEFAULT_FILTERS.tickSize))).toBe(
      true,
    );
  });

  it("places SL below entry and TP above entry for LONG", () => {
    const sized = risk.size(signal({ side: "LONG" }), DEFAULT_FILTERS, {
      equity: Dec.from("10000"),
      hasOpenPosition: false,
    });
    expect(sized.signal.stopLoss.lt(sized.signal.entry)).toBe(true);
    expect(sized.signal.takeProfit.gt(sized.signal.entry)).toBe(true);
  });

  it("places SL above entry and TP below entry for SHORT", () => {
    const sized = risk.size(
      signal({
        side: "SHORT",
        entry: Dec.from("100"),
        stopLoss: Dec.from("101"),
        divergence: {
          kind: "BEARISH",
          current: { index: 10, openTime: 1, price: Dec.from("101"), cvd: Dec.from("5"), kind: "HIGH" },
          previous: { index: 4, openTime: 0, price: Dec.from("100"), cvd: Dec.from("9"), kind: "HIGH" },
        },
        absorption: {
          kind: "BEARISH",
          openTime: 1,
          high: Dec.from("101"),
          low: Dec.from("99.9"),
          close: Dec.from("100"),
          delta: Dec.from("8"),
          volume: Dec.from("50"),
        },
      }),
      DEFAULT_FILTERS,
      { equity: Dec.from("10000"), hasOpenPosition: false },
    );
    expect(sized.signal.stopLoss.gt(sized.signal.entry)).toBe(true);
    expect(sized.signal.takeProfit.lt(sized.signal.entry)).toBe(true);
  });

  it("rejects when a position is already open", () => {
    expect(() =>
      risk.size(signal(), DEFAULT_FILTERS, { equity: Dec.from("10000"), hasOpenPosition: true }),
    ).toThrow(RiskRejectedError);
  });
});
