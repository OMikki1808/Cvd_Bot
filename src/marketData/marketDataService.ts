import type { AppConfig } from "../config/schema.js";
import type { AppLogger } from "../logging/logger.js";
import type { AggTrade, ClosedCandle, SymbolFilters } from "../domain/types.js";
import type { BinanceRestClient } from "../exchange/binanceRest.js";
import { BinanceUserDataStreams } from "../exchange/binanceWs.js";
import { FormingCandleDelta } from "./formingCandle.js";
import { sleep } from "../retry/retry.js";

export type ClosedCandleHandler = (candle: ClosedCandle) => void | Promise<void>;

export class MarketDataService {
  private readonly streams: BinanceUserDataStreams;
  private readonly forming = new Map<string, FormingCandleDelta>();
  private readonly lastClosed = new Map<string, number>();
  private filters = new Map<string, SymbolFilters>();
  private reconnecting = false;
  private stopped = false;
  private handler: ClosedCandleHandler | null = null;
  private reconnectAttempt = 0;

  constructor(
    private readonly config: AppConfig,
    private readonly rest: BinanceRestClient,
    private readonly logger: AppLogger,
  ) {
    this.streams = new BinanceUserDataStreams(config.binanceWsUrl, logger);
  }

  getFilters(): Map<string, SymbolFilters> {
    return this.filters;
  }

  async load(onClosedCandle: ClosedCandleHandler): Promise<Map<string, ClosedCandle[]>> {
    this.handler = onClosedCandle;
    this.stopped = false;
    this.filters = await this.rest.fetchFilters(this.config.symbols);
    const history = await this.loadHistory();
    this.logger.info(
      { symbols: this.config.symbols, timeframe: this.config.timeframe },
      "market_data_initialized",
    );
    return history;
  }

  connect(): void {
    this.connectStreams();
  }

  async start(onClosedCandle: ClosedCandleHandler): Promise<Map<string, ClosedCandle[]>> {
    const history = await this.load(onClosedCandle);
    this.connect();
    return history;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.streams.disconnect();
  }

  private async loadHistory(): Promise<Map<string, ClosedCandle[]>> {
    const out = new Map<string, ClosedCandle[]>();
    for (const symbol of this.config.symbols) {
      const raw = await this.rest.fetchKlines(
        symbol,
        this.config.timeframe,
        this.config.strategy.warmupBars + 5,
      );
      // Drop the still-forming last kline if present (REST may include an incomplete bar).
      const closed = dropIncomplete(raw);
      const last = closed[closed.length - 1];
      if (last) {
        this.lastClosed.set(symbol, last.openTime);
      }
      this.forming.set(symbol, new FormingCandleDelta());
      out.set(symbol, closed);
    }
    return out;
  }

  private connectStreams(): void {
    this.streams.connect(this.config.symbols, this.config.timeframe, {
      onConnected: () => {
        this.reconnectAttempt = 0;
      },
      onKlineClosed: (candle) => {
        void this.handleClosedKline(candle);
      },
      onAggTrade: (trade) => {
        this.handleAggTrade(trade);
      },
      onDisconnected: (reason) => {
        void this.reconnect(reason);
      },
    });
  }

  private handleAggTrade(trade: AggTrade): void {
    const buf = this.forming.get(trade.symbol);
    if (!buf) {
      return;
    }
    const applied = buf.apply(trade);
    if (applied) {
      this.logger.debug(
        {
          symbol: trade.symbol,
          aggTradeId: trade.aggTradeId,
          isBuyerMaker: trade.isBuyerMaker,
          qty: trade.quantity.toString(),
        },
        "agg_trade",
      );
    }
  }

  private async handleClosedKline(candle: ClosedCandle): Promise<void> {
    const last = this.lastClosed.get(candle.symbol);
    if (last !== undefined && candle.openTime <= last) {
      this.logger.debug({ symbol: candle.symbol, openTime: candle.openTime }, "duplicate_kline_ignored");
      return;
    }
    this.lastClosed.set(candle.symbol, candle.openTime);
    const forming = this.forming.get(candle.symbol);
    if (forming) {
      const snap = forming.snapshot();
      this.logger.debug(
        {
          symbol: candle.symbol,
          klineDelta: candle.takerBuyBaseVolume.mul(2).sub(candle.volume).toString(),
          aggDelta: snap.delta.toString(),
        },
        "closed_candle_delta_compare",
      );
      forming.reset(candle.closeTime + 1);
    }
    if (this.handler) {
      await this.handler(candle);
    }
  }

  private async reconnect(reason: string): Promise<void> {
    if (this.stopped || this.reconnecting) {
      return;
    }
    this.reconnecting = true;
    this.reconnectAttempt += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempt, 6));
    this.logger.warn({ reason, attempt: this.reconnectAttempt, delay }, "reconnect");
    await sleep(delay);
    try {
      this.streams.disconnect();
      const history = await this.loadHistory();
      this.logger.info({ symbols: [...history.keys()] }, "cvd_state_resynced");
      if (this.handler) {
        // Caller is responsible for strategy.resync; emit via a side channel by
        // invoking a dedicated hook stored on this instance.
        await this.onResync?.(history);
      }
      if (!this.stopped) {
        this.connectStreams();
      }
    } catch (err) {
      this.logger.error({ err }, "resync_failed");
      this.reconnecting = false;
      await this.reconnect("resync_failed");
      return;
    }
    this.reconnecting = false;
  }

  onResync: ((history: Map<string, ClosedCandle[]>) => Promise<void>) | null = null;
}

function dropIncomplete(candles: ClosedCandle[]): ClosedCandle[] {
  if (candles.length === 0) {
    return candles;
  }
  const last = candles[candles.length - 1];
  if (!last) {
    return candles;
  }
  if (Date.now() < last.closeTime) {
    return candles.slice(0, -1);
  }
  return candles;
}
