/**
 * Download Binance SPOT 15m klines (public data-api.binance.vision, no key) into
 * ./data/klines/<SYMBOL>-15m.csv — the same source the production runtime uses.
 *
 *   npm run fetch-data -- --from 2025-08-01 --to 2026-08-01 [--symbols A,B] [--pool NAME] [--out DIR]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POOL_VERSION, resolvePool } from "../strategy/productionPool.js";
import { dateMs, parseArgs, resolveSymbols } from "./args.js";

const BASE = "https://data-api.binance.vision/api/v3/klines";
const MIN15 = 900_000;

const args = parseArgs(process.argv.slice(2));
const symbols = Object.keys(resolveSymbols(args, resolvePool(args.get("pool") ?? DEFAULT_POOL_VERSION)));
const from = dateMs(args.get("from")) ?? Date.now() - 365 * 86_400_000;
const to = dateMs(args.get("to")) ?? Date.now();
const outDir = args.get("out") ?? "./data/klines";
mkdirSync(outDir, { recursive: true });

for (const symbol of symbols) {
  const rows: string[] = [];
  let cursor = from;
  while (cursor < to) {
    const url = `${BASE}?symbol=${symbol}&interval=15m&limit=1000&startTime=${cursor}&endTime=${to - 1}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      console.error(`${symbol}: HTTP ${res.status} ${await res.text()}`);
      break;
    }
    const page = (await res.json()) as Array<Array<string | number>>;
    if (page.length === 0) break;
    for (const r of page) {
      if (Number(r[6]) < Date.now()) rows.push(r.slice(0, 12).join(","));
    }
    cursor = Number(page[page.length - 1]?.[0]) + MIN15;
    if (page.length < 1000) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  writeFileSync(join(outDir, `${symbol}-15m.csv`), `${rows.join("\n")}\n`);
  console.log(`${symbol}: ${rows.length} bars`);
}
