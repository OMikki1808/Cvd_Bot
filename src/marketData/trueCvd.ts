import type { ClosedCandle } from "../domain/types.js";
import { Dec } from "../domain/decimal.js";

/**
 * True candle delta from taker-initiated volume.
 *
 * Binance kline field `takerBuyBaseAssetVolume` is buyer-initiated (taker buy) base volume.
 * Taker sell = total volume - taker buy.
 * delta = takerBuy - takerSell = 2 * takerBuy - volume
 *
 * This is NOT (close-low)/(high-low)*volume.
 */
export function takerVolumes(candle: ClosedCandle): { takerBuy: Dec; takerSell: Dec; delta: Dec } {
  const takerBuy = candle.takerBuyBaseVolume;
  const takerSell = candle.volume.sub(takerBuy);
  if (takerSell.isNegative()) {
    throw new Error(
      `Invalid taker volumes for ${candle.symbol} ${candle.openTime}: takerBuy=${takerBuy.toString()} volume=${candle.volume.toString()}`,
    );
  }
  const delta = takerBuy.sub(takerSell);
  return { takerBuy, takerSell, delta };
}

/**
 * True trade delta from an aggTrade.
 * isBuyerMaker=true  → sell-initiated (seller is taker) → negative delta
 * isBuyerMaker=false → buy-initiated  (buyer is taker)  → positive delta
 */
export function aggTradeDelta(quantity: Dec, isBuyerMaker: boolean): Dec {
  return isBuyerMaker ? quantity.neg() : quantity;
}
