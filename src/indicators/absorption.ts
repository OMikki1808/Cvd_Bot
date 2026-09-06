import { Dec } from "../domain/decimal.js";
import type { AbsorptionSignal, ClosedCandle } from "../domain/types.js";

export interface AbsorptionParams {
  deltaSmaPeriod: number;
  volumeSmaPeriod: number;
  atrPeriod: number;
  deltaMult: Dec;
  volumeMult: Dec;
  rangeAtrMult: Dec;
  closeLocation: Dec;
}

function sma(values: readonly Dec[], period: number): Dec | null {
  if (values.length < period) {
    return null;
  }
  let sum = Dec.zero();
  for (let i = values.length - period; i < values.length; i++) {
    const v = values[i];
    if (!v) {
      return null;
    }
    sum = sum.add(v);
  }
  return sum.div(period);
}

function trueRange(candles: readonly ClosedCandle[], index: number): Dec {
  const cur = candles[index];
  if (!cur) {
    return Dec.zero();
  }
  if (index === 0) {
    return cur.high.sub(cur.low);
  }
  const prev = candles[index - 1];
  if (!prev) {
    return cur.high.sub(cur.low);
  }
  const hl = cur.high.sub(cur.low);
  const hc = cur.high.sub(prev.close).abs();
  const lc = cur.low.sub(prev.close).abs();
  return hl.max(hc).max(lc);
}

export function atr(candles: readonly ClosedCandle[], period: number): Dec | null {
  if (candles.length < period + 1) {
    return null;
  }
  const ranges: Dec[] = [];
  const start = candles.length - period;
  for (let i = start; i < candles.length; i++) {
    ranges.push(trueRange(candles, i));
  }
  return sma(ranges, period);
}

function closeLocation(candle: ClosedCandle): Dec {
  const range = candle.high.sub(candle.low);
  if (range.isZero()) {
    return Dec.from("0.5");
  }
  return candle.close.sub(candle.low).div(range);
}

/**
 * Absorption: aggressive taker flow without corresponding price travel.
 *
 * Bullish: large negative delta (sellers hitting bid) AND close in the upper part of the range.
 * Bearish: large positive delta (buyers lifting offer) AND close in the lower part of the range.
 *
 * Requires elevated |delta| vs SMA(|delta|) and elevated volume, with range <= ATR * mult.
 */
export function detectAbsorption(
  candles: readonly ClosedCandle[],
  deltas: readonly Dec[],
  volumes: readonly Dec[],
  params: AbsorptionParams,
): AbsorptionSignal | null {
  if (candles.length === 0 || deltas.length !== candles.length || volumes.length !== candles.length) {
    return null;
  }
  const last = candles[candles.length - 1];
  const lastDelta = deltas[deltas.length - 1];
  const lastVolume = volumes[volumes.length - 1];
  if (!last || !lastDelta || !lastVolume) {
    return null;
  }

  const absDeltas = deltas.map((d) => d.abs());
  const avgAbsDelta = sma(absDeltas, params.deltaSmaPeriod);
  const avgVolume = sma(volumes, params.volumeSmaPeriod);
  const avgAtr = atr(candles, params.atrPeriod);
  if (!avgAbsDelta || !avgVolume || !avgAtr) {
    return null;
  }

  const range = last.high.sub(last.low);
  const highEnergy =
    lastDelta.abs().gte(avgAbsDelta.mul(params.deltaMult)) &&
    lastVolume.gte(avgVolume.mul(params.volumeMult));
  const tightRange = range.lte(avgAtr.mul(params.rangeAtrMult));
  if (!highEnergy || !tightRange) {
    return null;
  }

  const loc = closeLocation(last);
  if (lastDelta.isNegative() && loc.gte(params.closeLocation)) {
    return {
      kind: "BULLISH",
      openTime: last.openTime,
      high: last.high,
      low: last.low,
      close: last.close,
      delta: lastDelta,
      volume: lastVolume,
    };
  }
  const bearishLoc = Dec.from(1).sub(params.closeLocation);
  if (lastDelta.isPositive() && loc.lte(bearishLoc)) {
    return {
      kind: "BEARISH",
      openTime: last.openTime,
      high: last.high,
      low: last.low,
      close: last.close,
      delta: lastDelta,
      volume: lastVolume,
    };
  }
  return null;
}
