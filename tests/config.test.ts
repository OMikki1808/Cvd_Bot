import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config/schema.js";
import { REMOVED_STRATEGIES } from "../src/signalEngine/removedStrategies.js";

describe("config defaults", () => {
  it("defaults to PAPER with LIVE gated off", () => {
    const cfg = parseConfig({});
    expect(cfg.tradingMode).toBe("PAPER");
    expect(cfg.liveTradingEnabled).toBe(false);
    expect(cfg.strategy.name).toBe("cvd_divergence_absorption");
    expect(cfg.symbols.length).toBeGreaterThan(0);
  });

  it("does not register removed RSI strategies", () => {
    const cfg = parseConfig({});
    expect(REMOVED_STRATEGIES.includes(cfg.strategy.name as never)).toBe(false);
  });
});
