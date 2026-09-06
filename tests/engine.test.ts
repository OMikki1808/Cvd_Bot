import { describe, expect, it } from "vitest";
import { createLogger } from "../src/logging/logger.js";
import { AppDatabase } from "../src/db/database.js";
import { PositionTracker } from "../src/positions/positionTracker.js";
import { PaperExecutor } from "../src/executor/paperExecutor.js";
import { TradeJournal } from "../src/journal/tradeJournal.js";
import { NoopNotifier } from "../src/telegram/telegramNotifier.js";
import { Reconciler } from "../src/reconciliation/reconciler.js";
import { TradingEngine } from "../src/app/TradingEngine.js";
import { CvdDivergenceAbsorptionStrategy } from "../src/signalEngine/cvdDivergenceAbsorptionStrategy.js";
import { RiskManager } from "../src/risk/riskManager.js";
import { parseConfig } from "../src/config/schema.js";
import { Dec } from "../src/domain/decimal.js";
import { TEST_STRATEGY, DEFAULT_FILTERS, candle, flatBar, type CandleInput } from "./helpers.js";
import { isSignal } from "../src/domain/types.js";

const TF = 300_000;
const t = (i: number): number => 1_700_000_000_000 + i * TF;

function longBars(symbol: string): ReturnType<typeof candle>[] {
  const start = 30;
  const bar = (offset: number, p: Omit<CandleInput, "openTime" | "symbol">) =>
    candle({ symbol, ...p, openTime: t(start + offset) });
  return [
    ...Array.from({ length: 30 }, (_, i) => flatBar(t(i), "100", symbol)),
    bar(0, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" }),
    bar(1, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "1" }),
    bar(2, { open: "99", high: "99.5", low: "98", close: "98.5", volume: "10", takerBuy: "1" }),
    bar(3, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" }),
    bar(4, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" }),
    bar(5, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" }),
    bar(6, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "9" }),
    bar(7, { open: "97", high: "97.5", low: "96", close: "96.5", volume: "10", takerBuy: "5" }),
    bar(8, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "5" }),
    bar(9, { open: "100", high: "100.2", low: "99.8", close: "100", volume: "10", takerBuy: "5" }),
    bar(10, {
      open: "100",
      high: "100.4",
      low: "99.9",
      close: "100.3",
      volume: "50",
      takerBuy: "4",
    }),
  ];
}

describe("engine integration", () => {
  it("opens a PAPER position from the same signal engine and blocks duplicates while open", async () => {
    const config = parseConfig({
      SYMBOLS: "BTCUSDT",
      RISK_PERCENT: "0.5",
      DEFAULT_RR: "2",
      SYMBOL_RR: "BTCUSDT:2",
      PAPER_STARTING_BALANCE_USDT: "10000",
    });
    const logger = createLogger("silent");
    const db = new AppDatabase(":memory:", logger);
    const strategy = new CvdDivergenceAbsorptionStrategy(TEST_STRATEGY, {
      now: () => 1,
      onLog: () => undefined,
    });
    const risk = new RiskManager(config);
    const positions = new PositionTracker(db, logger);
    const executor = new PaperExecutor(Dec.from("10000"), positions, logger, () => 1);
    const journal = new TradeJournal(db);
    const engine = new TradingEngine(
      { ...config, strategy: TEST_STRATEGY, symbols: ["BTCUSDT"] },
      logger,
      strategy,
      risk,
      positions,
      executor,
      journal,
      new NoopNotifier(),
      new Reconciler(db, positions, logger),
      null,
      new Map([["BTCUSDT", DEFAULT_FILTERS]]),
    );

    const bars = longBars("BTCUSDT");
    let opened = 0;
    for (const bar of bars) {
      const sized = await engine.onClosedCandle(bar);
      if (sized) {
        opened += 1;
      }
    }
    expect(opened).toBe(1);
    expect(positions.hasOpen("BTCUSDT")).toBe(true);

    const last = bars[bars.length - 1];
    if (!last) {
      throw new Error("missing last");
    }
    const again = await engine.onClosedCandle(last);
    expect(again).toBeNull();

    const recon = new Reconciler(db, positions, logger).reconcile();
    expect(recon.ok).toBe(true);
    db.close();
  });

  it("strategy unit result for the same dataset is LONG", () => {
    const strategy = new CvdDivergenceAbsorptionStrategy(TEST_STRATEGY, {
      now: () => 1,
      onLog: () => undefined,
    });
    const results = longBars("BTCUSDT").map((b) => strategy.onClosedCandle(b));
    const signals = results.filter(isSignal);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.side).toBe("LONG");
  });
});
