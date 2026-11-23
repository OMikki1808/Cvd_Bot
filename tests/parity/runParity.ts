import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Engine082fLimit1Bar } from "../../src/strategy/engine082f.js";
import { generate } from "./synthetic.js";

interface Scenario {
  name: string;
  seed: number;
  bars: number;
  gapProb: number;
  vol: number;
  rr: number;
  expected: {
    finalEquity: number;
    maxDrawdown: number;
    funnel: Record<string, number>;
    trades: Array<Record<string, number | string>>;
  };
}

export function loadScenarios(): Scenario[] {
  const path = fileURLToPath(new URL("../fixtures/parity082f.json", import.meta.url));
  return (JSON.parse(readFileSync(path, "utf8")) as { scenarios: Scenario[] }).scenarios;
}

/** Returns a list of human-readable mismatches (empty = exact parity). */
export function checkScenario(sc: Scenario): string[] {
  const eng = new Engine082fLimit1Bar({ symbol: "TESTUSDT", rrTarget: sc.rr });
  for (const b of generate(sc.seed, sc.bars, sc.gapProb, sc.vol)) {
    eng.on15mBar(b);
  }
  eng.flush();
  const issues: string[] = [];
  const exp = sc.expected;
  if (eng.trades.length !== exp.trades.length) {
    issues.push(`${sc.name}: trades ${eng.trades.length} != ${exp.trades.length}`);
  }
  const n = Math.min(eng.trades.length, exp.trades.length);
  for (let i = 0; i < n && issues.length < 10; i++) {
    const got = eng.trades[i] as unknown as Record<string, number | string>;
    const want = exp.trades[i] as Record<string, number | string>;
    for (const k of Object.keys(want)) {
      if (got[k] !== want[k]) {
        issues.push(`${sc.name} trade#${i} ${k}: ${String(got[k])} != ${String(want[k])}`);
      }
    }
  }
  for (const [k, v] of Object.entries(exp.funnel)) {
    if (eng.funnel[k] !== v) {
      issues.push(`${sc.name} funnel.${k}: ${eng.funnel[k]} != ${v}`);
    }
  }
  if (eng.equity !== exp.finalEquity) issues.push(`${sc.name} equity ${eng.equity} != ${exp.finalEquity}`);
  if (eng.maxDrawdown !== exp.maxDrawdown) issues.push(`${sc.name} maxDD ${eng.maxDrawdown} != ${exp.maxDrawdown}`);
  return issues;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let total = 0;
  for (const sc of loadScenarios()) {
    const issues = checkScenario(sc);
    total += issues.length;
    console.log(`${issues.length === 0 ? "EXACT" : "MISMATCH"}  ${sc.name}  trades=${sc.expected.trades.length}`);
    for (const i of issues) console.log("   ", i);
  }
  process.exit(total === 0 ? 0 : 1);
}
