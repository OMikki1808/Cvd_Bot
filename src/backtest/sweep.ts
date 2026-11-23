/**
 * Research grid with an honest train/test split.
 *
 *   npm run sweep -- --from 2023-08-01 --to 2026-08-01 --split 2025-08-01 --venue futures
 *
 * Every combination of mode × trend filter × min stop × RR is run per symbol
 * (isolated, no exposure limits → pure per-trade R statistics). Rows are ranked
 * by TRAIN net R; look at the TEST columns to see what survives out of sample.
 *
 * Options: --data DIR --pool NAME --symbols A,B --venue spot|futures|none
 *          --modes limit1bar,market --trend 0,72,168,336,720 --min-stop 0,0.5,0.75,1
 *          --rrs pool,1,2,3 --out FILE.csv --top N [25] --python-parity
 */
import { writeFileSync } from "node:fs";
import { DEFAULT_POOL_VERSION, resolvePool } from "../strategy/productionPool.js";
import type { Bar15m, EntryMode } from "../strategy/engine082f.js";
import { NO_LIMITS } from "../portfolio/paperPortfolio.js";
import { dateMs, num, parseArgs, resolveSymbols } from "./args.js";
import { loadSymbolBars } from "./klineCsv.js";
import { runBacktest } from "./runBacktest.js";
import { costsFromArgs, stats } from "./common.js";

const args = parseArgs(process.argv.slice(2));
const split = dateMs(args.get("split"));
if (split === undefined) {
  console.error("--split DATE is required (train = before, test = after)");
  process.exit(1);
}
const dataDir = args.get("data") ?? "./data/klines";
const poolRr = resolveSymbols(args, resolvePool(args.get("pool") ?? DEFAULT_POOL_VERSION));
const from = dateMs(args.get("from"));
const to = dateMs(args.get("to"));
const list = (key: string, dflt: string) => (args.get(key) ?? dflt).split(",").map((x) => x.trim()).filter(Boolean);
const modes = list("modes", "limit1bar,market") as EntryMode[];
const trends = list("trend", "0,72,168,336,720").map(Number);
const minStops = list("min-stop", "0,0.5,0.75,1").map(Number);
const rrs = list("rrs", "pool,1,2,3");
const costs = costsFromArgs(args);
const pythonParity = args.has("python-parity");

const bars = new Map<string, Bar15m[]>();
for (const s of Object.keys(poolRr)) bars.set(s, loadSymbolBars(dataDir, s, from, to));
const withData = [...bars.values()].filter((b) => b.length > 0).length;
console.log(`symbols with data: ${withData}/${bars.size}; costs ${JSON.stringify(costs)}; split ${args.get("split")}`);

interface Row {
  mode: string; trendH: number; minStop: number; rr: string;
  trainN: number; trainGross: number; trainNet: number;
  testN: number; testGross: number; testNet: number; testSumR: number; testSymPos: number;
}
const rows: Row[] = [];
const total = modes.length * trends.length * minStops.length * rrs.length;
let done = 0;
for (const mode of modes)
  for (const trendH of trends)
    for (const minStop of minStops)
      for (const rr of rrs) {
        const symbolRr = Object.fromEntries(Object.entries(poolRr).map(([s, r]) => [s, rr === "pool" ? r : Number(rr)]));
        const res = runBacktest({
          bars, symbolRr, startingEquity: 10_000, riskPercent: 1, costs, limits: NO_LIMITS,
          isolated: true, checkExitsAfterImmediateFill: !pythonParity, immediateFillAtMarket: !pythonParity, entryMode: mode, trendFilterHours: trendH, minStopPct: minStop,
        });
        const train = stats(res.trades.filter((t) => t.entryTime < split));
        const testTrades = res.trades.filter((t) => t.entryTime >= split);
        const test = stats(testTrades);
        const perSym = new Map<string, number>();
        for (const t of testTrades) perSym.set(t.symbol, (perSym.get(t.symbol) ?? 0) + t.netPnl);
        rows.push({
          mode, trendH, minStop, rr,
          trainN: train.n, trainGross: train.grossR, trainNet: train.netR,
          testN: test.n, testGross: test.grossR, testNet: test.netR, testSumR: test.sumNetR,
          testSymPos: perSym.size ? [...perSym.values()].filter((v) => v > 0).length / perSym.size : 0,
        });
        done += 1;
        process.stderr.write(`\r${done}/${total}`);
      }
process.stderr.write("\n");

rows.sort((a, b) => b.trainNet - a.trainNet);
const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
console.log("\nrank mode       trendH minStop rr   | TRAIN n   grossR  netR   | TEST n   grossR  netR   sumR    sym+%");
rows.slice(0, num(args, "top", 25)).forEach((r, i) =>
  console.log(
    `${String(i + 1).padStart(4)} ${r.mode.padEnd(10)} ${String(r.trendH).padStart(6)} ${String(r.minStop).padStart(7)} ${r.rr.padEnd(4)} | ${String(r.trainN).padStart(6)} ${f(r.trainGross)} ${f(r.trainNet)} | ${String(r.testN).padStart(5)} ${f(r.testGross)} ${f(r.testNet)} ${r.testSumR.toFixed(1).padStart(7)} ${(r.testSymPos * 100).toFixed(0).padStart(5)}%`,
  ),
);
const base = rows.find((r) => r.mode === "limit1bar" && r.trendH === 0 && r.minStop === 0 && r.rr === "pool");
if (base) console.log(`\nproduction baseline (limit1bar, no filters, pool RR): train net ${f(base.trainNet)}, test net ${f(base.testNet)} over ${base.testN} trades`);
const out = args.get("out");
if (out) {
  const cols = Object.keys(rows[0] ?? {}) as Array<keyof Row>;
  writeFileSync(out, [cols.join(","), ...rows.map((r) => cols.map((c) => String(r[c])).join(","))].join("\n") + "\n");
  console.log(`written ${out}`);
}
