import type { AppLogger } from "../logging/logger.js";
import type { EngineEvent } from "../strategy/engine082f.js";
import type { NetTrade } from "../portfolio/paperPortfolio.js";

export interface Notifier {
  /** Fire-and-forget: never blocks or throws into the trading loop. */
  notify(text: string): void;
}

export class NoopNotifier implements Notifier {
  notify(): void {}
}

export class TelegramNotifier implements Notifier {
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly token: string,
    private readonly chatId: string,
    private readonly logger: AppLogger,
    private readonly timeoutMs = 10_000,
  ) {}

  notify(text: string): void {
    // Serialize sends to keep message order, but never await from the caller.
    this.chain = this.chain.then(() => this.send(text)).catch(() => undefined);
  }

  private async send(text: string): Promise<void> {
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: "HTML" }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.logger.warn({ status: res.status }, "telegram_send_failed");
      }
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, "telegram_send_failed");
    }
  }
}

export function createNotifier(token: string, chatId: string, logger: AppLogger): Notifier {
  return token && chatId ? new TelegramNotifier(token, chatId, logger) : new NoopNotifier();
}

const fmt = (x: number, dp = 6): string => Number(x.toPrecision(10)).toFixed(dp).replace(/\.?0+$/, "");
const iso = (ms: number): string => new Date(ms).toISOString().replace(".000Z", "Z");

export function formatEvent(e: EngineEvent, equity: number, closed?: NetTrade): string | null {
  switch (e.type) {
    case "LimitSignal":
      return [
        `🟡 <b>LIMIT ${e.side.toUpperCase()}</b> ${e.symbol}`,
        `entry ${fmt(e.entry)}  SL ${fmt(e.stop)}  TP ${fmt(e.takeProfit)}  RR ${e.rr}`,
        `risk ${fmt(e.riskCash, 2)} USDT  qty ${fmt(e.qty)}  notional ${fmt(e.notional, 2)}`,
        `valid until ${iso(e.time + 2 * 3_600_000)}`,
      ].join("\n");
    case "PositionOpened":
      return [
        `🟢 <b>OPEN ${e.position.side.toUpperCase()}</b> ${e.symbol} (${e.position.fillReason})`,
        `entry ${fmt(e.position.entry)}  SL ${fmt(e.position.stop)}  TP ${fmt(e.position.takeProfit)}`,
        `qty ${fmt(e.position.qty)}  notional ${fmt(e.position.qty * e.position.entry, 2)}  risk ${fmt(e.riskCash, 2)}`,
      ].join("\n");
    case "PositionClosed": {
      const t = closed;
      const net = t ? t.netPnl : e.trade.pnl;
      return [
        `${net >= 0 ? "✅" : "🔴"} <b>CLOSED ${e.trade.side.toUpperCase()}</b> ${e.symbol} — ${e.trade.outcome}`,
        `exit ${fmt(e.trade.exitPrice)}  R ${e.trade.rr.toFixed(2)}`,
        `pnl ${fmt(e.trade.pnl, 2)}${t ? `  fees ${fmt(t.fees + t.slippage, 2)}  net ${fmt(net, 2)}` : ""}`,
        `equity ${fmt(equity, 2)} USDT`,
      ].join("\n");
    }
    case "EntryRejected":
      return `⛔ entry rejected ${e.symbol} ${e.side}: ${e.reason}`;
    default:
      return null;
  }
}
