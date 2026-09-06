import type { DivergenceSignal, PivotPoint } from "../domain/types.js";

export interface DivergenceParams {
  rangeLower: number;
  rangeUpper: number;
}

function barsBetween(current: PivotPoint, previous: PivotPoint): number {
  return current.index - previous.index;
}

function inLookback(distance: number, params: DivergenceParams): boolean {
  return distance >= params.rangeLower && distance <= params.rangeUpper;
}

/**
 * Regular bullish divergence: price lower low, CVD higher low.
 */
export function detectBullishDivergence(
  currentLow: PivotPoint,
  previousLows: readonly PivotPoint[],
  params: DivergenceParams,
): DivergenceSignal | null {
  for (let i = previousLows.length - 1; i >= 0; i--) {
    const prev = previousLows[i];
    if (!prev) {
      continue;
    }
    const distance = barsBetween(currentLow, prev);
    if (distance < params.rangeLower) {
      continue;
    }
    if (distance > params.rangeUpper) {
      break;
    }
    if (currentLow.price.lt(prev.price) && currentLow.cvd.gt(prev.cvd)) {
      return { kind: "BULLISH", current: currentLow, previous: prev };
    }
    if (inLookback(distance, params)) {
      // Use nearest previous pivot in range only.
      break;
    }
  }
  return null;
}

/**
 * Regular bearish divergence: price higher high, CVD lower high.
 */
export function detectBearishDivergence(
  currentHigh: PivotPoint,
  previousHighs: readonly PivotPoint[],
  params: DivergenceParams,
): DivergenceSignal | null {
  for (let i = previousHighs.length - 1; i >= 0; i--) {
    const prev = previousHighs[i];
    if (!prev) {
      continue;
    }
    const distance = barsBetween(currentHigh, prev);
    if (distance < params.rangeLower) {
      continue;
    }
    if (distance > params.rangeUpper) {
      break;
    }
    if (currentHigh.price.gt(prev.price) && currentHigh.cvd.lt(prev.cvd)) {
      return { kind: "BEARISH", current: currentHigh, previous: prev };
    }
    if (inLookback(distance, params)) {
      break;
    }
  }
  return null;
}
