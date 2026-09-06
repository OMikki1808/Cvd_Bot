import type { ClosedCandle, PivotPoint } from "../domain/types.js";
import type { Dec } from "../domain/decimal.js";

export interface PivotParams {
  left: number;
  right: number;
}

/**
 * Confirmed (non-repainting) fractal pivots.
 * A pivot at index i is only known after `right` bars have closed after i.
 *
 * Pivot high at i:
 *   high[i] > high[i-k] for k=1..left
 *   high[i] > high[i+k] for k=1..right
 *
 * Matches standard ta.pivothigh / ta.pivotlow strict-fractal ports.
 */
export function confirmedPivotIndex(length: number, right: number): number | null {
  const i = length - 1 - right;
  return i >= 0 ? i : null;
}

export function isPivotHigh(
  highs: readonly Dec[],
  index: number,
  left: number,
  right: number,
): boolean {
  const value = highs[index];
  if (value === undefined) {
    return false;
  }
  if (index - left < 0 || index + right >= highs.length) {
    return false;
  }
  for (let k = 1; k <= left; k++) {
    const other = highs[index - k];
    if (other === undefined || other.gte(value)) {
      return false;
    }
  }
  for (let k = 1; k <= right; k++) {
    const other = highs[index + k];
    if (other === undefined || other.gte(value)) {
      return false;
    }
  }
  return true;
}

export function isPivotLow(
  lows: readonly Dec[],
  index: number,
  left: number,
  right: number,
): boolean {
  const value = lows[index];
  if (value === undefined) {
    return false;
  }
  if (index - left < 0 || index + right >= lows.length) {
    return false;
  }
  for (let k = 1; k <= left; k++) {
    const other = lows[index - k];
    if (other === undefined || other.lte(value)) {
      return false;
    }
  }
  for (let k = 1; k <= right; k++) {
    const other = lows[index + k];
    if (other === undefined || other.lte(value)) {
      return false;
    }
  }
  return true;
}

export function detectConfirmedPivots(
  candles: readonly ClosedCandle[],
  cvd: readonly Dec[],
  params: PivotParams,
): { high: PivotPoint | null; low: PivotPoint | null } {
  const index = confirmedPivotIndex(candles.length, params.right);
  if (index === null) {
    return { high: null, low: null };
  }
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const candle = candles[index];
  const cvdAt = cvd[index];
  if (!candle || !cvdAt) {
    return { high: null, low: null };
  }

  const high = isPivotHigh(highs, index, params.left, params.right)
    ? {
        index,
        openTime: candle.openTime,
        price: candle.high,
        cvd: cvdAt,
        kind: "HIGH" as const,
      }
    : null;

  const low = isPivotLow(lows, index, params.left, params.right)
    ? {
        index,
        openTime: candle.openTime,
        price: candle.low,
        cvd: cvdAt,
        kind: "LOW" as const,
      }
    : null;

  return { high, low };
}
