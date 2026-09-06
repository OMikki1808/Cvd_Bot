import { describe, expect, it } from "vitest";
import { Dec } from "../src/domain/decimal.js";
import { takerVolumes, aggTradeDelta } from "../src/marketData/trueCvd.js";
import { CvdAccumulator } from "../src/indicators/cvd.js";
import { candle } from "./helpers.js";

describe("True CVD", () => {
  it("computes positive delta from taker-buy dominance", () => {
    const c = candle({
      openTime: 1,
      open: "100",
      high: "101",
      low: "99",
      close: "100.5",
      volume: "10",
      takerBuy: "8",
    });
    const v = takerVolumes(c);
    expect(v.takerBuy.eq("8")).toBe(true);
    expect(v.takerSell.eq("2")).toBe(true);
    expect(v.delta.eq("6")).toBe(true);
  });

  it("computes negative delta from taker-sell dominance", () => {
    const c = candle({
      openTime: 1,
      open: "100",
      high: "101",
      low: "99",
      close: "99.5",
      volume: "10",
      takerBuy: "2",
    });
    const v = takerVolumes(c);
    expect(v.takerSell.eq("8")).toBe(true);
    expect(v.delta.eq("-6")).toBe(true);
  });

  it("does not use OHLCV close-location as a proxy for delta", () => {
    const closeNearHigh = candle({
      openTime: 1,
      open: "100",
      high: "110",
      low: "100",
      close: "109",
      volume: "100",
      takerBuy: "10",
    });
    const v = takerVolumes(closeNearHigh);
    expect(v.delta.eq("-80")).toBe(true);
    const ohlcProxy = Dec.from("100").mul(Dec.from("109").sub("100")).div(Dec.from("10"));
    expect(v.delta.eq(ohlcProxy)).toBe(false);
  });

  it("accumulates CVD across closed candles", () => {
    const acc = new CvdAccumulator(50);
    acc.applyClosedCandle(
      candle({ openTime: 1, open: "1", high: "1", low: "1", close: "1", volume: "10", takerBuy: "8" }),
    );
    acc.applyClosedCandle(
      candle({ openTime: 2, open: "1", high: "1", low: "1", close: "1", volume: "10", takerBuy: "2" }),
    );
    expect(acc.getCurrent().eq("0")).toBe(true);
    expect(acc.getSeries()[0]?.cvd.eq("6")).toBe(true);
    expect(acc.getSeries()[1]?.cvd.eq("0")).toBe(true);
  });

  it("maps aggTrade isBuyerMaker to taker side", () => {
    expect(aggTradeDelta(Dec.from("3"), false).eq("3")).toBe(true);
    expect(aggTradeDelta(Dec.from("3"), true).eq("-3")).toBe(true);
  });
});
