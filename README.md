# Cvd_Bot

BINSC-style TypeScript trading engine whose **only** production strategy is
**True CVD divergence + absorption**.

PAPER mode is the default. LIVE order routing is compiled out until the
Before LIVE checklist is complete.

## Architecture

```
config → database → exchange
  → marketData (klines + aggTrades)
  → True CVD / delta
  → cvdDivergenceAbsorptionStrategy (per-symbol state)
  → risk
  → positions
  → executor (PAPER)
  → journal
  → telegram
  → reconciliation
```

Composition root: `src/main.ts` (wiring only). Orchestration: `src/app/TradingEngine.ts`.

Old RSI / engulfing strategies (`rsi_body_engulfing_v3`, `rsi_engulfing`,
`ema_rsi_volume`) are **not** in this repository and are **not** imported.

## True CVD

Delta is **not** inferred from OHLCV candle shape.

Closed candle:

```
takerSell = volume - takerBuyBaseAssetVolume
delta     = takerBuy - takerSell
CVD       = Σ delta
```

`takerBuyBaseAssetVolume` is Binance’s official buyer-initiated (taker buy) base volume.

Live forming candle (logging / reconnect restore, not signal entry):

- Stream: `<symbol>@aggTrade`
- `m` / `isBuyerMaker === true` → seller is taker → negative delta
- `isBuyerMaker === false` → buyer is taker → positive delta

Signals fire only on **closed** klines (`k.x === true` / REST closed bars).
The forming candle is never used for entry, SL, or TP.

## Strategy (closed candles, per symbol)

1. Wait for warmup (`CVD_WARMUP_BARS`, default 200).
2. Confirm fractal pivots (`left` / `right`, default 5/5) — non-repainting.
3. Regular **bullish** divergence: price lower low, CVD higher low.
4. Regular **bearish** divergence: price higher high, CVD lower high.
5. Divergence alone is **HOLD**. A matching **absorption** candle must print
   within `CVD_CONFIRMATION_WINDOW` bars:
   - elevated |delta| and volume vs SMA
   - tight range vs ATR
   - bullish: negative delta, close in the upper half of the range
   - bearish: positive delta, close in the lower half
6. Absorption alone is **HOLD**.
7. Duplicate `openTime` is ignored. One live position per symbol.

## Risk

```
riskAmount = equity * RISK_PERCENT / 100
qty        = floor(riskAmount / |entry - SL|, stepSize)
TP         = entry ± |entry - SL| * RR
```

SL is the divergence pivot extreme, buffered by `CVD_SL_BUFFER_TICKS` and
rounded to tick size. RR is symbol-specific (`SYMBOL_RR`).

## Run (PAPER)

```bash
cp .env.example .env
npm ci
npm run typecheck
npm test
npm start
```

Public Binance USD-M kline + aggTrade streams do not need API keys.
Leave `BINANCE_API_KEY` / `BINANCE_API_SECRET` empty.

## Tests

```bash
npm test
```

Coverage includes CVD / delta / accumulation, pivots, bullish/bearish
divergence, absorption, LONG/SHORT, HOLD without confirmation, warmup,
duplicate candles/signals, isolated multi-symbol state, risk sizing,
symbol RR, SL/TP, paper fills, and resync.

## Source note

This repo was bootstrapped because `AndriiC32/BINSC@cursor/unified-architecture-5078`
and `OMikki1808/2020@cursor/cvd-strategy-082f` were not readable with the
cloud-agent GitHub token (404). Formulas here are locked by tests. If those
trees become available, compare `src/indicators/*`,
`src/signalEngine/cvdDivergenceAbsorptionStrategy.ts`, `src/risk/riskManager.ts`,
and `src/config/schema.ts` against them (tests > code > config > docs).
