import { loadConfig } from "./config/load.js";
import { isLiveAllowed } from "./config/schema.js";
import { createLogger } from "./logging/logger.js";
import { AppDatabase } from "./db/database.js";
import { BinanceKlineStream, BinanceSpotRest } from "./exchange/binanceSpot.js";
import { createNotifier } from "./telegram/telegramNotifier.js";
import { PaperRuntime } from "./runtime/paperRuntime.js";
import { STRATEGY_SEMANTICS, STRATEGY_VERSION } from "./strategy/engine082f.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  if (config.tradingMode === "LIVE" || config.liveTradingEnabled || isLiveAllowed(config)) {
    throw new Error("LIVE execution is not implemented in this build. Use TRADING_MODE=PAPER.");
  }

  logger.info(
    {
      strategy: STRATEGY_VERSION,
      semantics: STRATEGY_SEMANTICS,
      pool: config.poolVersion,
      symbols: Object.keys(config.symbolRr).length,
      riskPercent: config.riskPercent,
      entryMode: config.entryMode,
      trendFilterHours: config.trendFilterHours,
      minStopPct: config.minStopPct,
      takerFeeBps: config.takerFeeBps,
      makerFeeBps: config.makerFeeBps,
      slippageBps: config.slippageBps,
      maxActivePositions: config.maxActivePositions,
      maxPositionLeverage: config.maxPositionLeverage,
      maxTotalLeverage: config.maxTotalLeverage,
      checkExitsAfterImmediateFill: config.checkExitsAfterImmediateFill,
      immediateFillAtMarket: config.immediateFillAtMarket,
      mode: "PAPER",
    },
    "startup_identity",
  );

  const db = new AppDatabase(config.databasePath, logger);
  const runtime = new PaperRuntime(
    config,
    logger,
    db,
    new BinanceSpotRest(config.restUrl, config.httpTimeoutMs),
    new BinanceKlineStream(config.wsUrl, config.wsInboundTimeoutMs, logger),
    createNotifier(config.telegramBotToken, config.telegramChatId, logger),
  );

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, "shutdown");
    await runtime.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (err) => logger.error({ err }, "unhandled_rejection"));

  await runtime.start();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
