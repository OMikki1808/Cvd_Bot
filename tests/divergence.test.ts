import { describe, expect, it } from "vitest";
import { Dec } from "../src/domain/decimal.js";
import { detectBullishDivergence, detectBearishDivergence } from "../src/indicators/divergence.js";
import type { PivotPoint } from "../src/domain/types.js";

function pivot(index: number, price: string, cvd: string, kind: "HIGH" | "LOW"): PivotPoint {
  return {
    index,
    openTime: index * 1000,
    price: Dec.from(price),
    cvd: Dec.from(cvd),
    kind,
  };
}

const range = { rangeLower: 3, rangeUpper: 40 };

describe("divergence", () => {
  it("detects bullish divergence: price LL, CVD HL", () => {
    const prev = pivot(10, "100", "10", "LOW");
    const curr = pivot(20, "90", "15", "LOW");
    const d = detectBullishDivergence(curr, [prev], range);
    expect(d?.kind).toBe("BULLISH");
  });

  it("does not flag bullish when CVD also makes a lower low", () => {
    const prev = pivot(10, "100", "10", "LOW");
    const curr = pivot(20, "90", "5", "LOW");
    expect(detectBullishDivergence(curr, [prev], range)).toBeNull();
  });

  it("detects bearish divergence: price HH, CVD LH", () => {
    const prev = pivot(10, "100", "20", "HIGH");
    const curr = pivot(20, "110", "12", "HIGH");
    const d = detectBearishDivergence(curr, [prev], range);
    expect(d?.kind).toBe("BEARISH");
  });

  it("rejects pivots closer than rangeLower", () => {
    const prev = pivot(10, "100", "10", "LOW");
    const curr = pivot(12, "90", "15", "LOW");
    expect(detectBullishDivergence(curr, [prev], range)).toBeNull();
  });
});
