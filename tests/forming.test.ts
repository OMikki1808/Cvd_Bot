import { describe, expect, it } from "vitest";
import { FormingCandleDelta } from "../src/marketData/formingCandle.js";
import { Dec } from "../src/domain/decimal.js";
import type { AggTrade } from "../src/domain/types.js";

function trade(id: number, qty: string, isBuyerMaker: boolean): AggTrade {
  return {
    symbol: "BTCUSDT",
    aggTradeId: id,
    price: Dec.from("100"),
    quantity: Dec.from(qty),
    timestamp: id,
    isBuyerMaker,
  };
}

describe("forming candle aggTrades", () => {
  it("accumulates taker delta and ignores duplicate trade ids", () => {
    const f = new FormingCandleDelta();
    f.reset(0);
    expect(f.apply(trade(1, "2", false))).toBe(true);
    expect(f.apply(trade(1, "2", false))).toBe(false);
    expect(f.apply(trade(2, "3", true))).toBe(true);
    const snap = f.snapshot();
    expect(snap.buy.eq("2")).toBe(true);
    expect(snap.sell.eq("3")).toBe(true);
    expect(snap.delta.eq("-1")).toBe(true);
    expect(snap.lastId).toBe(2);
  });
});
