#!/usr/bin/env node
// ---- Walk-forward / out-of-sample backtester ----
//
// This is a REAL simulation, not a shortcut: for every point in time `i`
// in the historical candle series, it calls the exact same
// binaryEngine.computeSignalCore() AND binaryEngine.decideFinalSignal()
// used by the live !binary command, but passing them ONLY candles[0..i]
// (everything up to and including "now" in the simulation) - the function
// has no way to see candles[i+1..] because they are never passed to it.
// The outcome is then read from candles[i + expiryMinutes] (real,
// already-happened future data available to the *backtester*, never to
// the function under test). This is what "no data leakage" means here in
// concrete terms.
//
// Reusing decideFinalSignal (rather than a separately-written approximation
// of its gates) means the backtest is validating the EXACT same NO_TRADE
// logic the live bot runs - data-quality gate, false-breakout gate,
// contradictory-momentum gate, weak-structure gate, regime gate, edge
// threshold - not a subset of it that could quietly drift out of sync.
// Since real closed-trade calibration doesn't exist yet for a cold bucket
// (that's what this backtest is FOR), the raw probability stands in for
// "calibratedPct" when calling decideFinalSignal here - documented, not
// hidden: this makes the backtest slightly more permissive than live,
// where mtf-disagreement penalties and any prior seeded calibration would
// already have shaved the edge before this same edge check runs.
//
// Usage:
//   node src/backtest/run.js SYMBOL EXPIRY_MINUTES [--candles=N] [--seed]
//
// Examples:
//   node src/backtest/run.js EURUSD 5
//   node src/backtest/run.js BTCUSD 15 --candles=4000
//   node src/backtest/run.js EURUSD 30 --seed     (also writes results into
//                                                    the live Redis
//                                                    calibration store, so
//                                                    the bot isn't starting
//                                                    stone cold)
//
// What it reports (per requirement #10 "advanced backtesting"):
//   - total samples, wins/losses, win rate, no-trade rate, average outcome
//   - calibration curve (raw-probability bin -> actual resolution rate)
//   - breakdown by: market regime, session/time-of-day, volume
//     availability, confidence/quality bucket, and feature flags
//     (volume-confirmed breakout vs not, divergence present vs not, etc.)
//   - train/test split is implicit in the walk-forward design itself:
//     every single point's "prediction" only ever sees data strictly
//     before it, so there is no separate train/test split to configure -
//     the entire run IS out-of-sample, point by point
//
// Honesty note: Twelve Data's free plan only keeps a limited window of
// 1-minute history, so this is a *recent-history* out-of-sample test, not
// a multi-year one. Re-run periodically as more real trades accumulate
// live - that live data is the more important long-run source of truth.

const path = require('path');
process.env.DOTENV_CONFIG_PATH = process.env.DOTENV_CONFIG_PATH || path.join(__dirname, '../../.env');
require('dotenv').config({ path: process.env.DOTENV_CONFIG_PATH });

const config = require('../config');
const twelvedata = require('../services/twelvedata');
const engine = require('../services/binaryEngine');
const expiryBucketsSvc = require('../services/expiryBuckets');
const calibrationSvc = require('../services/calibration');

function parseArgs(argv) {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const flags = Object.fromEntries(
    argv.filter((a) => a.startsWith('--')).map((a) => {
      const [k, v] = a.slice(2).split('=');
      return [k, v === undefined ? true : v];
    })
  );
  const symbol = positional[0];
  const expiryMinutes = Number(positional[1]);
  if (!symbol || !Number.isFinite(expiryMinutes) || expiryMinutes <= 0) {
    console.error('Usage: node src/backtest/run.js SYMBOL EXPIRY_MINUTES [--candles=N] [--seed] [--step=N]');
    process.exit(1);
  }
  return {
    symbol,
    expiryMinutes,
    maxCandles: flags.candles ? Number(flags.candles) : 2000,
    seed: !!flags.seed,
    // Evaluate every Nth minute instead of every single minute - much
    // faster, and adjacent 1-minute-apart signals on the same trend aren't
    // independent samples anyway, so stepping avoids an inflated n that's
    // really the same handful of moves counted many times over.
    step: flags.step ? Number(flags.step) : Math.max(1, Math.round(expiryMinutes / 3)),
  };
}

function probBinLabel(pct) {
  return calibrationSvc.getProbBin(pct).key;
}

function printBreakdown(title, rows, keyOf) {
  console.log('');
  console.log(title);
  const byKey = {};
  rows.forEach((r) => {
    const k = keyOf(r);
    if (k == null) return;
    byKey[k] = byKey[k] || { wins: 0, total: 0 };
    byKey[k].total += 1;
    if (r.correct) byKey[k].wins += 1;
  });
  Object.entries(byKey)
    .sort((a, b) => b[1].total - a[1].total)
    .forEach(([k, s]) => {
      const pct = ((s.wins / s.total) * 100).toFixed(1);
      console.log(`  ${k}: ${pct}% (n=${s.total})`);
    });
  if (!Object.keys(byKey).length) console.log('  (no data)');
}

async function main() {
  const { symbol, expiryMinutes, maxCandles, seed, step } = parseArgs(process.argv.slice(2));

  console.log(`Fetching up to ${maxCandles} 1-minute candles for ${symbol}...`);
  const candles = await twelvedata.getTimeSeries(symbol, '1min', maxCandles);
  console.log(`Got ${candles.length} candles (${candles.length ? new Date(candles[0].time).toISOString() : 'n/a'} -> ${candles.length ? new Date(candles[candles.length - 1].time).toISOString() : 'n/a'}).`);

  const duration = Math.max(
    config.binary.minDurationMinutes,
    Math.min(config.binary.maxDurationMinutes, expiryMinutes)
  );
  const statsLookback = Math.max(60, config.binary.lookbackMinutesForStats, Math.min(720, Math.ceil(duration * 1.5)));
  const expiryBucket = expiryBucketsSvc.getExpiryBucket(duration);

  // Need at least statsLookback candles of history BEFORE the decision
  // point, and `duration` candles AFTER it to know the real outcome. Not
  // requiring the full multi-timeframe fetch size here (that's a "nice to
  // have" per-point, gracefully degrades to native-only inside
  // computeMultiTimeframeConfluence when unavailable) - requiring it would
  // needlessly shrink the usable backtest window on symbols with limited
  // history.
  const startIdx = statsLookback;
  const endIdx = candles.length - Math.ceil(duration) - 1;
  if (endIdx <= startIdx) {
    console.error(`Not enough candles for a walk-forward test at ${duration}min expiry (need ~${statsLookback + Math.ceil(duration)}, have ${candles.length}).`);
    process.exit(1);
  }

  const results = []; // { rawProbability, correct, regimeLabel, session, volumeAvailable, qualityBucket, featureFlags }
  let noTradeCount = 0;
  let evaluated = 0;

  const fetchSize = engine.requiredFetchSize(duration, statsLookback);

  for (let i = startIdx; i <= endIdx; i += step) {
    // STRICT NO-LOOKAHEAD: window is candles[0..i] only, sized the same
    // way the live path sizes its fetch (requiredFetchSize) so the
    // multi-timeframe blend gets exercised here too, not just the drift/
    // vol stats window. computeSignalCore never receives anything beyond
    // index i.
    const window = candles.slice(Math.max(0, i - fetchSize), i + 1);
    if (window.length < 30) continue;
    const entryPrice = window[window.length - 1].close;

    let core;
    try {
      core = engine.computeSignalCore(window, entryPrice, duration, statsLookback);
    } catch (err) {
      continue; // e.g. insufficient data for some indicator at this point - skip, don't fake a result
    }
    evaluated += 1;

    // Reuse the EXACT live decision gate (see file header for why raw
    // probability stands in for calibratedPct here).
    const decision = engine.decideFinalSignal({
      rawDirection: core.rawDirection,
      calibratedPct: core.rawProbability,
      regimeInfo: core.regimeInfo,
      factorCount: core.nativeConfluence.factorCount,
      mtfAgreement: core.mtf.agreement,
      duration,
      statsLookback,
      calibrationSampleSize: 0,
      dataQuality: core.dataQuality,
      structureInfo: core.structureInfo,
      breakoutInfo: core.breakoutInfo,
      groupScores: core.nativeConfluence.groupScores,
    });

    if (decision.direction === 'NO_TRADE') {
      noTradeCount += 1;
      continue;
    }

    // Real, already-happened outcome - available to the BACKTESTER, never
    // passed into computeSignalCore.
    const outcomeIdx = i + Math.round(duration);
    if (outcomeIdx >= candles.length) continue;
    const outcomeClose = candles[outcomeIdx].close;
    const actualDirection = outcomeClose >= entryPrice ? 'UP' : 'DOWN';
    const correct = actualDirection === core.rawDirection;

    // Average outcome: the realized % price move in the predicted
    // direction (positive = move helped, negative = move hurt) - a
    // magnitude-aware companion to the plain win/loss count.
    const movePct = ((outcomeClose - entryPrice) / entryPrice) * 100 * (core.rawDirection === 'UP' ? 1 : -1);

    let qualityBucket = 'LOW';
    let qScore = 0;
    if (core.regimeInfo.reliable) qScore += 1;
    if (core.mtf.agreement !== false) qScore += 1;
    if (core.nativeConfluence.factorCount >= 5) qScore += 1;
    qualityBucket = qScore >= 3 ? 'HIGH' : qScore >= 2 ? 'MEDIUM' : 'LOW';

    results.push({
      rawProbability: core.rawProbability,
      correct,
      movePct,
      regimeLabel: core.regimeInfo.label,
      session: core.session.session,
      volumeAvailable: core.volumeState.available,
      qualityBucket,
      featureFlags: core.featureFlags,
    });
  }

  const totalConsidered = evaluated;
  const noTradeRate = totalConsidered ? (noTradeCount / totalConsidered) * 100 : 0;

  if (!results.length) {
    console.log(`No tradeable signals found in this window (${noTradeCount} NO_TRADE out of ${evaluated} evaluated points, ${noTradeRate.toFixed(1)}% no-trade rate).`);
    return;
  }

  const wins = results.filter((r) => r.correct).length;
  const losses = results.length - wins;
  const winRate = (wins / results.length) * 100;
  const avgOutcomePct = results.reduce((a, r) => a + r.movePct, 0) / results.length;

  console.log('');
  console.log(`=== ${symbol} @ ${expiryMinutes}min expiry (bucket: ${expiryBucket.label}) ===`);
  console.log(`Evaluated points: ${evaluated} | Tradeable: ${results.length} | NO_TRADE: ${noTradeCount} (${noTradeRate.toFixed(1)}%)`);
  console.log(`Wins: ${wins} | Losses: ${losses} | Win rate: ${winRate.toFixed(1)}% (n=${results.length})`);
  console.log(`Average outcome (realized move in predicted direction): ${avgOutcomePct >= 0 ? '+' : ''}${avgOutcomePct.toFixed(4)}%`);

  console.log('');
  console.log('Calibration curve (raw probability bin -> actual resolution rate):');
  const byBin = {};
  results.forEach((r) => {
    const bin = probBinLabel(r.rawProbability);
    byBin[bin] = byBin[bin] || { wins: 0, total: 0 };
    byBin[bin].total += 1;
    if (r.correct) byBin[bin].wins += 1;
  });
  Object.entries(byBin)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([bin, s]) => {
      const pct = ((s.wins / s.total) * 100).toFixed(1);
      console.log(`  ${bin}%: model said this range, actual = ${pct}% correct (n=${s.total})`);
    });

  printBreakdown('Win rate by regime:', results, (r) => r.regimeLabel);
  printBreakdown('Win rate by session/time-of-day:', results, (r) => r.session);
  printBreakdown('Win rate by quality bucket:', results, (r) => r.qualityBucket);
  printBreakdown('Win rate by volume availability:', results, (r) => (r.volumeAvailable ? 'VOLUME_AVAILABLE' : 'VOLUME_UNAVAILABLE'));

  console.log('');
  console.log('Feature-wise breakdown (#16 - present vs. absent, from THIS run\'s data):');
  const featureKeys = new Set();
  results.forEach((r) => Object.keys(r.featureFlags || {}).forEach((k) => featureKeys.add(k)));
  for (const fk of featureKeys) {
    const withFlagTrue = results.filter((r) => r.featureFlags[fk] === true);
    const withFlagFalse = results.filter((r) => r.featureFlags[fk] === false);
    const pct = (rows) => rows.length ? ((rows.filter((r) => r.correct).length / rows.length) * 100).toFixed(1) : null;
    const trueLine = withFlagTrue.length ? `${pct(withFlagTrue)}% (n=${withFlagTrue.length})` : 'no data';
    const falseLine = withFlagFalse.length ? `${pct(withFlagFalse)}% (n=${withFlagFalse.length})` : 'no data';
    console.log(`  ${fk}: true -> ${trueLine} | false -> ${falseLine}`);
  }

  if (seed) {
    console.log('');
    console.log(`--seed set: writing these results into the live calibration store for expiry bucket "${expiryBucket.key}"...`);
    for (const r of results) {
      // eslint-disable-next-line no-await-in-loop
      await calibrationSvc.recordCalibrationOutcome(expiryBucket.key, r.rawProbability, r.correct);
      // eslint-disable-next-line no-await-in-loop
      await calibrationSvc.recordExpiryPerf(expiryBucket.key, r.correct);
      // eslint-disable-next-line no-await-in-loop
      await calibrationSvc.recordRegimePerf(r.regimeLabel, r.correct);
      // eslint-disable-next-line no-await-in-loop
      await calibrationSvc.recordExpiryRegimePerf(expiryBucket.key, r.regimeLabel, r.correct);
      // eslint-disable-next-line no-await-in-loop
      await calibrationSvc.recordSessionPerf(r.session, r.correct);
      // eslint-disable-next-line no-await-in-loop
      for (const [flag, value] of Object.entries(r.featureFlags || {})) {
        if (typeof value === 'boolean') {
          // eslint-disable-next-line no-await-in-loop
          await calibrationSvc.recordFeatureOutcome(`${flag}:${value}`, r.correct);
        }
      }
    }
    console.log(`Seeded ${results.length} outcomes. The live bot will now blend these into its calibrated probability for this expiry bucket.`);
  } else {
    console.log('');
    console.log('(Run again with --seed to write these results into the live calibration store.)');
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
