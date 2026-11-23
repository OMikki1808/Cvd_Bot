import { describe, expect, it } from "vitest";
import { AppDatabase } from "../src/db/database.js";
import { parseConfig } from "../src/config/schema.js";
import { PaperRuntime } from "../src/runtime/paperRuntime.js";
import { PaperPortfolio } from "../src/portfolio/paperPortfolio.js";
import type { KlineStreamHandlers } from "../src/exchange/binanceSpot.js";
import type { AppLogger } from "../src/logging/logger.js";
import type { Bar15m } from "../src/strategy/engine082f.js";
import { generate } from "./parity/synthetic.js";

const noop = () => undefined;
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop } as unknown as AppLogger;
const MIN15 = 900_000;
const SYMBOLS = ["DOGEUSDT", "SOLUSDT"];
const data: Record<string, Bar15m[]> = {
  DOGEUSDT: generate(1, 6000, 0, 0.006),
  SOLUSDT: generate(7, 6000, 0, 0.006),
};
const WARMUP_DAYS = 7;
const LIVE_FROM = (data.DOGEUSDT?.[0]?.openTime ?? 0) + WARMUP_DAYS * 96 * MIN15;

const config = parseConfig({
  SYMBOLS: SYMBOLS.join(","),
  WARMUP_DAYS: String(WARMUP_DAYS),
  DATABASE_PATH: ":memory:",
  TAKER_FEE_BPS: "10",
  MAKER_FEE_BPS: "10",
  SLIPPAGE_BPS: "5",
  MAX_POSITION_LEVERAGE: "5",
});

const fakeRest = {
  async assertSymbolsTrading() {},
  async fetch15mRange(symbol: string, start: number, end: number) {
    return (data[symbol] ?? []).filter((b) => b.openTime >= start && b.openTime <= end);
  },
};

class FakeStream {
  handlers: KlineStreamHandlers | null = null;
  connect(_s: readonly string[], h: KlineStreamHandlers) {
    this.handlers = h;
  }
  disconnect() {}
}

async function drive(rt: PaperRuntime, stream: FakeStream, from: number, to: number, skip = new Set<number>()) {
  for (let t = from; t < to; t += MIN15) {
    for (const s of SYMBOLS) {
      const b = data[s]?.find((x) => x.openTime === t);
      if (b && !skip.has(t)) stream.handlers?.onClosedBar(s, b);
    }
  }
  await (rt as unknown as { queue: Promise<void> }).queue;
}

/** Reference: same bars through a bare portfolio, warmup in recovery mode. */
function reference(until: number) {
  const pf = new PaperPortfolio({
    symbolRr: config.symbolRr,
    startingEquity: config.startingEquity,
    riskPercent: config.riskPercent,
    costs: { takerFeeBps: 10, makerFeeBps: 10, slippageBps: 5 },
    limits: { maxActivePositions: 15, maxPositionLeverage: 5, maxTotalLeverage: 0, leverageMode: "cap" },
    checkExitsAfterImmediateFill: true,
    immediateFillAtMarket: true,
  });
  for (let t = data.DOGEUSDT?.[0]?.openTime ?? 0; t < until; t += MIN15) {
    for (const s of SYMBOLS) {
      const b = data[s]?.find((x) => x.openTime === t);
      if (!b) continue;
      const eng = pf.engines.get(s);
      eng?.setRecoveryMode(t < LIVE_FROM);
      pf.on15mBar(s, b);
      eng?.setRecoveryMode(false);
    }
  }
  return pf;
}

describe("PaperRuntime", () => {
  it("live stream == bare portfolio replay, incl. a missed WS bar refilled from REST", async () => {
    const db = new AppDatabase(":memory:", logger);
    const stream = new FakeStream();
    const rt = new PaperRuntime(config, logger, db, fakeRest, stream as never, { notify: noop }, () => LIVE_FROM + MIN15);
    await rt.start();
    const until = LIVE_FROM + 3000 * MIN15;
    await drive(rt, stream, LIVE_FROM, until, new Set([LIVE_FROM + 500 * MIN15, LIVE_FROM + 501 * MIN15]));
    const ref = reference(until);
    expect(rt.portfolio.trades.length).toBeGreaterThan(5);
    expect(rt.portfolio.trades.map((t) => [t.setupId, t.exitTime, t.netPnl])).toEqual(
      ref.trades.map((t) => [t.setupId, t.exitTime, t.netPnl]),
    );
    expect(rt.portfolio.equity).toBe(ref.equity);
  });

  it("restart resumes from SQLite: positions, pending orders and equity survive, gap refilled", async () => {
    const db = new AppDatabase(":memory:", logger);
    const s1 = new FakeStream();
    const rt1 = new PaperRuntime(config, logger, db, fakeRest, s1 as never, { notify: noop }, () => LIVE_FROM + MIN15);
    await rt1.start();
    const mid = LIVE_FROM + 1500 * MIN15;
    await drive(rt1, s1, LIVE_FROM, mid);
    await rt1.stop();

    // Down for 40 bars, then restart on the same DB.
    const restartAt = mid + 40 * MIN15;
    const s2 = new FakeStream();
    const rt2 = new PaperRuntime(config, logger, db, fakeRest, s2 as never, { notify: noop }, () => restartAt);
    await rt2.start();
    for (const s of SYMBOLS) {
      expect(rt2.portfolio.engines.get(s)?.last15mOpenTime).toBe(restartAt - MIN15);
    }
    const until = LIVE_FROM + 3000 * MIN15;
    await drive(rt2, s2, restartAt, until);

    // Closes during downtime are applied exactly once; equity matches the
    // ledger sum, and nothing was double counted.
    const ledgerEquity =
      config.startingEquity +
      rt1.portfolio.trades.reduce((a, t) => a + t.netPnl, 0) +
      rt2.portfolio.trades.reduce((a, t) => a + t.netPnl, 0);
    expect(rt2.portfolio.equity).toBeCloseTo(ledgerEquity, 6);
    expect(rt2.portfolio.trades.length).toBeGreaterThan(0);
  });

  it("close ledger is idempotent", () => {
    const db = new AppDatabase(":memory:", logger);
    const t = {
      symbol: "X", side: "long" as const, setupId: "s1", divergenceTime: 0, confirmationTime: 0, entryTime: 0, exitTime: 1,
      entry: 1, stop: 0.9, takeProfit: 1.2, exitPrice: 1.2, qty: 1, rr: 2, pnl: 0.2, outcome: "TP",
      fillReason: "IMMEDIATE_FILL" as const, equityAfter: 0, fees: 0, slippage: 0, netPnl: 0.2, portfolioEquityAfter: 10.2,
    };
    const acc = { startingEquity: 10, equity: 10.2, peakEquity: 10.2, maxDrawdown: 0 };
    expect(db.recordClose(t, acc)).toBe(true);
    expect(db.recordClose(t, acc)).toBe(false);
  });
});
