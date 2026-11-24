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

## Two entry modes (both bit-exact vs Python)

| `STRATEGY_MODE` / `--mode` | Python engine | Divergence candle | Entry | Stop |
| --- | --- | --- | --- | --- |
| `limit1bar` (production) | `v082f_engine_v2_limit_1bar` | pivot bar | limit at close of pivot+1, valid 1h | pivot extreme |
| `market` | `v082f_engine_v2` (Phase 43/44) | bar where the divergence is discovered (pivot+3) | close of the next bar if it confirms | that candle's low/high |

Parity fixture: 9 scenarios, 337 trades, all exact.

## Optional filters (not in Python, off by default)

- `TREND_FILTER_HOURS` / `--trend-hours N`: long only if the 1H close is above the close N hourly bars ago, short only if below.
- `MIN_STOP_PCT` / `--min-stop-pct X`: skip setups whose stop is closer than X % (fees eat tight stops).

## Research extensions (not in Python, all off by default)

- **Trigger timeframe** `TRIGGER_MINUTES` / `--trigger`: 15, 30, 60 (Python), 120, 240. Every rule runs on that timeframe.
- **ICT market structure filter** `STRUCTURE_FILTER` / `--structure` (`src/strategy/marketStructure.ts`):
  STH/ITH/LTH and STL/ITL/LTL per ICT on 1h/4h/1d/1w (built from 15m, used only once closed),
  trend per level = last break of structure. Terms joined with `+`:
  `1d:st` must agree, `~4h:st` must not be against, `-4h:st` must be against (pullback).
- **Absorption** `ABSORPTION` / `--absorption`: on the confirmation bar, delta against the trade
  with |delta| ≥ ratio × average of 20 bars, while the bar closes in the favourable half.
- **Decision without the 15-minute lag** (`closeOnLastBar`, default in runtime/backtest): Python only closes
  the hour when the first 15m bar of the next hour arrives, so live decisions come 15 minutes late.
- `tests/structure.test.ts` proves no lookahead: changing the data after time T never changes trades closed before T.

## Known quirks of the Python engine (kept for parity)

1. **No SL/TP check on the bar after an `IMMEDIATE_FILL`.** Python sets
   `position_open_idx = self._index` which, for an immediate fill, is the next
   hour, so that hour is never checked; the frozen reference engine
   (`reference/true_cvd_backtest_engine_v2.py`) does check it.
   Fixed by default here (`CHECK_EXITS_AFTER_IMMEDIATE_FILL=true`).
5. **Immediate fills are booked at the limit price although the market is already
   better** (a marketable buy limit above the market fills at the market on an
   exchange). On a driftless random walk this alone costs **−0.24 R per immediate
   fill (−0.17 R per trade overall)**; the realistic model is ~0 (`tests/fillBias.test.ts`).
   So every Python `limit_1bar` table (PHASE48, the live PAPER journal) understates
   the variant by roughly 0.15–0.2 R/trade. Fixed by default here
   (`IMMEDIATE_FILL_AT_MARKET=true`); `--python-parity` restores Python behaviour.
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
