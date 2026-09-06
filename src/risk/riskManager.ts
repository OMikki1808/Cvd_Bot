import { Dec } from "../domain/decimal.js";
import { RiskRejectedError } from "../domain/errors.js";
import type { SizedOrder, StrategySignal, SymbolFilters } from "../domain/types.js";
import type { AppConfig } from "../config/schema.js";

export interface RiskContext {
  equity: Dec;
  hasOpenPosition: boolean;
}

/**
 * CVD-strategy risk: size from equity * risk% / stop distance.
 * Symbol-specific RR. Tick/step/minNotional from Binance filters.
 */
export class RiskManager {
  constructor(private readonly config: AppConfig) {}

  rrFor(symbol: string): Dec {
    return this.config.symbolRr[symbol] ?? this.config.defaultRr;
  }

  size(signal: StrategySignal, filters: SymbolFilters, ctx: RiskContext): SizedOrder {
    if (ctx.hasOpenPosition) {
      throw new RiskRejectedError(`${signal.symbol}: position already open`);
    }

    const rr = this.rrFor(signal.symbol);
    const tick = filters.tickSize;
    const buffer = tick.mul(this.config.strategy.slBufferTicks);

    let stopLoss = signal.stopLoss;
    let entry = signal.entry.roundToTick(tick);

    if (signal.side === "LONG") {
      stopLoss = stopLoss.sub(buffer).floorToTick(tick);
      if (!stopLoss.lt(entry)) {
        throw new RiskRejectedError(`${signal.symbol}: LONG stop must be below entry`);
      }
    } else {
      stopLoss = stopLoss.add(buffer).ceilToTick(tick);
      if (!stopLoss.gt(entry)) {
        throw new RiskRejectedError(`${signal.symbol}: SHORT stop must be above entry`);
      }
    }

    const stopDistance = entry.sub(stopLoss).abs();
    if (stopDistance.isZero()) {
      throw new RiskRejectedError(`${signal.symbol}: zero stop distance`);
    }

    const riskAmount = ctx.equity.mul(this.config.riskPercent).div(100);
    let quantity = riskAmount.div(stopDistance).floorToStep(filters.stepSize);
    if (quantity.lt(filters.minQty)) {
      throw new RiskRejectedError(
        `${signal.symbol}: qty ${quantity.toString()} < minQty ${filters.minQty.toString()}`,
      );
    }

    const notional = quantity.mul(entry);
    if (notional.lt(filters.minNotional)) {
      throw new RiskRejectedError(
        `${signal.symbol}: notional ${notional.toString()} < minNotional ${filters.minNotional.toString()}`,
      );
    }

    const takeProfit =
      signal.side === "LONG"
        ? entry.add(stopDistance.mul(rr)).roundToTick(tick)
        : entry.sub(stopDistance.mul(rr)).roundToTick(tick);

    const sizedSignal: StrategySignal = {
      ...signal,
      entry,
      stopLoss,
      takeProfit,
      rr,
    };

    return {
      signal: sizedSignal,
      quantity,
      notional,
      riskAmount,
      equity: ctx.equity,
      tickSize: filters.tickSize,
      stepSize: filters.stepSize,
    };
  }
}
