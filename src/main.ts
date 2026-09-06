import { loadConfig } from "./config/load.js";
import { createLogger } from "./logging/logger.js";
import { AppDatabase } from "./db/database.js";
import { BinanceRestClient } from "./exchange/binanceRest.js";
import { MarketDataService } from "./marketData/marketDataService.js";
import { CvdDivergenceAbsorptionStrategy } from "./signalEngine/cvdDivergenceAbsorptionStrategy.js";
import { RiskManager } from "./risk/riskManager.js";
import { PositionTracker } from "./positions/positionTracker.js";
import { createExecutor } from "./executor/paperExecutor.js";
import { TradeJournal } from "./journal/tradeJournal.js";
import { createNotifier } from "./telegram/telegramNotifier.js";
import { Reconciler } from "./reconciliation/reconciler.js";
import { TradingEngine } from "./app/TradingEngine.js";
import { isLiveAllowed } from "./config/schema.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.tradingMode === "LIVE" || config.liveTradingEnabled || isLiveAllowed(config)) {
    logger.error(
      { tradingMode: config.tradingMode, liveTradingEnabled: config.liveTradingEnabled },
      "LIVE trading is disabled in this build",
    );
    throw new Error("LIVE execution is not enabled. Use TRADING_MODE=PAPER.");
  }

  const db = new AppDatabase(config.databasePath, logger);
  const rest = new BinanceRestClient(config.binanceRestUrl);
  const marketData = new MarketDataService(config, rest, logger);
  const strategy = new CvdDivergenceAbsorptionStrategy(config.strategy, {
    now: () => Date.now(),
    onLog: (level, msg, extra) => logger[level](extra, msg),
  });
  const risk = new RiskManager(config);
  const positions = new PositionTracker(db, logger);
  const executor = createExecutor(config, positions, logger, () => Date.now());
  const journal = new TradeJournal(db);
  const notifier = createNotifier(config, logger);
  const reconciler = new Reconciler(db, positions, logger);

  let engine: TradingEngine | undefined;

  const history = await marketData.load(async (candle) => {
    if (engine) {
      await engine.onClosedCandle(candle);
    }
  });

  engine = new TradingEngine(
    config,
    logger,
    strategy,
    risk,
    positions,
    executor,
    journal,
    notifier,
    reconciler,
    marketData,
    marketData.getFilters(),
  );

  marketData.onResync = async (h) => {
    await engine?.resyncFromHistory(h);
  };

  await engine.bootstrap(history);
  engine.reconcile();
  marketData.connect();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutdown");
    await marketData.stop();
    engine?.reconcile();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
