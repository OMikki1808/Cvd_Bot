/**
 * Research grid with an honest train / test / holdout split.
 *
 *   npm run sweep -- --from 2023-08-01 --to 2026-08-01 --split 2025-02-01 --holdout 2025-11-01 --venue futures
 *
 * Every combination of mode × trigger TF × structure filter × trend × min stop × absorption × RR
 * is run per symbol (isolated, no exposure limits → pure per-trade R statistics).
 * Rows are ranked by TRAIN net R. Pick candidates by TRAIN+TEST; look at HOLDOUT only once,
 * at the very end — with hundreds of combinations the best TEST row is partly luck too.
 *
 * Options: --data DIR --pool NAME --symbols A,B --venue spot|futures|none
 *          --modes limit1bar,market   --triggers 60,15
 *          --structures "none|1d:st|4h:st|1d:st+4h:st|1d:st+~4h:st|1d:st+-4h:st|1h:it"   (| separated)
 *          --trend 0,336  --min-stop 0,0.5,0.75  --absorption 0,1  --rrs 2,3
 *          --out FILE.csv --top N [30] --min-trades N [100] --python-parity
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
const holdout = dateMs(args.get("holdout")) ?? Number.POSITIVE_INFINITY;
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
const triggers = list("triggers", "60,15").map(Number);
const structures = (args.get("structures") ?? "none|1d:st|4h:st|1d:st+4h:st|1d:st+~4h:st|1d:st+-4h:st|1h:it")
  .split("|")
  .map((x) => x.trim());
const trends = list("trend", "0,336").map(Number);
const minStops = list("min-stop", "0,0.5,0.75").map(Number);
const absorptions = list("absorption", "0,1").map(Number);
const rrs = list("rrs", "2,3");
const sides = (args.get("sides") ?? "both") as "both" | "long" | "short";
const ABSORPTION = { minDeltaRatio: 1, minCloseLocation: 0.5, lookback: 20 };
const costs = costsFromArgs(args);
const pythonParity = args.has("python-parity");

const bars = new Map<string, Bar15m[]>();
for (const s of Object.keys(poolRr)) bars.set(s, loadSymbolBars(dataDir, s, from, to));
const withData = [...bars.values()].filter((b) => b.length > 0).length;
console.log(`symbols with data: ${withData}/${bars.size}; costs ${JSON.stringify(costs)}; split ${args.get("split")}`);

interface Row {
  mode: string; trigger: number; structure: string; trendH: number; minStop: number; absorption: number; rr: string;
  trainN: number; trainGross: number; trainNet: number;
  testN: number; testGross: number; testNet: number; testSumR: number; testSymPos: number;
  holdN: number; holdNet: number;
}
const rows: Row[] = [];
const combos: Array<[EntryMode, number, string, number, number, number, string]> = [];
for (const mode of modes)
  for (const trigger of triggers)
    for (const structure of structures)
      for (const trendH of trends)
        for (const minStop of minStops)
          for (const absorption of absorptions)
            for (const rr of rrs) {
              if (absorption && mode !== "market" && mode !== "limit1bar") continue;
              combos.push([mode, trigger, structure, trendH, minStop, absorption, rr]);
            }
const total = combos.length;
console.log(`${total} combinations`);
let done = 0;
const started = Date.now();
for (const [mode, trigger, structure, trendH, minStop, absorption, rr] of combos) {
      {
        const symbolRr = Object.fromEntries(Object.entries(poolRr).map(([s, r]) => [s, rr === "pool" ? r : Number(rr)]));
        const res = runBacktest({
          bars, symbolRr, startingEquity: 10_000, riskPercent: 1, costs, limits: NO_LIMITS,
          isolated: true, checkExitsAfterImmediateFill: !pythonParity, immediateFillAtMarket: !pythonParity, entryMode: mode, trendFilterHours: trendH, minStopPct: minStop,
          triggerMinutes: trigger, closeOnLastBar: !pythonParity, structureSpec: structure === "none" ? "" : structure,
          absorption: absorption ? ABSORPTION : undefined, sides,
        });
        const train = stats(res.trades.filter((t) => t.entryTime < split));
        const testTrades = res.trades.filter((t) => t.entryTime >= split && t.entryTime < holdout);
        const test = stats(testTrades);
        const hold = stats(res.trades.filter((t) => t.entryTime >= holdout));
        const perSym = new Map<string, number>();
        for (const t of testTrades) perSym.set(t.symbol, (perSym.get(t.symbol) ?? 0) + t.netPnl);
        rows.push({
          mode, trigger, structure, trendH, minStop, absorption, rr,
          holdN: hold.n, holdNet: hold.netR,
          trainN: train.n, trainGross: train.grossR, trainNet: train.netR,
          testN: test.n, testGross: test.grossR, testNet: test.netR, testSumR: test.sumNetR,
          testSymPos: perSym.size ? [...perSym.values()].filter((v) => v > 0).length / perSym.size : 0,
        });
        done += 1;
        const eta = ((Date.now() - started) / done) * (total - done) / 1000;
        process.stderr.write(`\r${done}/${total}  eta ${Math.round(eta)}s   `);
      }
}
process.stderr.write("\n");

const minTrades = num(args, "min-trades", 100);
const thin = rows.filter((r) => r.trainN < minTrades || r.testN < minTrades / 2).length;
if (thin) console.log(`\n${thin} combos skipped from ranking: fewer than ${minTrades} train / ${minTrades / 2} test trades (--min-trades)`);
rows.splice(0, rows.length, ...rows.filter((r) => r.trainN >= minTrades && r.testN >= minTrades / 2));
rows.sort((a, b) => b.trainNet - a.trainNet);
const f = (x: number) => (x >= 0 ? "+" : "") + x.toFixed(3);
const showHold = Number.isFinite(holdout);
console.log(`\nrank mode      tf  structure        trend minStop abs rr   | TRAIN n  grossR  netR  | TEST n  grossR  netR   sumR  sym+%${showHold ? " | HOLD n   netR" : ""}`);
rows.slice(0, num(args, "top", 30)).forEach((r, i) =>
  console.log(
    `${String(i + 1).padStart(4)} ${r.mode.padEnd(9)} ${String(r.trigger).padStart(3)} ${r.structure.padEnd(16)} ${String(r.trendH).padStart(5)} ${String(r.minStop).padStart(7)} ${String(r.absorption).padStart(3)} ${r.rr.padEnd(4)} | ${String(r.trainN).padStart(6)} ${f(r.trainGross)} ${f(r.trainNet)} | ${String(r.testN).padStart(5)} ${f(r.testGross)} ${f(r.testNet)} ${r.testSumR.toFixed(1).padStart(6)} ${(r.testSymPos * 100).toFixed(0).padStart(4)}%${showHold ? ` | ${String(r.holdN).padStart(5)} ${f(r.holdNet)}` : ""}`,
  ),
);
const ranked = [...rows].sort((a, b) => b.testNet - a.testNet);
const corr = spearman(rows.map((r) => r.trainNet), rows.map((r) => r.testNet));
console.log(`\nSpearman(train netR, test netR) over ${rows.length} combos: ${corr.toFixed(3)}  (near 0 = rankings do not carry over = noise)`);
console.log(`best TEST row: ${ranked[0]?.mode} tf${ranked[0]?.trigger} ${ranked[0]?.structure} trend${ranked[0]?.trendH} stop${ranked[0]?.minStop} abs${ranked[0]?.absorption} rr${ranked[0]?.rr} test ${f(ranked[0]?.testNet ?? 0)}`);
function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => {
    const idx = v.map((x, i) => [x, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(v.length);
    idx.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  if (n < 3) return 0;
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += ((ra[i] as number) - (rb[i] as number)) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
}
const base = rows.find((r) => r.mode === "limit1bar" && r.trigger === 60 && r.structure === "none" && r.trendH === 0 && r.minStop === 0 && r.absorption === 0);
if (base) console.log(`production-like baseline (limit1bar 1h, no filters, rr ${base.rr}): train net ${f(base.trainNet)}, test net ${f(base.testNet)} over ${base.testN} trades`);
const out = args.get("out");
if (out) {
  const cols = Object.keys(rows[0] ?? {}) as Array<keyof Row>;
  writeFileSync(out, [cols.join(","), ...rows.map((r) => cols.map((c) => String(r[c])).join(","))].join("\n") + "\n");
  console.log(`written ${out}`);
}
