import { Dec } from "../domain/decimal.js";
import { takerVolumes } from "../marketData/trueCvd.js";
import type { ClosedCandle } from "../domain/types.js";

export interface CvdPoint {
  openTime: number;
  delta: Dec;
  cvd: Dec;
  takerBuy: Dec;
  takerSell: Dec;
}

/**
 * Running True CVD. Stateful per symbol. Never mix symbols.
 */
export class CvdAccumulator {
  private cvd: Dec = Dec.zero();
  private lastOpenTime: number | null = null;
  private readonly series: CvdPoint[] = [];

  constructor(private readonly maxBars: number) {}

  reset(): void {
    this.cvd = Dec.zero();
    this.lastOpenTime = null;
    this.series.length = 0;
  }

  getCurrent(): Dec {
    return this.cvd;
  }

  getSeries(): readonly CvdPoint[] {
    return this.series;
  }

  lastProcessedOpenTime(): number | null {
    return this.lastOpenTime;
  }

  /**
   * Apply a closed candle. Duplicate openTime is ignored (returns null).
   */
  applyClosedCandle(candle: ClosedCandle): CvdPoint | null {
    if (this.lastOpenTime !== null && candle.openTime === this.lastOpenTime) {
      return null;
    }
    if (this.lastOpenTime !== null && candle.openTime < this.lastOpenTime) {
      throw new Error(
        `Out-of-order candle for ${candle.symbol}: ${candle.openTime} < ${this.lastOpenTime}`,
      );
    }
    const { takerBuy, takerSell, delta } = takerVolumes(candle);
    this.cvd = this.cvd.add(delta);
    this.lastOpenTime = candle.openTime;
    const point: CvdPoint = {
      openTime: candle.openTime,
      delta,
      cvd: this.cvd,
      takerBuy,
      takerSell,
    };
    this.series.push(point);
    if (this.series.length > this.maxBars) {
      this.series.shift();
    }
    return point;
  }
}
