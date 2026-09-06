import { Dec } from "../src/domain/decimal.js";
import type { ClosedCandle, SymbolFilters } from "../src/domain/types.js";
import type { StrategyConfig } from "../src/config/schema.js";
import { parseConfig } from "../src/config/schema.js";

export const TEST_STRATEGY: StrategyConfig = {
  ...parseConfig({
    CVD_WARMUP_BARS: "30",
    CVD_PIVOT_LEFT: "2",
    CVD_PIVOT_RIGHT: "2",
    CVD_DIV_RANGE_LOWER: "3",
    CVD_DIV_RANGE_UPPER: "40",
    CVD_CONFIRMATION_WINDOW: "8",
    CVD_ATR_PERIOD: "5",
    CVD_DELTA_SMA_PERIOD: "5",
    CVD_VOLUME_SMA_PERIOD: "5",
    CVD_ABSORPTION_DELTA_MULT: "1.2",
    CVD_ABSORPTION_VOLUME_MULT: "1.1",
    CVD_ABSORPTION_RANGE_ATR_MULT: "2.5",
    CVD_ABSORPTION_CLOSE_LOCATION: "0.5",
    CVD_SL_BUFFER_TICKS: "1",
  }).strategy,
};

export const DEFAULT_FILTERS: SymbolFilters = {
  symbol: "BTCUSDT",
  tickSize: Dec.from("0.1"),
  stepSize: Dec.from("0.001"),
  minQty: Dec.from("0.001"),
  minNotional: Dec.from("5"),
};

export interface CandleInput {
  symbol?: string;
  openTime: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  takerBuy: string;
  timeframe?: string;
}

export function candle(partial: CandleInput): ClosedCandle {
  const tfMs = 5 * 60 * 1000;
  return {
    symbol: partial.symbol ?? "BTCUSDT",
    timeframe: partial.timeframe ?? "5m",
    openTime: partial.openTime,
    closeTime: partial.openTime + tfMs - 1,
    open: Dec.from(partial.open),
    high: Dec.from(partial.high),
    low: Dec.from(partial.low),
    close: Dec.from(partial.close),
    volume: Dec.from(partial.volume),
    takerBuyBaseVolume: Dec.from(partial.takerBuy),
    tradeCount: 10,
  };
}

/** Neutral bar that does not create pivots or absorption by itself. */
export function flatBar(openTime: number, px: string, symbol = "BTCUSDT"): ClosedCandle {
  return candle({
    symbol,
    openTime,
    open: px,
    high: px,
    low: px,
    close: px,
    volume: "10",
    takerBuy: "5",
  });
}
