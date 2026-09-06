import type { AppConfig } from "../config/schema.js";
import { isLiveAllowed } from "../config/schema.js";
import type { AppLogger } from "../logging/logger.js";
import type { ClosedCandle, SizedOrder, SymbolFilters } from "../domain/types.js";
import { isSignal } from "../domain/types.js";
import { RiskRejectedError } from "../domain/errors.js";
import { CvdDivergenceAbsorptionStrategy } from "../signalEngine/cvdDivergenceAbsorptionStrategy.js";
import { RiskManager } from "../risk/riskManager.js";
import type { PositionTracker } from "../positions/positionTracker.js";
import type { Executor } from "../executor/paperExecutor.js";
import type { TradeJournal } from "../journal/tradeJournal.js";
import type { Notifier } from "../telegram/telegramNotifier.js";
import type { Reconciler } from "../reconciliation/reconciler.js";
import type { MarketDataService } from "../marketData/marketDataService.js";

export class TradingEngine {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
    private readonly strategy: CvdDivergenceAbsorptionStrategy,
    private readonly risk: RiskManager,
    private readonly positions: PositionTracker,
    private readonly executor: Executor,
    private readonly journal: TradeJournal,
    private readonly notifier: Notifier,
    private readonly reconciler: Reconciler,
    private readonly marketData: MarketDataService | null,
    private readonly filters: Map<string, SymbolFilters>,
  ) {}

  async bootstrap(history: Map<string, ClosedCandle[]>): Promise<void> {
    for (const symbol of this.config.symbols) {
      const candles = history.get(symbol) ?? [];
      this.strategy.resync(symbol, candles);
    }
    this.logger.info(
      { mode: this.config.tradingMode, liveAllowed: isLiveAllowed(this.config) },
      "engine_started",
    );
  }

  async onClosedCandle(candle: ClosedCandle): Promise<SizedOrder | null> {
    const closed = await this.executor.onClosedCandle(candle);
    if (closed) {
      this.journal.recordClose(closed);
      await this.notifier.notifyClosed(closed);
    }

    const result = this.strategy.onClosedCandle(candle);
    if (!isSignal(result)) {
      this.logger.debug({ symbol: candle.symbol, reason: result.reason }, "hold");
      return null;
    }

    if (this.positions.hasOpen(candle.symbol)) {
      this.logger.info({ symbol: candle.symbol }, "duplicate_signal_open_position");
      return null;
    }

    const filters = this.filters.get(candle.symbol);
    if (!filters) {
      this.logger.warn({ symbol: candle.symbol }, "missing_symbol_filters");
      return null;
    }

    try {
      const sized = this.risk.size(result, filters, {
        equity: this.executor.equity(),
        hasOpenPosition: this.positions.hasOpen(candle.symbol),
      });
      this.journal.recordSignal(sized);
      const position = await this.executor.execute(sized);
      this.journal.recordOpen(position);
      await this.notifier.notifySizedOrder(sized);
      return sized;
    } catch (err) {
      if (err instanceof RiskRejectedError) {
        this.logger.info({ symbol: candle.symbol, err: err.message }, "signal_rejected_by_risk");
        this.journal.recordRiskReject(candle.symbol, err.message);
        return null;
      }
      throw err;
    }
  }

  async resyncFromHistory(history: Map<string, ClosedCandle[]>): Promise<void> {
    for (const [symbol, candles] of history) {
      this.strategy.resync(symbol, candles);
    }
    this.reconciler.reconcile();
  }

  reconcile(): void {
    this.reconciler.reconcile();
  }
}
