import { Dec } from "../domain/decimal.js";
import type { AggTrade } from "../domain/types.js";
import { aggTradeDelta } from "./trueCvd.js";

/**
 * Accumulates taker delta for the currently forming candle.
 * Deduplicates by aggTradeId. Used for forming-candle CVD and reconnect restore.
 * Strategy signals still fire only on closed klines.
 */
export class FormingCandleDelta {
  private lastId = -1;
  private delta = Dec.zero();
  private buy = Dec.zero();
  private sell = Dec.zero();
  openTime = 0;

  reset(openTime: number): void {
    this.openTime = openTime;
    this.lastId = -1;
    this.delta = Dec.zero();
    this.buy = Dec.zero();
    this.sell = Dec.zero();
  }

  apply(trade: AggTrade): boolean {
    if (trade.aggTradeId <= this.lastId) {
      return false;
    }
    this.lastId = trade.aggTradeId;
    const d = aggTradeDelta(trade.quantity, trade.isBuyerMaker);
    this.delta = this.delta.add(d);
    if (trade.isBuyerMaker) {
      this.sell = this.sell.add(trade.quantity);
    } else {
      this.buy = this.buy.add(trade.quantity);
    }
    return true;
  }

  snapshot(): { delta: Dec; buy: Dec; sell: Dec; lastId: number } {
    return { delta: this.delta, buy: this.buy, sell: this.sell, lastId: this.lastId };
  }
}
