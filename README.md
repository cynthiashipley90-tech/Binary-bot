# Binary Signal Bot (Discord)

Analysis-only Discord bot for binary/time-based options trading. No auto-trading, no hardcoded signals, no forced direction, **no AI dependency** - every reply comes from one deterministic multi-factor confluence engine running against live market data.

Every `!binary` (or `!market`) call fetches live market data from Twelve Data and runs a multi-factor, regime-aware, calibrated prediction engine before replying with **ENTRY PRICE -> EXACT EXPIRY TIMESTAMP -> EXPECTED EXPIRY PRICE**, UP / DOWN / NO_TRADE, a raw model probability, a separately-tracked calibrated probability, a separately-tracked historical accuracy, and an expected move (amount + %) - never a fixed number, and never a direction it can't back up.

## What it does

Two commands, plus a natural-language front end and an offline backtester:
- `!binary SYMBOL DURATION` - the primary deterministic signal.
- `!binaryaccuracy` - real historical win-rate, calibration and expiry-price-accuracy stats, broken down by expiry/regime/session.
- `!market ...` - a natural-language front end (`services/nlu.js`) onto the *exact same* deterministic engine, with per-channel follow-up memory and a couple of alternate views (compact / reasoning-only / data-quality-only). It is not a separate analysis - see "AI removed" below.
- `npm run backtest` - offline walk-forward backtester with zero lookahead.

Duration from 5 seconds to 48 hours - a plain number (minutes) or with a unit suffix (`30s`, `2h`, `48h`).

Pulls live 1-minute candle history + a live quote on every call - nothing is cached or reused between calls.

## AI removed

This project previously had an optional independent Gemini AI analyst (`!market` bot-vs-AI comparison + AI synthesis). **It has been fully removed**: `src/services/ai/` is deleted, there is no `GEMINI_*`/`AI_PROVIDER` config anywhere, `axios` remains only because `twelvedata.js` uses it for the market-data HTTP client, and the two AI-only Redis-log helper modules (`analysisMemory.js`, `analysisLog.js`) that were already unused have been deleted too. `!market` is now a thin, natural-language front end onto the same deterministic engine `!binary` uses (see `services/marketWorkflow.js`); asking it to "compare with AI" or similar returns an explicit message saying that comparison no longer exists, not a silent no-op.

## Entry -> exact expiry -> expected expiry price

Every signal is built around one thing: **what price does the engine expect AT the exact expiry moment**, not what the price does in between.

- `entryPrice` - the reference price the signal is judged from (live quote when fresh, else last candle close).
- `expiresAtMs` / `expiresAtIso` - the exact millisecond timestamp (`signalTime + duration`) the signal expires at, computed once and stored with the signal so tracking/settlement always resolves against that exact instant, never "whenever the cron next runs".
- `expectedExpiryPrice` - the model's point estimate for price *at* `expiresAtIso` (from the same random-walk/drift projection used for the checkpoint schedule, evaluated at fraction 1.0 - i.e. the expiry checkpoint itself, not an intermediate one).
- `expectedMoveAmount` / `expectedMovePct` - `expectedExpiryPrice - entryPrice`, in absolute price units and as a percentage of `entryPrice`.
- `expectedRangeLow` / `expectedRangeHigh` - the model's own uncertainty band around `expectedExpiryPrice` at expiry.

Intermediate checkpoints (`signal.checkpoints`) are still computed and shown (useful for sanity-checking the path the model expects), but the **final checkpoint (fraction 1.0) is what the direction, probability and all of the above fields are derived from** - intermediate price movement is never treated as the binary result.

## Expiry-price accuracy tracking (predicted vs actual, not just direction)

Historical accuracy already tracked *direction* correctness (WIN/LOSS) per expiry bucket. This is now paired with **price-level** validation: at settlement, `binaryTracker.js` compares the signal's `expectedExpiryPrice` against the real price observed at `expiresAtIso` and records the error via `calibration.js`:
- **bias** - mean signed error (`(actual - predicted) / entryPrice`, %) per expiry bucket, so a systematic over/under-shoot shows up explicitly rather than being averaged away by direction-only stats.
- **MAE** - mean absolute error (%), i.e. typically how far off the predicted expiry price is, regardless of direction.
- sample size - so a bucket with too few closed trades is shown as provisional, exactly like the existing calibration low-confidence flag.

Surfaced in `!binaryaccuracy` and in every `!binary`/`!market` reply's historical-evidence line, next to (not instead of) the existing win-rate numbers.

## Alternative-expiry evaluation

`services/timeframeSuggestion` (in `binaryEngine.js`) compares the requested duration's own signal clarity against neighboring native/resampled timeframes and **only surfaces an alternative when it is genuinely, materially stronger** (a fixed clarity-gap threshold, not "slightly different") - otherwise the reply says nothing about alternatives at all, rather than manufacturing a suggestion.

## What the engine already does (preserved, unchanged)

- **Three-state output**: UP / DOWN / NO_TRADE. A weak edge, an unstable market, too few usable indicators, or a duration far beyond what recent data can speak to all resolve to NO_TRADE instead of a forced direction (`src/services/binaryEngine.js`, `decideFinalSignal`).
- **Raw probability vs calibrated probability vs historical accuracy vs quality**, always shown as four separate, clearly labeled numbers - never conflated. Raw is what the drift/volatility random-walk math computes; calibrated is what this exact (expiry length x probability range) bucket has actually resolved to in real closed trades (`calibration.js`); historical accuracy is the plain win-rate for that bucket; quality is a categorical label built from calibration sample size and consistency.
- **Expiry-independent modeling**: calibration is tracked per expiry bucket (`expiryBuckets.js`) - a 70% raw reading on a 5-minute trade and a 70% raw reading on a 60-minute trade are calibrated against their own separate track records.
- **Market regime detection** (`regime.js`): TRENDING / RANGING / BREAKOUT / REVERSAL / UNSTABLE, crossed with a LOW/NORMAL/HIGH volatility axis. UNSTABLE is a hard gate toward NO_TRADE.
- **Grouped confluence, not vote-counting**: TREND, MOMENTUM, PRICE_ACTION, MEAN_REVERSION, VOLUME, DIVERGENCE, CANDLE_QUALITY groups, fixed weights, auto-renormalized around whichever groups actually had real data.
- **No look-ahead/future leakage**: the backtester (`backtest/run.js`) reuses the exact live `decideFinalSignal()`/`computeSignalCore()` functions, walk-forward, one point at a time, each decision only ever seeing candles strictly before it.
- **No forced signal on bad data**: `dataQuality.js` cleans/validates every candle series before any analysis runs; a validation failure is itself a NO_TRADE gate, both live and in `!market`'s `INSUFFICIENT_DATA` outcome.
- **Complete signal lifecycle**: signal -> Redis persistence (`binaryStore.js`) -> expiry -> real observed outcome -> calibration/historical-stats update (`binaryTracker.js`, a 1-minute cron) -> next signal in that bucket reads the updated stats. Existing tracker/calibration data is never reset or deleted by this change.
- **Order-book/liquidity-depth features**: intentionally not implemented - Twelve Data does not expose real depth data for these instruments, and this project does not fake one.

## What it deliberately does NOT do

- No liquidity/order-book analysis (no real data source for it here).
- No promise of matching a broker's OTC price - OTC prices are broker-generated and not available from any external API; this bot analyzes the real market feed.
- No AI/LLM component of any kind, anywhere.

## Architecture

```
src/
  index.js                 entrypoint: Discord connection, command routing, binary-tracker cron, health endpoint
  config.js                env var loading (NO AI config - see "AI removed")
  services/
    twelvedata.js           Twelve Data REST client (candles + live quote), real volume when available
    indicators.js           EMA / RSI / MACD / ATR / Stochastic / Bollinger Bands / ADX
    structure.js             swing highs/lows, S/R clustering + strength, breakout+retest+quality
    volume.js                RVOL, volume trend, spike detection - honestly reports unavailable, never fakes it
    candleQuality.js         body/wick ratios, engulfing, doji, inside bar, compression/expansion
    divergence.js            RSI/MACD/volume divergence: regular vs hidden, confirmed vs unconfirmed
    sessions.js              Asian/London/New York/overlap session classification
    dataQuality.js           missing/duplicate/invalid-OHLC/volume detection + cleaning; staleness check
    regime.js                TRENDING/RANGING/BREAKOUT/REVERSAL/UNSTABLE x LOW/NORMAL/HIGH volatility
    expiryBuckets.js         shared expiry-length bucketing (engine + calibration + reporting agree)
    calibration.js           probability calibration, win-rate, expiry-price bias/MAE, session & feature-importance tracking - all from real closed trades
    binaryEngine.js          the core engine: computeSignalCore() (pure math) + decideFinalSignal() (NO_TRADE gate) + generateBinarySignal() (live wrapper: fetch, calibration read, exact expiry timestamp + expected expiry price/move, staleness, final decision). fetchSignalInputs() splits out the raw fetch so !market can share one snapshot.
    binaryStore.js           Redis persistence for signals + accuracy
    binaryTracker.js         background job: resolves open signals at expiry (WIN/LOSS + expiry-price error/bias), feeds outcomes back into calibration.js
    redisStore.js            thin Upstash Redis REST wrapper
    marketSummary.js         deterministic market-context summary (symbol, reference price, staleness, data-quality issues) used by !market
    marketWorkflow.js        the !market workflow: one shared raw-data fetch -> the same deterministic bot analysis -> result (no AI stage)
    nlu.js                   deterministic (regex/whitelist) natural-language parser for !market - not an AI call
  commands/
    binary.js, binaryAccuracy.js   thin command handlers
    market.js                       !market entry point: parse -> run workflow -> format; 15-minute in-process per-channel follow-up memory
  backtest/
    run.js                   walk-forward, out-of-sample backtester CLI
  utils/
    formatting.js, marketFormatting.js, logger.js
tests/
  run-all.js, testKit.js, helpers/, *.test.js
```

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| `DISCORD_BOT_TOKEN` | yes | from the Discord Developer Portal |
| `TWELVEDATA_API_KEY` | yes | from your Twelve Data dashboard |
| `UPSTASH_REDIS_REST_URL` | yes | from Upstash |
| `UPSTASH_REDIS_REST_TOKEN` | yes | from Upstash |
| `PORT` | no | defaults to 3000 |
| `BINARY_MIN_DURATION_MIN` | no | defaults to 5 seconds (5/60) |
| `BINARY_MAX_DURATION_MIN` | no | defaults to 2880 (48 hours) |
| `BINARY_HIGH_TRUST_THRESHOLD` | no | defaults to 90 (display label threshold, on calibrated probability) |
| `BINARY_LOOKBACK_MIN` | no | defaults to 120 (minutes of history for the drift/vol core) |
| `BINARY_NO_TRADE_EDGE_PCT` | no | defaults to 5 - calibrated probability must be >=55% or the reply is NO_TRADE |
| `BINARY_MIN_CONFLUENCE_FACTORS` | no | defaults to 3 - fewer usable indicators than this forces NO_TRADE |
| `BINARY_MTF_DISAGREEMENT_PENALTY` | no | defaults to 0.4 |
| `MARKET_WORKFLOW_TIMEOUT_MS` | no | defaults to 120000 - hard ceiling for one `!market` run |

No `GEMINI_*` or `AI_*` variables exist or are read anywhere in this codebase.

## Testing

`npm test` runs every `tests/*.test.js` file, each in its own process (plain Node `assert`, no external test runner dependency). No test touches the real network, Redis, or Discord - Twelve Data, Redis and Discord messages are faked at their edges via `tests/helpers/`.

- `tests/binary-lifecycle.test.js` - full lifecycle: signal -> tracker registration -> simulated expiry -> real outcome -> historical stats update, including that NO_TRADE signals are never tracked.
- `tests/existing-features.test.js` - `!binary`/`!binaryaccuracy`, nlu parsing, the analytics core, formatters, AI-removal verification (AI modules genuinely gone, no AI config, dependency list unchanged).
- `tests/market-workflow.test.js` - the deterministic `!market` workflow: clean run, bad/insufficient data, timeout, bot failure, internal-bug safety, every outcome's rendered text, narrower intents.
- `tests/market-discord.test.js` - the real Discord round-trip through `routeCommand -> market command -> workflow -> engine`: WAITING-then-edit, send/edit failure fallbacks, INSUFFICIENT_DATA, tracked-signal registration, follow-up memory (no re-fetch), narrower views.

## Notes

This is a read-only analysis tool. It never places, modifies, or cancels any trade. Nothing here is financial advice. The model's raw probability and the bot's actual historical accuracy are two different numbers, always shown separately - a 70% reading describes what the math computed, not a guarantee. NO_TRADE is a feature, not a failure: if the engine genuinely can't vouch for a duration or market condition, it says so instead of forcing UP or DOWN.

## `!signal` - separate spot/futures-style crypto trading signal

A binary option has a fixed time window and a fixed payout, decided only by price at the exact expiry instant - it structurally has no stop-loss/take-profit concept. A real spot/futures trade is the opposite: open-ended, and its outcome is whichever of a real Stop Loss or Take Profit gets touched first. Rather than force that mismatch into `!binary`'s output, this is a **separate, independent signal type** that does not modify, require being modified by, or share any Redis keys with the binary engine:

- `!signal BTCUSD` - Entry (current price), Stop Loss, Take Profit 1 and Take Profit 2, ATR(14), quality label, market regime, nearest support/resistance. Direction is LONG / SHORT / NO_SIGNAL - reuses the exact same real multi-factor confluence read (`binaryEngine.buildConfluence`, called read-only) that `!binary` uses for its own direction.
- `!signalaccuracy` - real settled-signal stats: TP1 wins, TP2 wins, losses, and unresolved/expired counts, overall and per symbol.
- **No arbitrary TP/SL**: Stop Loss is placed beyond the nearest real market-structure swing point, widened by a real ATR-based buffer (falls back to a pure ATR multiple only when no usable swing point exists). Take Profit is the nearest real support/resistance level that clears a minimum risk:reward floor (falls back to a fixed R-multiple of the real stop distance only when no such level exists). Nothing here is a flat "+2%" guess.
- **Lifecycle**: `services/spotEngine.js` (pure signal generation) -> `services/spotStore.js` (Redis persistence, its own `spot:*` key namespace) -> `services/spotTracker.js` (a separate 1-minute cron that walks real historical candles chronologically from entry time to resolve whichever of SL/TP1/TP2 was touched first; a signal that hits neither within 72h is marked `EXPIRED_UNRESOLVED`, never guessed).
- `utils/spotFormatting.js` - its own Discord formatting, separate from `!binary`'s.

Same disclaimers apply: no guaranteed outcome, not financial advice, and (per the same principle as `!binary`) no accuracy claim until real settled signals accumulate via `!signalaccuracy`.
