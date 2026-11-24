/**
 * Backtest the real 082F limit_1bar strategy on Binance SPOT 15m klines.
 *
 *   npm run fetch-data -- --from 2025-08-01 --to 2026-08-01
 *   npm run backtest  -- --from 2025-08-01 --to 2026-08-01
 *
 * Options (defaults in brackets):
 *   --data DIR             kline CSV dir [./data/klines]
 *   --pool NAME            symbol/RR pool [PHASE50_TOP35_2026_09]
 *   --symbols A,B          subset of the pool (or any symbols with --rr)
 *   --rr N                 override RR for all symbols
 *   --from / --to          UTC dates (to is exclusive)
 *   --mode limit1bar|market   limit1bar = production, market = V082F_ENGINE_V2 [limit1bar]
 *   --trend-hours N        long only above / short only below the close N hours ago [0=off]
 *   --min-stop-pct X       skip setups with a stop closer than X % [0=off]
 *   --trigger 60|15|30|120|240   decision timeframe in minutes [60]
 *   --structure SPEC       ICT structure filter, e.g. 1d:st+4h:st, 1d:st+~4h:st, 1d:st+-4h:st [off]
 *   --sides both|long|short   allowed directions [both]
 *   --absorption           require absorption on the confirmation bar (|delta|>=1x avg20, close in favourable half)
 *   --split DATE           also report trades before / after DATE separately (out-of-sample check)
 *   --equity N [10000]  --risk PCT [1]
 *   --venue spot|futures|none   fee preset [spot: 10/10 bps, futures: taker 5 / maker 2, + 5 bps slippage]
 *   --taker-bps / --maker-bps / --slippage-bps   override the preset
 *   --max-positions N [15]  --max-pos-lev X [0=off]  --max-total-lev X [0=off]  --lev-mode cap|reject [cap]
 *   --isolated             each symbol has its own equity (like PHASE48 tables)
 *   --python-parity        reproduce the Python fill quirks (by default both are fixed:
 *                          immediate fills at market price, SL/TP checked on the next bar)
 *   --gross                no costs, no limits (with --python-parity --isolated = Python tables)
 *   --out DIR              write trades.csv + summary.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POOL_VERSION, resolvePool } from "../strategy/productionPool.js";
import { dateMs, num, parseArgs, resolveSymbols } from "./args.js";
import { loadSymbolBars } from "./klineCsv.js";
import { runBacktest, type BacktestResult } from "./runBacktest.js";
import { VENUE_COSTS } from "../portfolio/paperPortfolio.js";
import { costsFromArgs, summarizeSplit } from "./common.js";
import type { Bar15m } from "../strategy/engine082f.js";

const args = parseArgs(process.argv.slice(2));
const dataDir = args.get("data") ?? "./data/klines";
const symbolRr = resolveSymbols(args, resolvePool(args.get("pool") ?? DEFAULT_POOL_VERSION));
const from = dateMs(args.get("from"));
const to = dateMs(args.get("to"));
const gross = args.has("gross");

const bars = new Map<string, Bar15m[]>();
const missing: string[] = [];
for (const s of Object.keys(symbolRr)) {
  const b = loadSymbolBars(dataDir, s, from, to);
  if (b.length === 0) missing.push(s);
  bars.set(s, b);
}
if (missing.length === Object.keys(symbolRr).length) {
  console.error(`No kline data in ${dataDir}. Run: npm run fetch-data -- --from ... --to ...`);
  process.exit(1);
}
if (missing.length) console.warn(`no data for: ${missing.join(", ")}`);

const result = runBacktest({
  bars,
  symbolRr,
  startingEquity: num(args, "equity", 10_000),
  riskPercent: num(args, "risk", 1),
  costs: gross ? VENUE_COSTS.none! : costsFromArgs(args),
  limits: gross
    ? { maxActivePositions: 0, maxPositionLeverage: 0, maxTotalLeverage: 0, leverageMode: "cap" }
    : {
        maxActivePositions: num(args, "max-positions", 15),
        maxPositionLeverage: num(args, "max-pos-lev", 0),
        maxTotalLeverage: num(args, "max-total-lev", 0),
        leverageMode: args.get("lev-mode") === "reject" ? "reject" : "cap",
      },
  isolated: args.has("isolated"),
  checkExitsAfterImmediateFill: !args.has("python-parity"),
  immediateFillAtMarket: !args.has("python-parity"),
  entryMode: args.get("mode") === "market" ? "market" : "limit1bar",
  trendFilterHours: num(args, "trend-hours", 0),
  minStopPct: num(args, "min-stop-pct", 0),
  triggerMinutes: num(args, "trigger", 60),
  closeOnLastBar: !args.has("python-parity"),
  structureSpec: args.get("structure") ?? "",
  sides: (args.get("sides") ?? "both") as "both" | "long" | "short",
  absorption: args.has("absorption") ? { minDeltaRatio: num(args, "abs-ratio", 1), minCloseLocation: num(args, "abs-close", 0.5), lookback: 20 } : undefined,
});

printReport(result);
const split = dateMs(args.get("split"));
if (split !== undefined) {
  console.log(`\nsplit at ${args.get("split")}:`);
  for (const row of summarizeSplit(result.trades, split)) console.log(`  ${row}`);
}
const out = args.get("out");
if (out) {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "trades.csv"), tradesCsv(result));
  const { trades: _t, ...summary } = result;
  writeFileSync(join(out, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\nwritten: ${join(out, "trades.csv")}, ${join(out, "summary.json")}`);
}

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`;
}

function printReport(r: BacktestResult): void {
  console.log("\n=== 082F limit_1bar backtest ===");
  console.log(`equity ${r.startingEquity.toFixed(2)} -> ${r.finalEquity.toFixed(2)}  (${pct(r.returnPct)})`);
  console.log(`trades ${r.trades.length}   maxDD ${(r.maxDrawdown * 100).toFixed(2)}%   avg R gross ${r.avgGrossR.toFixed(3)} / net ${r.avgNetR.toFixed(3)}`);
  console.log(`fees ${r.feesPaid.toFixed(2)}   slippage ${r.slippagePaid.toFixed(2)}`);
  console.log(`max concurrent positions ${r.maxConcurrentPositions}   max open notional ${r.maxOpenNotionalX.toFixed(2)}x equity`);
  console.log("\nsymbol            RR  trades  win%    net PnL%   PF     maxDD   avg R  filtered  rejected");
  for (const s of [...r.perSymbol].sort((a, b) => b.netPnl - a.netPnl)) {
    console.log(
      `${s.symbol.padEnd(16)} ${String(s.rr).padStart(3)} ${String(s.trades).padStart(7)} ${(s.winRate * 100).toFixed(1).padStart(5)} ${pct(s.pnlPct).padStart(10)} ${(Number.isFinite(s.profitFactor) ? s.profitFactor.toFixed(2) : "inf").padStart(6)} ${(s.maxDrawdown * 100).toFixed(2).padStart(6)}% ${s.avgR.toFixed(3).padStart(6)} ${String(s.filtered).padStart(9)} ${String(s.rejected).padStart(9)}`,
    );
  }
  console.log("\nmonth     trades   net PnL");
  for (const m of r.monthly) console.log(`${m.month}  ${String(m.trades).padStart(6)}  ${m.netPnl.toFixed(2).padStart(10)}`);
}

function tradesCsv(r: BacktestResult): string {
  const cols = [
    "symbol", "side", "divergenceTime", "confirmationTime", "entryTime", "exitTime", "fillReason", "entry", "stop",
    "takeProfit", "exitPrice", "qty", "outcome", "rr", "pnl", "fees", "slippage", "netPnl", "portfolioEquityAfter",
  ] as const;
  const iso = new Set(["divergenceTime", "confirmationTime", "entryTime", "exitTime"]);
  const lines = [cols.join(",")];
  for (const t of r.trades) {
    lines.push(
      cols
        .map((c) => {
          const v = (t as unknown as Record<string, unknown>)[c];
          return iso.has(c) ? new Date(v as number).toISOString() : String(v);
        })
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}
