import WebSocket from "ws";
import { MarketDataError } from "../domain/errors.js";
import type { AppLogger } from "../logging/logger.js";
import { RateLimiter, withRetry } from "../retry/retry.js";
import type { Bar15m } from "../strategy/engine082f.js";

export const MIN15 = 900_000;

type KlineRow = [number, string, string, string, string, string, number, string, number, string, string, string];

function rowToBar(r: KlineRow): Bar15m {
  return {
    openTime: Number(r[0]),
    open: Number(r[1]),
    high: Number(r[2]),
    low: Number(r[3]),
    close: Number(r[4]),
    volume: Number(r[5]),
    takerBuyBase: Number(r[9]),
  };
}

/** Open time of the most recent fully closed 15m bar. */
export function latestClosed15mOpen(now = Date.now()): number {
  return Math.floor(now / MIN15) * MIN15 - MIN15;
}

/** Binance SPOT public REST (klines + exchangeInfo). Every request has a timeout. */
export class BinanceSpotRest {
  private readonly limiter = new RateLimiter(40, 20);

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  /** Closed 15m bars with open time in [startOpen, endOpen], ascending, deduplicated. */
  async fetch15mRange(symbol: string, startOpen: number, endOpen: number): Promise<Bar15m[]> {
    const out = new Map<number, Bar15m>();
    let cursor = startOpen;
    const now = Date.now();
    while (cursor <= endOpen) {
      const rows = await this.getJson<KlineRow[]>(
        `/api/v3/klines?symbol=${symbol}&interval=15m&limit=1000&startTime=${cursor}&endTime=${endOpen + MIN15 - 1}`,
        2,
      );
      if (rows.length === 0) break;
      for (const r of rows) {
        const b = rowToBar(r);
        if (b.openTime >= startOpen && b.openTime <= endOpen && Number(r[6]) < now) {
          out.set(b.openTime, b);
        }
      }
      const last = Number(rows[rows.length - 1]?.[0]);
      if (rows.length < 1000 || last >= endOpen) break;
      cursor = last + MIN15;
    }
    return [...out.values()].sort((a, b) => a.openTime - b.openTime);
  }

  async assertSymbolsTrading(symbols: readonly string[]): Promise<void> {
    const info = await this.getJson<{ symbols: Array<{ symbol: string; status: string }> }>(
      `/api/v3/exchangeInfo?symbols=${encodeURIComponent(JSON.stringify(symbols))}`,
      20,
    );
    const ok = new Set(info.symbols.filter((s) => s.status === "TRADING").map((s) => s.symbol));
    const bad = symbols.filter((s) => !ok.has(s));
    if (bad.length) {
      throw new MarketDataError(`Symbols not TRADING on Binance SPOT: ${bad.join(",")}`);
    }
  }

  private async getJson<T>(path: string, weight: number): Promise<T> {
    await this.limiter.acquire(weight);
    return withRetry(
      async () => {
        const res = await fetch(`${this.baseUrl}${path}`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (!res.ok) {
          throw new MarketDataError(`HTTP ${res.status} ${path}: ${(await res.text()).slice(0, 200)}`);
        }
        return (await res.json()) as T;
      },
      { attempts: 4, baseDelayMs: 500, maxDelayMs: 5000 },
    );
  }
}

export interface KlineStreamHandlers {
  onClosedBar: (symbol: string, bar: Bar15m) => void;
  onDisconnected: (reason: string) => void;
}

/**
 * Combined `<symbol>@kline_15m` stream. Only closed klines (k.x) are forwarded.
 * A watchdog reconnects when nothing arrives for `inboundTimeoutMs`
 * (Binance sends kline updates every ~2s, so silence means a dead socket).
 */
export class BinanceKlineStream {
  private ws: WebSocket | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private lastInbound = 0;
  private closedByUs = false;

  constructor(
    private readonly wsBase: string,
    private readonly inboundTimeoutMs: number,
    private readonly logger: AppLogger,
  ) {}

  connect(symbols: readonly string[], handlers: KlineStreamHandlers): void {
    this.closedByUs = false;
    const streams = symbols.map((s) => `${s.toLowerCase()}@kline_15m`).join("/");
    const ws = new WebSocket(`${this.wsBase}/stream?streams=${streams}`);
    this.ws = ws;
    this.lastInbound = Date.now();
    let notified = false;
    const drop = (reason: string) => {
      if (notified) return;
      notified = true;
      this.clearWatchdog();
      if (!this.closedByUs) handlers.onDisconnected(reason);
    };

    ws.on("open", () => {
      this.logger.info({ streams: symbols.length }, "ws_connected");
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastInbound > this.inboundTimeoutMs) {
          this.logger.warn({ timeoutMs: this.inboundTimeoutMs }, "ws_no_inbound_reconnect");
          ws.terminate();
          drop("no_inbound");
        }
      }, 5_000);
    });
    ws.on("message", (raw) => {
      this.lastInbound = Date.now();
      try {
        const msg = JSON.parse(String(raw)) as {
          data?: { e?: string; s?: string; k?: { t: number; o: string; h: string; l: string; c: string; v: string; V: string; x: boolean } };
        };
        const d = msg.data;
        if (d?.e !== "kline" || !d.k || !d.s || !d.k.x) return;
        handlers.onClosedBar(d.s, {
          openTime: d.k.t,
          open: Number(d.k.o),
          high: Number(d.k.h),
          low: Number(d.k.l),
          close: Number(d.k.c),
          volume: Number(d.k.v),
          takerBuyBase: Number(d.k.V),
        });
      } catch (err) {
        this.logger.warn({ err }, "ws_message_error");
      }
    });
    ws.on("close", (code) => drop(`ws_close_${code}`));
    ws.on("error", (err) => {
      this.logger.warn({ err: err.message }, "ws_error");
      drop("ws_error");
    });
  }

  disconnect(): void {
    this.closedByUs = true;
    this.clearWatchdog();
    this.ws?.terminate();
    this.ws = null;
  }

  private clearWatchdog(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }
}
