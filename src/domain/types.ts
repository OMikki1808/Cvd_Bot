import type { Dec } from "./decimal.js";

export type Side = "LONG" | "SHORT";
export type SignalSide = "LONG" | "SHORT" | "HOLD";
export type TradingMode = "PAPER" | "LIVE";
export type DivergenceKind = "BULLISH" | "BEARISH";
export type AbsorptionKind = "BULLISH" | "BEARISH";

export interface ClosedCandle {
  symbol: string;
  timeframe: string;
  openTime: number;
  closeTime: number;
  open: Dec;
  high: Dec;
  low: Dec;
  close: Dec;
  volume: Dec;
  /** Buyer-initiated (taker buy) base volume from Binance kline or aggTrades. */
  takerBuyBaseVolume: Dec;
  tradeCount: number;
}

export interface CandleDelta {
  candle: ClosedCandle;
  /** takerBuy - takerSell */
  delta: Dec;
  takerBuy: Dec;
  takerSell: Dec;
  cvd: Dec;
}

export interface AggTrade {
  symbol: string;
  aggTradeId: number;
  price: Dec;
  quantity: Dec;
  timestamp: number;
  /** true ⇒ buyer is maker ⇒ seller is taker (sell-initiated). */
  isBuyerMaker: boolean;
}

export interface PivotPoint {
  index: number;
  openTime: number;
  price: Dec;
  cvd: Dec;
  kind: "HIGH" | "LOW";
}

export interface DivergenceSignal {
  kind: DivergenceKind;
  current: PivotPoint;
  previous: PivotPoint;
}

export interface AbsorptionSignal {
  kind: AbsorptionKind;
  openTime: number;
  high: Dec;
  low: Dec;
  close: Dec;
  delta: Dec;
  volume: Dec;
}

export interface StrategySignal {
  strategyName: string;
  symbol: string;
  timeframe: string;
  side: Side;
  candleOpenTime: number;
  timestamp: number;
  entry: Dec;
  stopLoss: Dec;
  takeProfit: Dec;
  rr: Dec;
  cvd: Dec;
  delta: Dec;
  divergence: DivergenceSignal;
  absorption: AbsorptionSignal;
}

export interface HoldResult {
  side: "HOLD";
  reason: string;
}

export type StrategyResult = StrategySignal | HoldResult;

export interface SizedOrder {
  signal: StrategySignal;
  quantity: Dec;
  notional: Dec;
  riskAmount: Dec;
  equity: Dec;
  tickSize: Dec;
  stepSize: Dec;
}

export interface SymbolFilters {
  symbol: string;
  tickSize: Dec;
  stepSize: Dec;
  minQty: Dec;
  minNotional: Dec;
}

export interface Position {
  id: string;
  symbol: string;
  side: Side;
  quantity: Dec;
  entry: Dec;
  stopLoss: Dec;
  takeProfit: Dec;
  rr: Dec;
  openedAt: number;
  signalCandleOpenTime: number;
}

export interface ClosedTrade {
  position: Position;
  exit: Dec;
  reason: "SL" | "TP" | "MANUAL";
  closedAt: number;
  pnl: Dec;
}

export function isSignal(result: StrategyResult): result is StrategySignal {
  return result.side !== "HOLD";
}
