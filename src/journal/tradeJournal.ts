import type { ClosedTrade, Position, SizedOrder } from "../domain/types.js";
import type { AppDatabase } from "../db/database.js";

export class TradeJournal {
  constructor(private readonly db: AppDatabase) {}

  recordSignal(order: SizedOrder): void {
    this.db.insertEvent("signal", order.signal.symbol, {
      side: order.signal.side,
      entry: order.signal.entry.toString(),
      sl: order.signal.stopLoss.toString(),
      tp: order.signal.takeProfit.toString(),
      rr: order.signal.rr.toString(),
      qty: order.quantity.toString(),
      cvd: order.signal.cvd.toString(),
      divergence: order.signal.divergence.kind,
      absorption: order.signal.absorption.kind,
    });
  }

  recordOpen(position: Position): void {
    this.db.insertEvent("position_open", position.symbol, {
      id: position.id,
      side: position.side,
      qty: position.quantity.toString(),
      entry: position.entry.toString(),
    });
  }

  recordClose(trade: ClosedTrade): void {
    this.db.insertEvent("position_close", trade.position.symbol, {
      id: trade.position.id,
      reason: trade.reason,
      exit: trade.exit.toString(),
      pnl: trade.pnl.toString(),
    });
  }

  recordRiskReject(symbol: string, reason: string): void {
    this.db.insertEvent("risk_reject", symbol, { reason });
  }
}
