import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Bar15m } from "../strategy/engine082f.js";

/**
 * Binance kline CSV (data.binance.vision or REST dump), no header or with header:
 * open_time, open, high, low, close, volume, close_time, quote_volume, trades,
 * taker_buy_base, taker_buy_quote, ignore.
 * Binance Vision SPOT files from 2025 use microseconds — normalized to ms here.
 */
export function parseKlineCsv(text: string): Bar15m[] {
  const out: Bar15m[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || !/^\d/.test(line)) continue;
    const c = line.split(",");
    if (c.length < 10) continue;
    let t = Number(c[0]);
    if (t > 1e17) t = Math.floor(t / 1e6);
    else if (t > 1e14) t = Math.floor(t / 1e3);
    out.push({
      openTime: t,
      open: Number(c[1]),
      high: Number(c[2]),
      low: Number(c[3]),
      close: Number(c[4]),
      volume: Number(c[5]),
      takerBuyBase: Number(c[9]),
    });
  }
  return out;
}

/** All CSV files for a symbol: `<dir>/<SYMBOL>/*.csv` or `<dir>/<SYMBOL>-15m*.csv`. */
export function loadSymbolBars(dir: string, symbol: string, from?: number, to?: number): Bar15m[] {
  const files: string[] = [];
  const sub = join(dir, symbol);
  if (existsSync(sub) && statSync(sub).isDirectory()) {
    for (const f of readdirSync(sub)) if (f.endsWith(".csv")) files.push(join(sub, f));
  }
  for (const f of readdirSync(dir)) {
    if (f.startsWith(`${symbol}-15m`) && f.endsWith(".csv")) files.push(join(dir, f));
  }
  const byTime = new Map<number, Bar15m>();
  for (const f of files) {
    for (const b of parseKlineCsv(readFileSync(f, "utf8"))) {
      if (from !== undefined && b.openTime < from) continue;
      if (to !== undefined && b.openTime >= to) continue;
      byTime.set(b.openTime, b);
    }
  }
  return [...byTime.values()].sort((a, b) => a.openTime - b.openTime);
}
