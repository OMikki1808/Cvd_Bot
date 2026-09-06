import type { ClosedTrade, SizedOrder } from "../domain/types.js";
import type { AppConfig } from "../config/schema.js";
import type { AppLogger } from "../logging/logger.js";

export interface Notifier {
  notifySizedOrder(order: SizedOrder): Promise<void>;
  notifyClosed(trade: ClosedTrade): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifySizedOrder(): Promise<void> {}
  async notifyClosed(): Promise<void> {}
}

export class TelegramNotifier implements Notifier {
  constructor(
    private readonly config: AppConfig,
    private readonly logger: AppLogger,
  ) {}

  async notifySizedOrder(order: SizedOrder): Promise<void> {
    const s = order.signal;
    const text = [
      `<b>${s.strategyName}</b>`,
      `${s.symbol} <b>${s.side}</b> ${s.timeframe}`,
      `entry: ${s.entry.toString()}`,
      `SL: ${s.stopLoss.toString()}`,
      `TP: ${s.takeProfit.toString()}`,
      `RR: ${s.rr.toString()}`,
      `risk: ${order.riskAmount.toString()} USDT`,
      `qty: ${order.quantity.toString()}`,
      `CVD: ${s.cvd.toString()}`,
      `divergence: ${s.divergence.kind}`,
      `absorption: ${s.absorption.kind}`,
      `ts: ${new Date(s.timestamp).toISOString()}`,
    ].join("\n");
    await this.send(text);
  }

  async notifyClosed(trade: ClosedTrade): Promise<void> {
    const text = [
      `<b>CLOSED</b> ${trade.position.symbol} ${trade.position.side}`,
      `reason: ${trade.reason}`,
      `exit: ${trade.exit.toString()}`,
      `pnl: ${trade.pnl.toString()}`,
    ].join("\n");
    await this.send(text);
  }

  private async send(text: string): Promise<void> {
    const token = this.config.telegramBotToken;
    const chatId = this.config.telegramChatId;
    if (!token || !chatId) {
      return;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" }),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "telegram_send_failed");
      }
    } catch (err) {
      this.logger.warn({ err }, "telegram_send_failed");
    }
  }
}

export function createNotifier(config: AppConfig, logger: AppLogger): Notifier {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return new NoopNotifier();
  }
  return new TelegramNotifier(config, logger);
}

export function formatSizedOrder(order: SizedOrder): string {
  const s = order.signal;
  return `${s.strategyName} ${s.symbol} ${s.side} entry=${s.entry.toString()} sl=${s.stopLoss.toString()} tp=${s.takeProfit.toString()} rr=${s.rr.toString()}`;
}
