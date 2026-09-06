import { randomUUID } from "node:crypto";
import type { ClosedTrade, Position, Side } from "../domain/types.js";
import type { Dec } from "../domain/decimal.js";
import type { AppDatabase } from "../db/database.js";
import type { AppLogger } from "../logging/logger.js";

export class PositionTracker {
  private readonly open = new Map<string, Position>();

  constructor(
    private readonly db: AppDatabase,
    private readonly logger: AppLogger,
  ) {}

  get(symbol: string): Position | undefined {
    return this.open.get(symbol);
  }

  hasOpen(symbol: string): boolean {
    return this.open.has(symbol);
  }

  openPosition(input: {
    symbol: string;
    side: Side;
    quantity: Dec;
    entry: Dec;
    stopLoss: Dec;
    takeProfit: Dec;
    rr: Dec;
    openedAt: number;
    signalCandleOpenTime: number;
    cvd: string;
    divergenceKind: string;
    absorptionKind: string;
    raw: unknown;
  }): Position {
    if (this.open.has(input.symbol)) {
      throw new Error(`Position already open for ${input.symbol}`);
    }
    const position: Position = {
      id: randomUUID(),
      symbol: input.symbol,
      side: input.side,
      quantity: input.quantity,
      entry: input.entry,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      rr: input.rr,
      openedAt: input.openedAt,
      signalCandleOpenTime: input.signalCandleOpenTime,
    };
    this.open.set(input.symbol, position);
    this.db.insertTrade({
      id: position.id,
      symbol: position.symbol,
      side: position.side,
      quantity: position.quantity.toString(),
      entry: position.entry.toString(),
      stopLoss: position.stopLoss.toString(),
      takeProfit: position.takeProfit.toString(),
      rr: position.rr.toString(),
      openedAt: position.openedAt,
      signalCandleOpenTime: position.signalCandleOpenTime,
      cvd: input.cvd,
      divergenceKind: input.divergenceKind,
      absorptionKind: input.absorptionKind,
      rawJson: JSON.stringify(input.raw),
    });
    this.logger.info(
      {
        symbol: position.symbol,
        side: position.side,
        qty: position.quantity.toString(),
        entry: position.entry.toString(),
        sl: position.stopLoss.toString(),
        tp: position.takeProfit.toString(),
      },
      "position_opened",
    );
    return position;
  }

  closePosition(symbol: string, exit: Dec, reason: ClosedTrade["reason"], closedAt: number): ClosedTrade {
    const position = this.open.get(symbol);
    if (!position) {
      throw new Error(`No open position for ${symbol}`);
    }
    const direction = position.side === "LONG" ? 1 : -1;
    const pnl = exit.sub(position.entry).mul(position.quantity).mul(direction);
    this.open.delete(symbol);
    this.db.closeTrade(position.id, exit.toString(), pnl.toString(), reason, closedAt);
    this.logger.info(
      { symbol, reason, exit: exit.toString(), pnl: pnl.toString() },
      "position_closed",
    );
    return { position, exit, reason, closedAt, pnl };
  }

  allOpen(): Position[] {
    return [...this.open.values()];
  }
}
