# Migration plan: CVD strategy into BINSC-style engine

## Source access

This agent could not clone:

- `AndriiC32/BINSC@cursor/unified-architecture-5078`
- `OMikki1808/2020@cursor/cvd-strategy-082f`

Both return GitHub 404 for the cloud-agent token (private or out of token scope).
The destination repo `OMikki1808/Cvd_Bot` was empty.

Therefore this integration **rebuilds the BINSC unified pipeline** from the architecture
specified in the task, and implements a **True CVD** (taker-side) divergence + absorption
strategy as the only production signal engine.

When the original `cvd-strategy-082f` tree becomes available, compare it against:

- `src/indicators/*`
- `src/signalEngine/cvdDivergenceAbsorptionStrategy.ts`
- `src/risk/riskManager.ts`
- `src/config/schema.ts`

Priority if that comparison finds diffs: tests → executable code → config → docs.

## Target pipeline (preserved BINSC shape)

```
config → database → exchange
  → marketData (klines + aggTrades)
  → True CVD / delta
  → cvdDivergenceAbsorptionStrategy (per-symbol state)
  → risk
  → positions
  → executor (PAPER default)
  → journal
  → telegram
  → reconciliation
```

Composition root: `src/main.ts` (wiring only). Engine: `src/app/TradingEngine.ts`.

## Files to add

| Path | Role |
| --- | --- |
| `src/config/schema.ts` | Zod config; CVD params; PAPER default |
| `src/marketData/marketDataService.ts` | Kline + aggTrade streams, reconnect/resync |
| `src/marketData/trueCvd.ts` | Taker-side delta (not OHLCV proxy) |
| `src/indicators/cvd.ts` | CVD accumulation |
| `src/indicators/pivots.ts` | Confirmed pivot high/low |
| `src/indicators/divergence.ts` | Regular bullish/bearish divergence |
| `src/indicators/absorption.ts` | Absorption confirmation |
| `src/signalEngine/cvdDivergenceAbsorptionStrategy.ts` | Per-symbol state machine |
| `src/risk/riskManager.ts` | CVD risk % / SL / TP / RR / filters |
| `src/executor/paperExecutor.ts` | PAPER fills + SL/TP |
| `tests/*.test.ts` | Required regression coverage |

## Old RSI strategies

`rsi_body_engulfing_v3`, `rsi_engulfing`, `ema_rsi_volume` are **not** present in this
repo and are **not** wired. CVD is the only strategy in the active pipeline.

## True CVD (non-negotiable)

Do **not** infer delta from `(close-low)/(high-low) * volume`.

- Closed candles: Binance kline `takerBuyBaseAssetVolume` vs total `volume`.
- Live forming candle: `aggTrade` with `m` / `isBuyerMaker` (taker side).
- Reconnect: rebuild CVD from REST klines; restore forming candle from recent aggTrades.
