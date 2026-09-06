import WebSocket from "ws";
import { Dec } from "../domain/decimal.js";
import type { AggTrade, ClosedCandle } from "../domain/types.js";
import type { AppLogger } from "../logging/logger.js";
import { klineRowToCandle } from "./binanceRest.js";

export interface StreamHandlers {
  onKlineClosed: (candle: ClosedCandle) => void;
  onAggTrade: (trade: AggTrade) => void;
  onDisconnected: (reason: string) => void;
  onConnected: () => void;
}

interface CombinedStreamMessage {
  stream: string;
  data: KlineEvent | AggTradeEvent;
}

interface KlineEvent {
  e: "kline";
  s: string;
  k: {
    t: number;
    T: number;
    i: string;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    n: number;
    x: boolean;
    V: string;
  };
}

interface AggTradeEvent {
  e: "aggTrade";
  s: string;
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export class BinanceUserDataStreams {
  private ws: WebSocket | null = null;
  private closed = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly wsBase: string,
    private readonly logger: AppLogger,
  ) {}

  connect(symbols: readonly string[], timeframe: string, handlers: StreamHandlers): void {
    this.closed = false;
    const streams = symbols.flatMap((s) => {
      const lower = s.toLowerCase();
      return [`${lower}@kline_${timeframe}`, `${lower}@aggTrade`];
    });
    const url = `${this.wsBase}/stream?streams=${streams.join("/")}`;
    this.open(url, handlers);
  }

  disconnect(): void {
    this.closed = true;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  private open(url: string, handlers: StreamHandlers): void {
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on("open", () => {
      this.logger.info({ url: redactStreams(url) }, "market_data_initialized");
      handlers.onConnected();
      this.pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 15_000);
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(String(raw)) as CombinedStreamMessage;
        if (!msg.data || !msg.stream) {
          return;
        }
        if (msg.data.e === "kline") {
          const k = msg.data.k;
          if (!k.x) {
            return;
          }
          const candle = klineRowToCandle(msg.data.s, k.i, {
            0: k.t,
            1: k.o,
            2: k.h,
            3: k.l,
            4: k.c,
            5: k.v,
            6: k.T,
            8: k.n,
            9: k.V,
          });
          handlers.onKlineClosed(candle);
          return;
        }
        if (msg.data.e === "aggTrade") {
          const t = msg.data;
          handlers.onAggTrade({
            symbol: t.s,
            aggTradeId: t.a,
            price: Dec.from(t.p),
            quantity: Dec.from(t.q),
            timestamp: t.T,
            isBuyerMaker: t.m,
          });
        }
      } catch (err) {
        this.logger.debug({ err }, "ws_parse_error");
      }
    });

    ws.on("close", (code, reason) => {
      this.clearPing();
      if (!this.closed) {
        this.logger.warn({ code, reason: String(reason) }, "reconnect");
        handlers.onDisconnected(`ws_close_${code}`);
      }
    });

    ws.on("error", (err) => {
      this.logger.warn({ err }, "ws_error");
    });
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

function redactStreams(url: string): string {
  return url.split("?")[0] ?? url;
}
