import { z } from "zod";
import { ConfigError } from "../domain/errors.js";
import { DEFAULT_POOL_VERSION, resolvePool } from "../strategy/productionPool.js";

const bool = z
  .enum(["true", "false", "1", "0"])
  .default("false")
  .transform((v) => v === "true" || v === "1");

export const envSchema = z.object({
  TRADING_MODE: z.enum(["PAPER", "LIVE"]).default("PAPER"),
  LIVE_TRADING_ENABLED: bool,
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // Signals: Binance SPOT 15m klines (same source as CVDBot-prodaction).
  BINANCE_SPOT_REST_URL: z.string().url().default("https://data-api.binance.vision"),
  BINANCE_SPOT_WS_URL: z.string().url().default("wss://stream.binance.com:9443"),
  WS_INBOUND_TIMEOUT_SEC: z.coerce.number().positive().default(90),
  HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
  WARMUP_DAYS: z.coerce.number().int().min(1).max(30).default(7),

  // Strategy (frozen pool from CVDBot-prodaction).
  POOL_VERSION: z.string().default(DEFAULT_POOL_VERSION),
  /** Optional subset of the pool, comma-separated. Empty = whole pool. */
  SYMBOLS: z.string().optional().default(""),
  RISK_PERCENT: z.coerce.number().positive().max(5).default(1),
  CHECK_EXITS_AFTER_IMMEDIATE_FILL: bool,

  // Paper account.
  PAPER_STARTING_EQUITY: z.coerce.number().positive().default(10_000),
  FEE_BPS: z.coerce.number().min(0).default(10),
  SLIPPAGE_BPS: z.coerce.number().min(0).default(5),
  MAX_ACTIVE_POSITIONS: z.coerce.number().int().min(0).default(15),
  MAX_POSITION_LEVERAGE: z.coerce.number().min(0).default(5),
  MAX_TOTAL_LEVERAGE: z.coerce.number().min(0).default(0),
  LEVERAGE_MODE: z.enum(["cap", "reject"]).default("cap"),

  DATABASE_PATH: z.string().default("./data/cvd-bot.sqlite"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface AppConfig {
  tradingMode: "PAPER" | "LIVE";
  liveTradingEnabled: boolean;
  logLevel: EnvConfig["LOG_LEVEL"];
  restUrl: string;
  wsUrl: string;
  wsInboundTimeoutMs: number;
  httpTimeoutMs: number;
  warmupDays: number;
  poolVersion: string;
  symbolRr: Record<string, number>;
  riskPercent: number;
  checkExitsAfterImmediateFill: boolean;
  startingEquity: number;
  feeBps: number;
  slippageBps: number;
  maxActivePositions: number;
  maxPositionLeverage: number;
  maxTotalLeverage: number;
  leverageMode: "cap" | "reject";
  databasePath: string;
  telegramBotToken: string;
  telegramChatId: string;
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.message);
  }
  const e = parsed.data;
  let pool: Record<string, number>;
  try {
    pool = resolvePool(e.POOL_VERSION);
  } catch (err) {
    throw new ConfigError((err as Error).message);
  }
  const subset = e.SYMBOLS.split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const symbolRr: Record<string, number> = {};
  for (const s of subset.length ? subset : Object.keys(pool)) {
    const rr = pool[s];
    if (rr === undefined) {
      throw new ConfigError(`${s} is not in pool ${e.POOL_VERSION}; RR overrides are not allowed for the frozen strategy`);
    }
    symbolRr[s] = rr;
  }
  return {
    tradingMode: e.TRADING_MODE,
    liveTradingEnabled: e.LIVE_TRADING_ENABLED,
    logLevel: e.LOG_LEVEL,
    restUrl: e.BINANCE_SPOT_REST_URL.replace(/\/$/, ""),
    wsUrl: e.BINANCE_SPOT_WS_URL.replace(/\/$/, ""),
    wsInboundTimeoutMs: e.WS_INBOUND_TIMEOUT_SEC * 1000,
    httpTimeoutMs: e.HTTP_TIMEOUT_MS,
    warmupDays: e.WARMUP_DAYS,
    poolVersion: e.POOL_VERSION.trim().toUpperCase(),
    symbolRr,
    riskPercent: e.RISK_PERCENT,
    checkExitsAfterImmediateFill: e.CHECK_EXITS_AFTER_IMMEDIATE_FILL,
    startingEquity: e.PAPER_STARTING_EQUITY,
    feeBps: e.FEE_BPS,
    slippageBps: e.SLIPPAGE_BPS,
    maxActivePositions: e.MAX_ACTIVE_POSITIONS,
    maxPositionLeverage: e.MAX_POSITION_LEVERAGE,
    maxTotalLeverage: e.MAX_TOTAL_LEVERAGE,
    leverageMode: e.LEVERAGE_MODE,
    databasePath: e.DATABASE_PATH,
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
  };
}

export function isLiveAllowed(config: AppConfig): boolean {
  return config.tradingMode === "LIVE" && config.liveTradingEnabled;
}
