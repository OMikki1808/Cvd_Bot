import { z } from "zod";
import { ConfigError } from "../domain/errors.js";
import { Dec } from "../domain/decimal.js";

const timeframeSchema = z.enum(["1m", "3m", "5m", "15m", "30m", "1h", "2h", "4h", "1d"]);

function csv(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
}

function rrMap(value: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (!value.trim()) {
    return out;
  }
  for (const part of value.split(",")) {
    const [sym, rrRaw] = part.split(":").map((s) => s.trim());
    if (!sym || rrRaw === undefined) {
      throw new ConfigError(`Invalid SYMBOL_RR entry: ${part}`);
    }
    const rr = Number(rrRaw);
    if (!Number.isFinite(rr) || rr <= 0) {
      throw new ConfigError(`Invalid RR for ${sym}: ${rrRaw}`);
    }
    out[sym.toUpperCase()] = rr;
  }
  return out;
}

export const envSchema = z.object({
  TRADING_MODE: z.enum(["PAPER", "LIVE"]).default("PAPER"),
  LIVE_TRADING_ENABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  BINANCE_FUTURES_REST_URL: z.string().url().default("https://fapi.binance.com"),
  BINANCE_FUTURES_WS_URL: z.string().url().default("wss://fstream.binance.com"),
  BINANCE_API_KEY: z.string().optional().default(""),
  BINANCE_API_SECRET: z.string().optional().default(""),
  SYMBOLS: z
    .string()
    .default("BTCUSDT,ETHUSDT,BNBUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,SUIUSDT"),
  TIMEFRAME: timeframeSchema.default("5m"),
  PAPER_STARTING_BALANCE_USDT: z.coerce.number().positive().default(10_000),
  DATABASE_PATH: z.string().default("./data/cvd-bot.sqlite"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  CVD_PIVOT_LEFT: z.coerce.number().int().positive().default(5),
  CVD_PIVOT_RIGHT: z.coerce.number().int().positive().default(5),
  CVD_DIV_RANGE_LOWER: z.coerce.number().int().positive().default(5),
  CVD_DIV_RANGE_UPPER: z.coerce.number().int().positive().default(60),
  CVD_CONFIRMATION_WINDOW: z.coerce.number().int().positive().default(8),
  CVD_ATR_PERIOD: z.coerce.number().int().positive().default(14),
  CVD_DELTA_SMA_PERIOD: z.coerce.number().int().positive().default(20),
  CVD_VOLUME_SMA_PERIOD: z.coerce.number().int().positive().default(20),
  CVD_ABSORPTION_DELTA_MULT: z.coerce.number().positive().default(1.5),
  CVD_ABSORPTION_VOLUME_MULT: z.coerce.number().positive().default(1.2),
  CVD_ABSORPTION_RANGE_ATR_MULT: z.coerce.number().positive().default(0.7),
  CVD_ABSORPTION_CLOSE_LOCATION: z.coerce.number().min(0).max(1).default(0.55),
  CVD_WARMUP_BARS: z.coerce.number().int().positive().default(200),
  CVD_SL_BUFFER_TICKS: z.coerce.number().int().min(0).default(1),
  RISK_PERCENT: z.coerce.number().positive().max(5).default(0.5),
  DEFAULT_RR: z.coerce.number().positive().default(2),
  SYMBOL_RR: z.string().default(
    "BTCUSDT:2,ETHUSDT:2,BNBUSDT:2,SOLUSDT:1.8,XRPUSDT:1.8,DOGEUSDT:1.8,ADAUSDT:1.8,AVAXUSDT:1.8,LINKUSDT:1.8,SUIUSDT:1.8",
  ),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface StrategyConfig {
  name: "cvd_divergence_absorption";
  pivotLeft: number;
  pivotRight: number;
  divRangeLower: number;
  divRangeUpper: number;
  confirmationWindow: number;
  atrPeriod: number;
  deltaSmaPeriod: number;
  volumeSmaPeriod: number;
  absorptionDeltaMult: Dec;
  absorptionVolumeMult: Dec;
  absorptionRangeAtrMult: Dec;
  absorptionCloseLocation: Dec;
  warmupBars: number;
  slBufferTicks: number;
}

export interface AppConfig {
  tradingMode: "PAPER" | "LIVE";
  liveTradingEnabled: boolean;
  logLevel: EnvConfig["LOG_LEVEL"];
  binanceRestUrl: string;
  binanceWsUrl: string;
  binanceApiKey: string;
  binanceApiSecret: string;
  symbols: string[];
  timeframe: EnvConfig["TIMEFRAME"];
  paperStartingBalance: Dec;
  databasePath: string;
  telegramBotToken: string;
  telegramChatId: string;
  strategy: StrategyConfig;
  riskPercent: Dec;
  defaultRr: Dec;
  symbolRr: Record<string, Dec>;
}

export function parseConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.message);
  }
  const e = parsed.data;
  const symbols = csv(e.SYMBOLS);
  if (symbols.length === 0) {
    throw new ConfigError("SYMBOLS must not be empty");
  }
  const symbolRrRaw = rrMap(e.SYMBOL_RR);
  const symbolRr: Record<string, Dec> = {};
  for (const [k, v] of Object.entries(symbolRrRaw)) {
    symbolRr[k] = Dec.from(v);
  }

  if (e.CVD_DIV_RANGE_LOWER > e.CVD_DIV_RANGE_UPPER) {
    throw new ConfigError("CVD_DIV_RANGE_LOWER must be <= CVD_DIV_RANGE_UPPER");
  }

  return {
    tradingMode: e.TRADING_MODE,
    liveTradingEnabled: e.LIVE_TRADING_ENABLED,
    logLevel: e.LOG_LEVEL,
    binanceRestUrl: e.BINANCE_FUTURES_REST_URL.replace(/\/$/, ""),
    binanceWsUrl: e.BINANCE_FUTURES_WS_URL.replace(/\/$/, ""),
    binanceApiKey: e.BINANCE_API_KEY,
    binanceApiSecret: e.BINANCE_API_SECRET,
    symbols,
    timeframe: e.TIMEFRAME,
    paperStartingBalance: Dec.from(e.PAPER_STARTING_BALANCE_USDT),
    databasePath: e.DATABASE_PATH,
    telegramBotToken: e.TELEGRAM_BOT_TOKEN,
    telegramChatId: e.TELEGRAM_CHAT_ID,
    strategy: {
      name: "cvd_divergence_absorption",
      pivotLeft: e.CVD_PIVOT_LEFT,
      pivotRight: e.CVD_PIVOT_RIGHT,
      divRangeLower: e.CVD_DIV_RANGE_LOWER,
      divRangeUpper: e.CVD_DIV_RANGE_UPPER,
      confirmationWindow: e.CVD_CONFIRMATION_WINDOW,
      atrPeriod: e.CVD_ATR_PERIOD,
      deltaSmaPeriod: e.CVD_DELTA_SMA_PERIOD,
      volumeSmaPeriod: e.CVD_VOLUME_SMA_PERIOD,
      absorptionDeltaMult: Dec.from(e.CVD_ABSORPTION_DELTA_MULT),
      absorptionVolumeMult: Dec.from(e.CVD_ABSORPTION_VOLUME_MULT),
      absorptionRangeAtrMult: Dec.from(e.CVD_ABSORPTION_RANGE_ATR_MULT),
      absorptionCloseLocation: Dec.from(e.CVD_ABSORPTION_CLOSE_LOCATION),
      warmupBars: e.CVD_WARMUP_BARS,
      slBufferTicks: e.CVD_SL_BUFFER_TICKS,
    },
    riskPercent: Dec.from(e.RISK_PERCENT),
    defaultRr: Dec.from(e.DEFAULT_RR),
    symbolRr,
  };
}

export function isLiveAllowed(config: AppConfig): boolean {
  return config.tradingMode === "LIVE" && config.liveTradingEnabled;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = parseConfig({}).strategy;
