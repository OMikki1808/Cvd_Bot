import { Dec } from "../domain/decimal.js";
import type { AggTrade, ClosedCandle, SymbolFilters } from "../domain/types.js";
import { MarketDataError } from "../domain/errors.js";
import { RateLimiter, withRetry } from "../retry/retry.js";

interface BinanceKlineRow extends Array<string | number> {
  0: number;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
  6: number;
  7: string;
  8: number;
  9: string;
}

interface ExchangeInfoResponse {
  symbols: Array<{
    symbol: string;
    filters: Array<{ filterType: string; tickSize?: string; stepSize?: string; minQty?: string; notional?: string }>;
  }>;
}

interface AggTradeRow {
  a: number;
  p: string;
  q: string;
  T: number;
  m: boolean;
}

export class BinanceRestClient {
  private readonly limiter = new RateLimiter(20, 8);

  constructor(private readonly restUrl: string) {}

  async fetchKlines(symbol: string, interval: string, limit: number): Promise<ClosedCandle[]> {
    const rows = await this.getJson<BinanceKlineRow[]>(
      `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      5,
    );
    return rows.map((row) => klineRowToCandle(symbol, interval, row));
  }

  async fetchAggTrades(symbol: string, startTime: number, endTime: number): Promise<AggTrade[]> {
    const rows = await this.getJson<AggTradeRow[]>(
      `/fapi/v1/aggTrades?symbol=${symbol}&startTime=${startTime}&endTime=${endTime}&limit=1000`,
      20,
    );
    return rows.map((row) => ({
      symbol,
      aggTradeId: row.a,
      price: Dec.from(row.p),
      quantity: Dec.from(row.q),
      timestamp: row.T,
      isBuyerMaker: row.m,
    }));
  }

  async fetchFilters(symbols: readonly string[]): Promise<Map<string, SymbolFilters>> {
    const info = await this.getJson<ExchangeInfoResponse>("/fapi/v1/exchangeInfo", 10);
    const wanted = new Set(symbols);
    const out = new Map<string, SymbolFilters>();
    for (const s of info.symbols) {
      if (!wanted.has(s.symbol)) {
        continue;
      }
      const price = s.filters.find((f) => f.filterType === "PRICE_FILTER");
      const lot = s.filters.find((f) => f.filterType === "LOT_SIZE");
      const minNotional = s.filters.find((f) => f.filterType === "MIN_NOTIONAL");
      if (!price?.tickSize || !lot?.stepSize || !lot.minQty) {
        throw new MarketDataError(`Missing filters for ${s.symbol}`);
      }
      out.set(s.symbol, {
        symbol: s.symbol,
        tickSize: Dec.from(price.tickSize),
        stepSize: Dec.from(lot.stepSize),
        minQty: Dec.from(lot.minQty),
        minNotional: Dec.from(minNotional?.notional ?? "5"),
      });
    }
    return out;
  }

  private async getJson<T>(path: string, weight: number): Promise<T> {
    await this.limiter.acquire(weight);
    return withRetry(
      async () => {
        const res = await fetch(`${this.restUrl}${path}`, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) {
          const body = await res.text();
          throw new MarketDataError(`HTTP ${res.status} ${path}: ${body.slice(0, 200)}`);
        }
        return (await res.json()) as T;
      },
      { attempts: 4, baseDelayMs: 400, maxDelayMs: 4000 },
    );
  }
}

export function klineRowToCandle(
  symbol: string,
  timeframe: string,
  row: Pick<BinanceKlineRow, 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9>,
): ClosedCandle {
  return {
    symbol,
    timeframe,
    openTime: Number(row[0]),
    closeTime: Number(row[6]),
    open: Dec.from(row[1]),
    high: Dec.from(row[2]),
    low: Dec.from(row[3]),
    close: Dec.from(row[4]),
    volume: Dec.from(row[5]),
    tradeCount: Number(row[8]),
    takerBuyBaseVolume: Dec.from(row[9]),
  };
}
