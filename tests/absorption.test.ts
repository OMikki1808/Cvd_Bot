import { describe, expect, it } from "vitest";
import { Dec } from "../src/domain/decimal.js";
import { detectAbsorption } from "../src/indicators/absorption.js";
import { candle } from "./helpers.js";
import type { ClosedCandle } from "../src/domain/types.js";

const params = {
  deltaSmaPeriod: 5,
  volumeSmaPeriod: 5,
  atrPeriod: 5,
  deltaMult: Dec.from("1.2"),
  volumeMult: Dec.from("1.1"),
  rangeAtrMult: Dec.from("3"),
  closeLocation: Dec.from("0.5"),
};

function quiet(n: number, start: number): ClosedCandle[] {
  return Array.from({ length: n }, (_, i) =>
    candle({
      openTime: start + i,
      open: "100",
      high: "100.2",
      low: "99.8",
      close: "100",
      volume: "10",
      takerBuy: "5",
    }),
  );
}

describe("absorption", () => {
  it("detects bullish absorption: heavy sell delta, close in upper half, tight range", () => {
    const bars = [
      ...quiet(8, 0),
      candle({
        openTime: 8,
        open: "100",
        high: "100.3",
        low: "99.9",
        close: "100.25",
        volume: "40",
        takerBuy: "4",
      }),
    ];
    const deltas = bars.map((c) => c.takerBuyBaseVolume.mul(2).sub(c.volume));
    const volumes = bars.map((c) => c.volume);
    const a = detectAbsorption(bars, deltas, volumes, params);
    expect(a?.kind).toBe("BULLISH");
  });

  it("detects bearish absorption: heavy buy delta, close in lower half", () => {
    const bars = [
      ...quiet(8, 0),
      candle({
        openTime: 8,
        open: "100",
        high: "100.3",
        low: "99.9",
        close: "99.95",
        volume: "40",
        takerBuy: "36",
      }),
    ];
    const deltas = bars.map((c) => c.takerBuyBaseVolume.mul(2).sub(c.volume));
    const volumes = bars.map((c) => c.volume);
    const a = detectAbsorption(bars, deltas, volumes, params);
    expect(a?.kind).toBe("BEARISH");
  });

  it("returns null without enough warmup", () => {
    const bars = quiet(3, 0);
    const deltas = bars.map((c) => c.takerBuyBaseVolume.mul(2).sub(c.volume));
    expect(detectAbsorption(bars, deltas, bars.map((c) => c.volume), params)).toBeNull();
  });
});
