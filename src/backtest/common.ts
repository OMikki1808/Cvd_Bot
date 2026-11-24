import { VENUE_COSTS, type CostModel, type NetTrade } from "../portfolio/paperPortfolio.js";
import { num } from "./args.js";

export function costsFromArgs(args: Map<string, string>): CostModel {
  const venue = args.get("venue") ?? "spot";
  const base = VENUE_COSTS[venue];
  if (!base) throw new Error(`--venue must be one of ${Object.keys(VENUE_COSTS).join("|")}`);
  return {
    takerFeeBps: num(args, "taker-bps", base.takerFeeBps),
    makerFeeBps: num(args, "maker-bps", base.makerFeeBps),
    slippageBps: num(args, "slippage-bps", base.slippageBps),
  };
}

export function rOf(t: NetTrade, net = true): number {
  return (net ? t.netPnl : t.pnl) / (Math.abs(t.entry - t.stop) * t.qty);
}

export function stats(ts: NetTrade[]): { n: number; grossR: number; netR: number; sumNetR: number; win: number } {
  const n = ts.length;
  const sumNet = ts.reduce((a, t) => a + rOf(t), 0);
  return {
    n,
    grossR: n ? ts.reduce((a, t) => a + rOf(t, false), 0) / n : 0,
    netR: n ? sumNet / n : 0,
    sumNetR: sumNet,
    win: n ? ts.filter((t) => t.netPnl > 0).length / n : 0,
  };
}

export function summarizeSplit(trades: NetTrade[], split: number): string[] {
  const parts: Array<[string, NetTrade[]]> = [
    ["before", trades.filter((t) => t.entryTime < split)],
    ["after ", trades.filter((t) => t.entryTime >= split)],
  ];
  return parts.map(([name, ts]) => {
    const s = stats(ts);
    return `${name}: trades ${s.n}  win ${(s.win * 100).toFixed(1)}%  avg R gross ${s.grossR.toFixed(3)}  net ${s.netR.toFixed(3)}  sum net R ${s.sumNetR.toFixed(1)}`;
  });
}
