# Strategy source of truth

The previous version of this repo shipped a strategy the Cursor agent invented
(5m futures, ATR/volume "absorption" filter) because it could not read the real
code. It has been removed. The only strategy here is now the one running in
production in **`OMikki1808/CVDBot-prodaction`** (commit `fc9145d`, Phase 5.8A):

| | |
| --- | --- |
| Version | `V082F_ENGINE_V2_LIMIT_1BAR` |
| Semantics | `CVD_DIVERGENCE_082F_ENGINE_V2_BINANCE_TRUE_CVD_V1` |
| Python source | `cvdbot/strategy/v082f_engine_v2_limit_1bar/engine.py`, `cvdbot/strategy/s082f/*` |
| Pools | `cvdbot/strategy/v082f_engine_v2_limit_1bar/production_pool.py` |
| Port | `src/strategy/engine082f.ts`, `src/strategy/primitives.ts`, `src/strategy/productionPool.ts` |

## Rules

- Data: Binance **SPOT** 15m klines → aggregated to **1H** (exactly 4 contiguous bars, otherwise the hour is dropped as `DATA_UNTRUSTED`).
- True CVD: `delta = takerBuyBase − (volume − takerBuyBase)`, `CVD = Σ delta`.
- Pivots: fractal `left = 3`, `right = 3`, unique extreme in the 7-bar window, known 3 bars later.
- Divergence vs the previous pivot of the same type (strict):
  bullish = price LL + CVD HL; bearish = price HH + CVD LH.
- Confirmation: the bar right after the pivot bar. Long `close[p+1] > open[p]`, short `close[p+1] < open[p]`.
- Entry: LIMIT at `close[p+1]`, valid for one hour. Immediate fill if the current close is already marketable, otherwise on any 15m bar of the next hour that touches the price.
- Stop = pivot extreme (no buffer). TP = entry ± RR × risk. RR per symbol from the frozen pool.
- Size = equity × 1% / |entry − stop|; shared equity across all symbols.
- Exits on 1H bars after the entry bar: SL/TP (if both are hit in one bar, the bar colour decides), or market close at the bar close on an opposite divergence.

## Parity

`tests/fixtures/parity082f.json` is produced by running the **Python engine
itself** (`npm run parity:oracle`, needs a checkout of CVDBot-prodaction) on 5
deterministic synthetic scenarios (with and without 15m gaps, RR 1–4). The
same bars are generated in TS (`tests/parity/synthetic.ts`) and every trade
field, the equity, the max drawdown and the signal funnel must match
**bit-for-bit** (`===` on floats). Current result: 173/173 trades exact.

## Known quirks of the Python engine (kept for parity)

1. **No SL/TP check on the bar after an `IMMEDIATE_FILL`.** Python sets
   `position_open_idx = self._index` which, for an immediate fill, is the next
   hour, so that hour is never checked; the frozen reference engine
   (`reference/true_cvd_backtest_engine_v2.py`) does check it.
   `CHECK_EXITS_AFTER_IMMEDIATE_FILL=true` / `--fix-immediate-exit` fixes it here.
2. The fill hour of a `FILLED_NEXT_HOUR` order is not checked for SL/TP after
   the fill (intrabar order is unknown on 15m data).
3. `MAX_ACTIVE_POSITIONS = 15` in Python **raises and stops the runtime** when
   exceeded; here the entry is skipped instead.
4. Python keeps the full bar history in memory and serializes it to SQLite on
   every 15m bar (state grows forever). The port keeps only the last 64 hourly
   bars and the 7-bar pivot window — results are identical (parity test).

## What the Python research numbers do not include

- **Costs.** PHASE46/48 RR tables are gross. With 10 bps fee per side a trade
  whose stop is 0.5 % away pays ~0.4 R in fees alone. Backtest defaults here:
  `--fee-bps 10 --slippage-bps 5`; `--gross` reproduces Python.
- **Exposure.** Size depends only on stop distance: a 0.3 % stop at 1 % risk is
  a position of ~3.3 × equity, and up to 15 can be open. Python has no limit;
  here `MAX_POSITION_LEVERAGE` (default 5) and `MAX_TOTAL_LEVERAGE` exist.
- **Selection bias.** The 35-symbol pool and each symbol's RR were picked as the
  best of RR1..RR4 among 352 symbols on the same 2025-08..2026-07 window that
  is reported as the result. Validate on a different period
  (`npm run backtest -- --from 2024-08-01 --to 2025-08-01`) before trusting them.
