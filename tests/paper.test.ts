import { describe, expect, it } from "vitest";
import { Dec } from "../src/domain/decimal.js";
import { resolvePaperExit } from "../src/executor/paperExecutor.js";
import { candle } from "./helpers.js";
import type { Position } from "../src/domain/types.js";

function pos(partial: Partial<Position> & Pick<Position, "side">): Position {
  return {
    id: "p1",
    symbol: "BTCUSDT",
    quantity: Dec.from("1"),
    entry: Dec.from("100"),
    stopLoss: partial.side === "LONG" ? Dec.from("99") : Dec.from("101"),
    takeProfit: partial.side === "LONG" ? Dec.from("102") : Dec.from("98"),
    rr: Dec.from("2"),
    openedAt: 1,
    signalCandleOpenTime: 1,
    ...partial,
  };
}

describe("paper SL/TP", () => {
  it("closes LONG at SL when low prints through the stop", () => {
    const hit = resolvePaperExit(
      pos({ side: "LONG" }),
      candle({
        openTime: 2,
        open: "100",
        high: "100.5",
        low: "98.5",
        close: "99.2",
        volume: "10",
        takerBuy: "5",
      }),
    );
    expect(hit?.reason).toBe("SL");
    expect(hit?.price.eq("99")).toBe(true);
  });

  it("closes LONG at TP when high reaches target and SL is not hit", () => {
    const hit = resolvePaperExit(
      pos({ side: "LONG" }),
      candle({
        openTime: 2,
        open: "100",
        high: "102.5",
        low: "99.5",
        close: "102",
        volume: "10",
        takerBuy: "5",
      }),
    );
    expect(hit?.reason).toBe("TP");
  });

  it("prefers SL if both SL and TP trade in the same candle", () => {
    const hit = resolvePaperExit(
      pos({ side: "LONG" }),
      candle({
        openTime: 2,
        open: "100",
        high: "103",
        low: "98",
        close: "101",
        volume: "10",
        takerBuy: "5",
      }),
    );
    expect(hit?.reason).toBe("SL");
  });
});
