import { Dec } from "../domain/decimal.js";
import { LiveTradingDisabledError } from "../domain/errors.js";
import type { ClosedCandle, ClosedTrade, Position, SizedOrder } from "../domain/types.js";
import type { PositionTracker } from "../positions/positionTracker.js";
import type { AppLogger } from "../logging/logger.js";
import type { AppConfig } from "../config/schema.js";

export interface Executor {
  execute(order: SizedOrder): Promise<Position>;
  onClosedCandle(candle: ClosedCandle): Promise<ClosedTrade | null>;
  equity(): Dec;
}

export class PaperExecutor implements Executor {
  private balance: Dec;

  constructor(
    startingBalance: Dec,
    private readonly positions: PositionTracker,
    private readonly logger: AppLogger,
    private readonly now: () => number,
  ) {
    this.balance = startingBalance;
  }

  equity(): Dec {
    return this.balance;
  }

  async execute(order: SizedOrder): Promise<Position> {
    const s = order.signal;
    return this.positions.openPosition({
      symbol: s.symbol,
      side: s.side,
      quantity: order.quantity,
      entry: s.entry,
      stopLoss: s.stopLoss,
      takeProfit: s.takeProfit,
      rr: s.rr,
      openedAt: this.now(),
      signalCandleOpenTime: s.candleOpenTime,
      cvd: s.cvd.toString(),
      divergenceKind: s.divergence.kind,
      absorptionKind: s.absorption.kind,
      raw: {
        strategy: s.strategyName,
        delta: s.delta.toString(),
        riskAmount: order.riskAmount.toString(),
        notional: order.notional.toString(),
      },
    });
  }

  async onClosedCandle(candle: ClosedCandle): Promise<ClosedTrade | null> {
    const pos = this.positions.get(candle.symbol);
    if (!pos) {
      return null;
    }
    const hit = resolvePaperExit(pos, candle);
    if (!hit) {
      return null;
    }
    const closed = this.positions.closePosition(candle.symbol, hit.price, hit.reason, this.now());
    this.balance = this.balance.add(closed.pnl);
    this.logger.info(
      { symbol: candle.symbol, balance: this.balance.toString(), pnl: closed.pnl.toString() },
      "paper_equity_updated",
    );
    return closed;
  }
}

export function resolvePaperExit(
  pos: Position,
  candle: ClosedCandle,
): { price: Dec; reason: "SL" | "TP" } | null {
  // Conservative: if both SL and TP would print on the same candle, assume SL.
  if (pos.side === "LONG") {
    if (candle.low.lte(pos.stopLoss)) {
      return { price: pos.stopLoss, reason: "SL" };
    }
    if (candle.high.gte(pos.takeProfit)) {
      return { price: pos.takeProfit, reason: "TP" };
    }
    return null;
  }
  if (candle.high.gte(pos.stopLoss)) {
    return { price: pos.stopLoss, reason: "SL" };
  }
  if (candle.low.lte(pos.takeProfit)) {
    return { price: pos.takeProfit, reason: "TP" };
  }
  return null;
}

export class LiveExecutor implements Executor {
  constructor(private readonly config: AppConfig) {}

  equity(): Dec {
    throw new LiveTradingDisabledError();
  }

  async execute(): Promise<Position> {
    throw new LiveTradingDisabledError();
  }

  async onClosedCandle(): Promise<ClosedTrade | null> {
    throw new LiveTradingDisabledError();
  }
}

export function createExecutor(
  config: AppConfig,
  positions: PositionTracker,
  logger: AppLogger,
  now: () => number,
): Executor {
  if (config.tradingMode === "LIVE" && config.liveTradingEnabled) {
    return new LiveExecutor(config);
  }
  if (config.tradingMode === "LIVE") {
    logger.warn("LIVE mode requested but LIVE_TRADING_ENABLED is false; using PAPER executor");
  }
  return new PaperExecutor(config.paperStartingBalance, positions, logger, now);
}
