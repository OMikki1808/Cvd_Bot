/**
 * Frozen symbol pools + per-symbol RR, copied verbatim from CVDBot-prodaction
 * cvdbot/strategy/v082f_engine_v2_limit_1bar/production_pool.py
 *
 * WARNING: RR values were picked as the best of RR1..RR4 on the same
 * 2025-08..2026-07 window that produced the reported PnL (in-sample, no costs).
 * Re-validate out-of-sample with `npm run backtest` before trusting them.
 */
export const PHASE50_TOP35_2026_09 = "PHASE50_TOP35_2026_09";
export const PHASE56_BINANCE_MARGIN_TEST15_2026_09 = "PHASE56_BINANCE_MARGIN_TEST15_2026_09";
export const DEFAULT_POOL_VERSION = PHASE50_TOP35_2026_09;

export const POOL_SYMBOL_RR: Record<string, Record<string, number>> = {
  PHASE50_TOP35_2026_09: {
    "DOGEUSDT": 4,
    "MEMEUSDT": 4,
    "PORTALUSDT": 4,
    "ARKMUSDT": 3,
    "AVAXUSDT": 3,
    "SAGAUSDT": 4,
    "SUSDT": 4,
    "XECUSDT": 2,
    "YGGUSDT": 2,
    "TRXUSDT": 4,
    "SOLUSDT": 4,
    "1000CATUSDT": 1,
    "HOTUSDT": 4,
    "STORJUSDT": 4,
    "GLMRUSDT": 3,
    "ANIMEUSDT": 4,
    "BERAUSDT": 4,
    "BROCCOLI714USDT": 4,
    "SUNUSDT": 4,
    "ONGUSDT": 4,
    "SLPUSDT": 3,
    "STOUSDT": 4,
    "BTCUSDT": 3,
    "GRTUSDT": 4,
    "TURBOUSDT": 4,
    "CFXUSDT": 2,
    "ICXUSDT": 3,
    "UNIUSDT": 4,
    "LTCUSDT": 4,
    "RUNEUSDT": 3,
    "ACMUSDT": 4,
    "EPICUSDT": 4,
    "COWUSDT": 2,
    "ALTUSDT": 4,
    "JOEUSDT": 4,
  },
  PHASE56_BINANCE_MARGIN_TEST15_2026_09: {
    "DOGEUSDT": 4,
    "MEMEUSDT": 4,
    "PORTALUSDT": 4,
    "ARKMUSDT": 3,
    "AVAXUSDT": 3,
    "SAGAUSDT": 4,
    "SUSDT": 4,
    "XECUSDT": 2,
    "YGGUSDT": 2,
    "TRXUSDT": 4,
    "SOLUSDT": 4,
    "1000CATUSDT": 1,
    "GLMRUSDT": 3,
    "ANIMEUSDT": 4,
    "BERAUSDT": 4,
  },
};

export function resolvePool(version: string): Record<string, number> {
  const rr = POOL_SYMBOL_RR[version.trim().toUpperCase()];
  if (!rr) {
    throw new Error(`Unknown POOL_VERSION=${version}; available: ${Object.keys(POOL_SYMBOL_RR).join(",")}`);
  }
  return { ...rr };
}
