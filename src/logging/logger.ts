import pino, { type Logger } from "pino";

export type AppLogger = Logger;

export function createLogger(level: string): AppLogger {
  return pino({
    level,
    base: { service: "cvd-bot" },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: ["binanceApiKey", "binanceApiSecret", "telegramBotToken", "*.apiKey", "*.apiSecret"],
      censor: "[redacted]",
    },
  });
}
