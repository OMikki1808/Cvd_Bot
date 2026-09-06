import { describe, expect, it } from "vitest";
import { Dec } from "../src/domain/decimal.js";
import { isPivotHigh, isPivotLow, detectConfirmedPivots, confirmedPivotIndex } from "../src/indicators/pivots.js";
import { candle } from "./helpers.js";

describe("pivots", () => {
  it("detects a pivot high with left=2 right=2", () => {
    const highs = ["1", "2", "5", "2", "1"].map((v) => Dec.from(v));
    expect(isPivotHigh(highs, 2, 2, 2)).toBe(true);
    expect(isPivotHigh(highs, 1, 2, 2)).toBe(false);
  });

  it("detects a pivot low with left=2 right=2", () => {
    const lows = ["5", "4", "1", "4", "5"].map((v) => Dec.from(v));
    expect(isPivotLow(lows, 2, 2, 2)).toBe(true);
    expect(isPivotLow(lows, 0, 2, 2)).toBe(false);
  });

  it("does not confirm a pivot until right bars have closed", () => {
    expect(confirmedPivotIndex(4, 2)).toBe(1);
    expect(confirmedPivotIndex(2, 2)).toBe(null);
  });

  it("returns confirmed pivot from candle buffer", () => {
    const prices = ["10", "11", "15", "11", "10"];
    const candles = prices.map((p, i) =>
      candle({
        openTime: i,
        open: "10",
        high: p,
        low: "9",
        close: "10",
        volume: "10",
        takerBuy: "5",
      }),
    );
    const cvd = prices.map(() => Dec.zero());
    const found = detectConfirmedPivots(candles, cvd, { left: 2, right: 2 });
    expect(found.high?.price.eq("15")).toBe(true);
    expect(found.high?.index).toBe(2);
  });
});
