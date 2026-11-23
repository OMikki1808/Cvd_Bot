import { describe, expect, it } from "vitest";
import { runBacktest } from "../src/backtest/runBacktest.js";
import { parseKlineCsv } from "../src/backtest/klineCsv.js";
import { NO_COSTS, NO_LIMITS } from "../src/portfolio/paperPortfolio.js";
import { loadScenarios } from "./parity/runParity.js";
import { generate } from "./parity/synthetic.js";

describe("backtester", () => {
  const sc = loadScenarios().filter((s) => !s.mode || s.mode === "limit1bar");
  const bars = new Map(sc.map((s) => [s.name.toUpperCase(), generate(s.seed, s.bars, s.gapProb, s.vol)]));
  const symbolRr = Object.fromEntries(sc.map((s) => [s.name.toUpperCase(), s.rr]));

  it("isolated + no costs reproduces the Python oracle per symbol", () => {
    const r = runBacktest({
      bars,
      symbolRr,
      startingEquity: 10_000,
      riskPercent: 1,
      costs: NO_COSTS,
      limits: NO_LIMITS,
      isolated: true,
      checkExitsAfterImmediateFill: false,
    });
    for (const s of sc) {
      const st = r.perSymbol.find((p) => p.symbol === s.name.toUpperCase());
      expect(st?.trades).toBe(s.expected.trades.length);
      expect(10_000 + (st?.netPnl ?? 0)).toBeCloseTo(s.expected.finalEquity, 6);
    }
  });

  it("costs only ever reduce PnL and are accounted per trade", () => {
    const base = { bars, symbolRr, startingEquity: 10_000, riskPercent: 1, limits: NO_LIMITS, isolated: false, checkExitsAfterImmediateFill: false };
    const gross = runBacktest({ ...base, costs: NO_COSTS });
    const net = runBacktest({ ...base, costs: { takerFeeBps: 10, makerFeeBps: 10, slippageBps: 5 } });
    expect(net.feesPaid).toBeGreaterThan(0);
    expect(net.finalEquity).toBeLessThan(gross.finalEquity);
    for (const t of net.trades) expect(t.netPnl).toBeCloseTo(t.pnl - t.fees - t.slippage, 9);
  });

  it("leverage cap bounds open notional", () => {
    const r = runBacktest({
      bars,
      symbolRr,
      startingEquity: 10_000,
      riskPercent: 1,
      costs: NO_COSTS,
      limits: { maxActivePositions: 2, maxPositionLeverage: 1, maxTotalLeverage: 1.5, leverageMode: "cap" },
      isolated: false,
      checkExitsAfterImmediateFill: false,
    });
    expect(r.maxConcurrentPositions).toBeLessThanOrEqual(2);
    expect(r.maxOpenNotionalX).toBeLessThanOrEqual(1.5 + 1e-9);
  });

  it("parses Binance Vision CSV with microsecond timestamps", () => {
    const [b] = parseKlineCsv("1735689600000000,1,2,0.5,1.5,10,1735690499999999,0,5,6,0,0\n");
    expect(b?.openTime).toBe(1735689600000);
    expect(b?.takerBuyBase).toBe(6);
  });
});
