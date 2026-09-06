import { describe, expect, it } from "vitest";
import { CvdDivergenceAbsorptionStrategy } from "../src/signalEngine/cvdDivergenceAbsorptionStrategy.js";
import { isSignal } from "../src/domain/types.js";
import type { ClosedCandle, StrategyResult } from "../src/domain/types.js";
import { TEST_STRATEGY, candle, flatBar, type CandleInput } from "./helpers.js";

const TF = 300_000;

function t(i: number): number {
  return 1_700_000_000_000 + i * TF;
}

function strategy(): CvdDivergenceAbsorptionStrategy {
  return new CvdDivergenceAbsorptionStrategy(TEST_STRATEGY, {
    now: () => 1,
    onLog: () => undefined,
  });
}

function play(s: CvdDivergenceAbsorptionStrategy, bars: ClosedCandle[]): StrategyResult[] {
  return bars.map((b) => s.onClosedCandle(b));
}

function warmup(symbol = "BTCUSDT", n = 30): ClosedCandle[] {
  return Array.from({ length: n }, (_, i) => flatBar(t(i), "100", symbol));
}

function longSetup(symbol = "BTCUSDT", startIndex = 30): ClosedCandle[] {
  const i = startIndex;
  const bars: ClosedCandle[] = [];
  const add = (offset: number, partial: Omit<CandleInput, "openTime" | "symbol">): void => {
    bars.push(candle({ symbol, ...partial, openTime: t(i + offset) }));
  };
  add(0, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" });
  add(1, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" });
  add(2, { open: "99", high: "99.5", low: "98", close: "98.5", volume: "10", takerBuy: "1" });
  add(3, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" });
  add(4, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" });
  add(5, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" });
  add(6, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" });
  add(7, { open: "97", high: "97.5", low: "96", close: "96.5", volume: "10", takerBuy: "5" });
  add(8, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "5" });
  add(9, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "5" });
  return bars;
}

function bullishAbsorption(symbol: string, index: number): ClosedCandle {
  return candle({
    symbol,
    openTime: t(index),
    open: "100",
    high: "100.4",
    low: "99.9",
    close: "100.3",
    volume: "50",
    takerBuy: "4",
  });
}

function shortSetup(symbol = "BTCUSDT", startIndex = 30): ClosedCandle[] {
  const i = startIndex;
  const bars: ClosedCandle[] = [];
  const add = (offset: number, partial: Omit<CandleInput, "openTime" | "symbol">): void => {
    bars.push(candle({ symbol, ...partial, openTime: t(i + offset) }));
  };
  add(0, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" });
  add(1, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" });
  add(2, { open: "101", high: "102", low: "100.8", close: "101.5", volume: "10", takerBuy: "9" });
  add(3, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" });
  add(4, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" });
  add(5, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" });
  add(6, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" });
  add(7, { open: "103", high: "104", low: "102.8", close: "103.5", volume: "10", takerBuy: "5" });
  add(8, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "5" });
  add(9, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "5" });
  return bars;
}

function bearishAbsorption(symbol: string, index: number): ClosedCandle {
  return candle({
    symbol,
    openTime: t(index),
    open: "100",
    high: "100.4",
    low: "99.9",
    close: "99.95",
    volume: "50",
    takerBuy: "46",
  });
}

describe("cvd divergence absorption strategy", () => {
  it("HOLDs while warmup is incomplete", () => {
    const s = strategy();
    const results = play(s, warmup("BTCUSDT", 10));
    expect(results.every((r) => r.side === "HOLD")).toBe(true);
    expect(results.some((r) => r.side === "HOLD" && r.reason === "insufficient_warmup")).toBe(true);
    expect(s.getState("BTCUSDT").warmedUp).toBe(false);
  });

  it("emits LONG when bullish divergence is confirmed by bullish absorption", () => {
    const s = strategy();
    play(s, warmup());
    play(s, longSetup());
    const result = s.onClosedCandle(bullishAbsorption("BTCUSDT", 40));
    expect(isSignal(result)).toBe(true);
    if (isSignal(result)) {
      expect(result.side).toBe("LONG");
      expect(result.divergence.kind).toBe("BULLISH");
      expect(result.absorption.kind).toBe("BULLISH");
      expect(result.strategyName).toBe("cvd_divergence_absorption");
      expect(result.stopLoss.lte(result.entry)).toBe(true);
      expect(result.cvd.toString().length).toBeGreaterThan(0);
    }
  });

  it("emits SHORT when bearish divergence is confirmed by bearish absorption", () => {
    const s = strategy();
    play(s, warmup());
    play(s, shortSetup());
    const result = s.onClosedCandle(bearishAbsorption("BTCUSDT", 40));
    expect(isSignal(result)).toBe(true);
    if (isSignal(result)) {
      expect(result.side).toBe("SHORT");
      expect(result.divergence.kind).toBe("BEARISH");
      expect(result.absorption.kind).toBe("BEARISH");
      expect(result.stopLoss.gte(result.entry)).toBe(true);
    }
  });

  it("HOLDs when divergence exists without absorption", () => {
    const s = strategy();
    const results = play(s, [...warmup(), ...longSetup()]);
    const last = results[results.length - 1];
    expect(last && last.side === "HOLD").toBe(true);
    expect(
      results.some(
        (r) =>
          r.side === "HOLD" &&
          (r.reason === "divergence_without_absorption" || r.reason === "awaiting_absorption"),
      ),
    ).toBe(true);
    expect(results.every((r) => r.side === "HOLD")).toBe(true);
  });

  it("HOLDs when absorption exists without divergence", () => {
    const s = strategy();
    play(s, warmup());
    const result = s.onClosedCandle(
      candle({
        symbol: "BTCUSDT",
        openTime: t(30),
        open: "100",
        high: "100",
        low: "100",
        close: "100",
        volume: "50",
        takerBuy: "4",
      }),
    );
    expect(result.side).toBe("HOLD");
    if (result.side === "HOLD") {
      expect(result.reason).toBe("absorption_without_divergence");
    }
  });

  it("ignores duplicate candles", () => {
    const s = strategy();
    const bars = warmup();
    play(s, bars);
    const last = bars[bars.length - 1];
    if (!last) {
      throw new Error("missing last bar");
    }
    const dup = s.onClosedCandle(last);
    expect(dup.side).toBe("HOLD");
    if (dup.side === "HOLD") {
      expect(dup.reason).toBe("duplicate_candle");
    }
  });

  it("does not emit a second signal on the same confirmation candle", () => {
    const s = strategy();
    play(s, [...warmup(), ...longSetup()]);
    const abs = bullishAbsorption("BTCUSDT", 40);
    const first = s.onClosedCandle(abs);
    expect(isSignal(first)).toBe(true);
    const second = s.onClosedCandle(abs);
    expect(second.side).toBe("HOLD");
    if (second.side === "HOLD") {
      expect(second.reason).toBe("duplicate_candle");
    }
  });

  it("keeps independent CVD and signal state per symbol", () => {
    const s = strategy();
    play(s, warmup("BTCUSDT"));
    play(s, warmup("ETHUSDT"));
    play(s, longSetup("BTCUSDT"));
    const btc = s.onClosedCandle(bullishAbsorption("BTCUSDT", 40));
    const ethHold = s.onClosedCandle(bullishAbsorption("ETHUSDT", 30));
    expect(isSignal(btc)).toBe(true);
    expect(ethHold.side).toBe("HOLD");
    expect(s.getState("BTCUSDT").cvds[s.getState("BTCUSDT").cvds.length - 1]?.toString()).not.toBe(
      s.getState("ETHUSDT").cvds[s.getState("ETHUSDT").cvds.length - 1]?.toString(),
    );
  });

  it("resync rebuilds state without emitting signals", () => {
    const s = strategy();
    const history = [...warmup(), ...longSetup(), bullishAbsorption("BTCUSDT", 40)];
    s.resync("BTCUSDT", history);
    expect(s.getState("BTCUSDT").warmedUp).toBe(true);
    const last = history[history.length - 1];
    if (!last) {
      throw new Error("missing last history candle");
    }
    expect(s.getState("BTCUSDT").lastProcessedOpenTime).toBe(last.openTime);
    expect(s.getState("BTCUSDT").lastSignalCandleOpenTime).toBe(last.openTime);
    const replayLast = s.onClosedCandle(last);
    expect(replayLast.side).toBe("HOLD");
    if (replayLast.side === "HOLD") {
      expect(replayLast.reason).toBe("duplicate_candle");
    }
  });
});
