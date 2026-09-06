import { Decimal as DecimalJs } from "decimal.js";

DecimalJs.set({ precision: 40, rounding: DecimalJs.ROUND_HALF_UP });

export type DecimalInput = DecimalJs.Value;

/**
 * Fixed-point wrapper. All money, qty, price, volume, and CVD values go through this.
 * Do not use IEEE Number for execution-critical arithmetic.
 */
export class Dec {
  private readonly inner: DecimalJs;

  private constructor(inner: DecimalJs) {
    this.inner = inner;
  }

  static zero(): Dec {
    return new Dec(new DecimalJs(0));
  }

  static from(value: DecimalInput | Dec): Dec {
    if (value instanceof Dec) {
      return value;
    }
    return new Dec(new DecimalJs(value));
  }

  add(other: DecimalInput | Dec): Dec {
    return new Dec(this.inner.plus(Dec.from(other).inner));
  }

  sub(other: DecimalInput | Dec): Dec {
    return new Dec(this.inner.minus(Dec.from(other).inner));
  }

  mul(other: DecimalInput | Dec): Dec {
    return new Dec(this.inner.times(Dec.from(other).inner));
  }

  div(other: DecimalInput | Dec): Dec {
    const denom = Dec.from(other);
    if (denom.isZero()) {
      throw new Error("Division by zero");
    }
    return new Dec(this.inner.div(denom.inner));
  }

  abs(): Dec {
    return new Dec(this.inner.abs());
  }

  neg(): Dec {
    return new Dec(this.inner.neg());
  }

  cmp(other: DecimalInput | Dec): number {
    return this.inner.cmp(Dec.from(other).inner);
  }

  eq(other: DecimalInput | Dec): boolean {
    return this.cmp(other) === 0;
  }

  gt(other: DecimalInput | Dec): boolean {
    return this.cmp(other) > 0;
  }

  gte(other: DecimalInput | Dec): boolean {
    return this.cmp(other) >= 0;
  }

  lt(other: DecimalInput | Dec): boolean {
    return this.cmp(other) < 0;
  }

  lte(other: DecimalInput | Dec): boolean {
    return this.cmp(other) <= 0;
  }

  isZero(): boolean {
    return this.inner.isZero();
  }

  isPositive(): boolean {
    return this.inner.gt(0);
  }

  isNegative(): boolean {
    return this.inner.lt(0);
  }

  min(other: DecimalInput | Dec): Dec {
    return this.lt(other) ? this : Dec.from(other);
  }

  max(other: DecimalInput | Dec): Dec {
    return this.gt(other) ? this : Dec.from(other);
  }

  /** Round toward -inf to a positive step (Binance quantity). */
  floorToStep(step: DecimalInput | Dec): Dec {
    const s = Dec.from(step);
    if (!s.isPositive()) {
      throw new Error("step must be positive");
    }
    return new Dec(this.inner.div(s.inner).toDecimalPlaces(0, DecimalJs.ROUND_FLOOR).times(s.inner));
  }

  /** Round to nearest tick, half-up. */
  roundToTick(tick: DecimalInput | Dec): Dec {
    const t = Dec.from(tick);
    if (!t.isPositive()) {
      throw new Error("tick must be positive");
    }
    return new Dec(this.inner.div(t.inner).toDecimalPlaces(0, DecimalJs.ROUND_HALF_UP).times(t.inner));
  }

  /** Round down to tick (safer for long SL / short TP). */
  floorToTick(tick: DecimalInput | Dec): Dec {
    return this.floorToStep(tick);
  }

  /** Round up to tick (safer for short SL / long TP). */
  ceilToTick(tick: DecimalInput | Dec): Dec {
    const t = Dec.from(tick);
    if (!t.isPositive()) {
      throw new Error("tick must be positive");
    }
    return new Dec(this.inner.div(t.inner).toDecimalPlaces(0, DecimalJs.ROUND_CEIL).times(t.inner));
  }

  toFixed(dp = 8): string {
    return this.inner.toFixed(dp);
  }

  toString(): string {
    return this.inner.toString();
  }

  /**
   * Only for logging / dimensionless ratios. Never for order sizing.
   */
  toNumberUnsafe(): number {
    return this.inner.toNumber();
  }
}
