import type { Bar15m } from "../strategy/engine082f.js";
import { PaperPortfolio, type CostModel, type NetTrade, type RiskLimits } from "../portfolio/paperPortfolio.js";

export interface BacktestInput {
  bars: Map<string, Bar15m[]>;
  symbolRr: Record<string, number>;
  startingEquity: number;
  riskPercent: number;
  costs: CostModel;
  limits: RiskLimits;
  isolated: boolean;
  checkExitsAfterImmediateFill: boolean;
}

export interface SymbolStats {
  symbol: string;
  rr: number;
  trades: number;
  wins: number;
  winRate: number;
  grossPnl: number;
  netPnl: number;
  profitFactor: number;
  pnlPct: number;
  maxDrawdown: number;
  untrustedHours: number;
  rejected: number;
}

export interface BacktestResult {
  startingEquity: number;
  finalEquity: number;
  returnPct: number;
  maxDrawdown: number;
  trades: NetTrade[];
  feesPaid: number;
  slippagePaid: number;
  perSymbol: SymbolStats[];
  monthly: Array<{ month: string; netPnl: number; trades: number }>;
  maxConcurrentPositions: number;
  maxOpenNotionalX: number;
}

/** Replays all symbols in global time order (ties broken by symbol order), like the live stream. */
export function runBacktest(input: BacktestInput): BacktestResult {
  const pf = new PaperPortfolio({
    symbolRr: input.symbolRr,
    startingEquity: input.startingEquity,
    riskPercent: input.riskPercent,
    costs: input.costs,
    limits: input.limits,
    isolated: input.isolated,
    checkExitsAfterImmediateFill: input.checkExitsAfterImmediateFill,
  });
  const symbols = pf.symbols.filter((s) => (input.bars.get(s)?.length ?? 0) > 0);
  const cursor = new Map<string, number>(symbols.map((s) => [s, 0]));
  let maxConcurrent = 0;
  let maxNotionalX = 0;
  for (;;) {
    let t = Number.POSITIVE_INFINITY;
    for (const s of symbols) {
      const b = input.bars.get(s)?.[cursor.get(s) ?? 0];
      if (b && b.openTime < t) t = b.openTime;
    }
    if (!Number.isFinite(t)) break;
    for (const s of symbols) {
      const i = cursor.get(s) ?? 0;
      const b = input.bars.get(s)?.[i];
      if (b && b.openTime === t) {
        pf.on15mBar(s, b);
        cursor.set(s, i + 1);
      }
    }
    const open = pf.openPositions();
    if (open > maxConcurrent) maxConcurrent = open;
    if (!input.isolated && pf.equity > 0) {
      const x = pf.openNotional() / pf.equity;
      if (x > maxNotionalX) maxNotionalX = x;
    }
  }
  pf.flush();

  const perSymbol: SymbolStats[] = symbols.map((symbol) => {
    const ts = pf.trades.filter((t) => t.symbol === symbol);
    const wins = ts.filter((t) => t.netPnl > 0);
    const grossWin = wins.reduce((a, t) => a + t.netPnl, 0);
    const grossLoss = ts.filter((t) => t.netPnl <= 0).reduce((a, t) => a - t.netPnl, 0);
    const netPnl = ts.reduce((a, t) => a + t.netPnl, 0);
    let peak = input.startingEquity;
    let eq = input.startingEquity;
    let dd = 0;
    for (const t of ts) {
      eq += t.netPnl;
      peak = Math.max(peak, eq);
      dd = Math.max(dd, (peak - eq) / peak);
    }
    const eng = pf.engines.get(symbol);
    return {
      symbol,
      rr: input.symbolRr[symbol] ?? 0,
      trades: ts.length,
      wins: wins.length,
      winRate: ts.length ? wins.length / ts.length : 0,
      grossPnl: ts.reduce((a, t) => a + t.pnl, 0),
      netPnl,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
      pnlPct: (netPnl / input.startingEquity) * 100,
      maxDrawdown: dd,
      untrustedHours: eng?.funnel.untrustedHours ?? 0,
      rejected: eng?.funnel.entriesRejected ?? 0,
    };
  });

  const monthlyMap = new Map<string, { netPnl: number; trades: number }>();
  for (const t of pf.trades) {
    const m = new Date(t.exitTime).toISOString().slice(0, 7);
    const row = monthlyMap.get(m) ?? { netPnl: 0, trades: 0 };
    row.netPnl += t.netPnl;
    row.trades += 1;
    monthlyMap.set(m, row);
  }

  const finalEquity = input.isolated ? input.startingEquity + pf.trades.reduce((a, t) => a + t.netPnl, 0) : pf.equity;
  return {
    startingEquity: input.startingEquity,
    finalEquity,
    returnPct: ((finalEquity - input.startingEquity) / input.startingEquity) * 100,
    maxDrawdown: pf.maxDrawdown,
    trades: pf.trades,
    feesPaid: pf.feesPaid,
    slippagePaid: pf.slippagePaid,
    perSymbol,
    monthly: [...monthlyMap.entries()].sort().map(([month, v]) => ({ month, ...v })),
    maxConcurrentPositions: maxConcurrent,
    maxOpenNotionalX: maxNotionalX,
  };
}
