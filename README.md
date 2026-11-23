# Cvd_Bot

TypeScript PAPER runtime + backtester for the **real** CVD divergence strategy
from `OMikki1808/CVDBot-prodaction`: **082F Engine-v2, limit entry valid 1 bar**
(`V082F_ENGINE_V2_LIMIT_1BAR`). The port is bit-exact against the Python engine —
see [docs/STRATEGY_SOURCE.md](docs/STRATEGY_SOURCE.md) for the rules, provenance,
parity check and known quirks.

LIVE trading is not implemented.

## Architecture

```
Binance SPOT kline_15m WS ──┐
Binance SPOT REST (gaps) ───┤→ PaperRuntime (serial queue, recovery mode for replays)
                            │     → PaperPortfolio (shared equity, fees, slippage, leverage caps)
                            │          → Engine082fLimit1Bar per symbol (15m → 1H, CVD, pivots,
                            │            divergence, confirmation, limit order, SL/TP/reverse)
                            │     → SQLite: engine state, account, idempotent close ledger, events
                            └     → Telegram (fire-and-forget)
backtest CLI ──→ same PaperPortfolio/engine on CSV klines
```

| Path | Role |
| --- | --- |
| `src/strategy/` | Strategy port + frozen pools (no dependencies, IEEE floats like Python) |
| `src/portfolio/paperPortfolio.ts` | Shared equity, costs, exposure limits — used by backtest **and** runtime |
| `src/runtime/paperRuntime.ts` | Live PAPER loop, persistence, gap recovery |
| `src/exchange/binanceSpot.ts` | REST (timeouts, retries, rate limit) + WS (watchdog) |
| `src/backtest/` | `fetch-data`, `backtest` CLIs |
| `tests/parity/`, `parity/` | Bit-exact parity harness against the Python engine |

## Backtest

```bash
npm ci
npm run fetch-data -- --from 2025-08-01 --to 2026-08-01          # whole PHASE50 pool → ./data/klines
npm run backtest  -- --from 2025-08-01 --to 2026-08-01 --out ./bt  # net of costs, shared equity
npm run backtest  -- --from 2025-08-01 --to 2026-08-01 --gross --isolated   # = Python PHASE48 tables
npm run backtest  -- --symbols DOGEUSDT,SOLUSDT --fix-immediate-exit --max-total-lev 10
```

Binance Vision monthly CSVs (`<SYMBOL>-15m-YYYY-MM.csv`, µs timestamps) can be dropped
into `./data/klines` as well. See the header of `src/backtest/cli.ts` for all flags.

## Run (PAPER)

```bash
cp .env.example .env
npm ci && npm run typecheck && npm test
npm start
```

On the first start each symbol is warmed up silently from `WARMUP_DAYS` of REST history.
After that, state is restored from SQLite and any downtime is refilled from REST
(replayed bars never open brand-new setups, but pending orders and open
positions progress through them, as in the Python runtime).

## Tests

```bash
npm test          # parity, primitives, state round-trip, backtester, runtime (fake REST/WS + SQLite)
npm run parity    # parity report only
```

To regenerate the oracle fixture from Python:
`PRODACTION_PATH=../CVDBot-prodaction npm run parity:oracle`.
