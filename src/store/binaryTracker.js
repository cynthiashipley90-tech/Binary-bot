const twelvedata = require('./twelvedata');
const binaryStore = require('./binaryStore');
const calibrationSvc = require('./calibration');
const expiryBucketsSvc = require('./expiryBuckets');
const logger = require('../utils/logger');

function pctDiff(a, b) {
  return Number((((a - b) / b) * 100).toFixed(4));
}

// ---- Exact-timestamp price resolution (section 11: "nearest candle" is not
// automatically "the exact expiry price") ----
// ---- Exact-timestamp price resolution (audit fix) ----
// A 1-minute candle only ever gives TWO genuinely-observed prices for its
// bar: its OPEN (the price at the bar's start instant) and its CLOSE (the
// price at the bar's end instant, one minute later). The exact expiry
// instant almost never lands exactly on either of those two points - it
// falls SOMEWHERE inside the bar. Previously this always used the bar's
// CLOSE, which for a target near the START of its bar could be labeled as
// "the expiry price" while actually representing a price up to ~60s AFTER
// the real expiry instant - i.e. the close of a LATER interval than
// requested, exactly the mislabeling this fix addresses.
//
// The methodology now picks whichever of the covering bar's two real,
// actually-observed prices (open or close) is TEMPORALLY CLOSER to the
// exact target instant - this is NOT interpolation or fabrication (no
// synthetic price is computed; only real recorded OHLC values are ever
// used), it only changes WHICH of the two already-real endpoints is
// reported, and bounds the worst-case reporting gap to ~30s instead of up
// to ~60s. `referencePoint` and `gapMs` are always recorded alongside the
// price so the actual observed endpoint and its distance from the true
// target instant are never hidden - "exact" is never claimed beyond what
// this resolution genuinely supports.
const EXPIRY_PRICE_MAX_GAP_MS = 60 * 1000;
// If the exact expiry price still cannot be reliably resolved this long
// after the scheduled expiry (persistent data gap/provider outage), stop
// waiting indefinitely and record the trade as NO_RESULT rather than
// leaving it open forever or eventually guessing a stale price.
const NO_RESULT_GRACE_MINUTES = 30;

function findPriceAtExpiry(candles, targetTime) {
  if (!candles.length) return null;
  const covering = candles.find((c) => targetTime >= c.time && targetTime < c.time + 60000);
  if (covering) {
    const msSinceOpen = targetTime - covering.time;
    const msUntilClose = (covering.time + 60000) - targetTime;
    if (msSinceOpen <= msUntilClose) {
      return {
        price: covering.open, candleTime: covering.time, referencePoint: 'bar-open', gapMs: msSinceOpen, method: 'covering-1m-bar-nearest-real-endpoint',
      };
    }
    return {
      price: covering.close, candleTime: covering.time + 60000, referencePoint: 'bar-close', gapMs: msUntilClose, method: 'covering-1m-bar-nearest-real-endpoint',
    };
  }
  let best = null;
  let bestDiff = Infinity;
  candles.forEach((c) => {
    const diff = Math.abs(c.time - targetTime);
    if (diff < bestDiff) {
      best = c;
      bestDiff = diff;
    }
  });
  if (best && bestDiff <= EXPIRY_PRICE_MAX_GAP_MS) {
    return {
      price: best.close, candleTime: best.time, referencePoint: 'nearest-bar-close', gapMs: targetTime - best.time, method: 'nearest-1m-bar-close-within-tolerance',
    };
  }
  return null; // no reliable price at the exact expiry instant - do not guess
}

async function checkOpenBinary(signal) {
  try {
    const now = Date.now();
    const elapsedMinutes = (now - signal.signalTime) / 60000;
    const outputsize = Math.min(500, Math.ceil(elapsedMinutes) + 10);
    const candles = await twelvedata.getTimeSeries(signal.symbol, '1min', outputsize);
    const relevant = candles.filter((c) => c.time >= signal.signalTime);
    if (!relevant.length) return;

    // Track the running extreme against the predicted final direction, for
    // the "price got close to flipping but didn't" narrative.
    let worstAgainstEntry = signal.worstAgainstEntry ?? signal.entryPrice;
    let worstAgainstTime = signal.worstAgainstTime ?? null;
    relevant.forEach((c) => {
      if (signal.direction === 'UP') {
        if (c.low < worstAgainstEntry) {
          worstAgainstEntry = c.low;
          worstAgainstTime = c.time;
        }
      } else if (c.high > worstAgainstEntry) {
        worstAgainstEntry = c.high;
        worstAgainstTime = c.time;
      }
    });

    const resolvedCheckpoints = { ...(signal.resolvedCheckpoints || {}) };
    let changed = false;

    for (const cp of signal.checkpoints) {
      if (resolvedCheckpoints[cp.fraction]) continue;
      if (elapsedMinutes < cp.minutes) continue;

      const targetTime = signal.signalTime + cp.minutes * 60000;
      const resolved = findPriceAtExpiry(relevant, targetTime);
      if (!resolved) continue; // not reliably resolvable yet - retry next cron cycle, never guess

      const priceAt = resolved.price;
      const actualDirection = priceAt >= signal.entryPrice ? 'UP' : 'DOWN';
      const correct = actualDirection === cp.direction;
      // eslint-disable-next-line no-await-in-loop
      await binaryStore.recordCheckpointOutcome(cp.fraction, correct);
      resolvedCheckpoints[cp.fraction] = {
        correct, priceAt, actualDirection, resolutionMethod: resolved.method, resolutionGapMs: resolved.gapMs, resolutionReferencePoint: resolved.referencePoint,
      };
      changed = true;
    }

    const finalCp = signal.checkpoints[signal.checkpoints.length - 1];
    const finalResolved = !!resolvedCheckpoints[finalCp.fraction];
    const expired = elapsedMinutes >= finalCp.minutes && finalResolved;

    // Persistent data gap right at expiry: stop waiting after a generous
    // grace period and record an honest NO_RESULT rather than an ever-open
    // signal or a guessed price.
    const pastGrace = elapsedMinutes >= finalCp.minutes + NO_RESULT_GRACE_MINUTES;
    if (!finalResolved && pastGrace) {
      logger.warn(`${signal.symbol} signal ${signal.id}: no reliable price at/near exact expiry (${new Date(signal.signalTime + finalCp.minutes * 60000).toISOString()}) after ${NO_RESULT_GRACE_MINUTES}min grace - recording NO_RESULT instead of guessing.`);
      await binaryStore.close(signal.id, {
        status: 'CLOSED',
        result: 'NO_RESULT',
        closePrice: null,
        closedAt: now,
        resolvedCheckpoints,
        noResultReason: 'INSUFFICIENT_DATA_AT_EXPIRY',
      });
      return;
    }

    if (expired) {
      const finalOutcome = resolvedCheckpoints[finalCp.fraction];
      const wentAgainstThenRecovered =
        (signal.direction === 'UP' && worstAgainstEntry < signal.entryPrice && finalOutcome.correct) ||
        (signal.direction === 'DOWN' && worstAgainstEntry > signal.entryPrice && finalOutcome.correct);

      let nearMissNote = null;
      if (wentAgainstThenRecovered && worstAgainstTime) {
        const secondsIn = Math.round((worstAgainstTime - signal.signalTime) / 1000);
        const movePct = pctDiff(worstAgainstEntry, signal.entryPrice);
        nearMissNote =
          `Trade ke ${secondsIn} second baad price ${worstAgainstEntry} tak chali gayi thi ` +
          `(entry se ${movePct}%) - agar us waqt expiry hoti to loss hota, lekin final expiry tak ` +
          `price wapas ${signal.direction === 'UP' ? 'upar' : 'neeche'} aa gayi.`;
      }

      await binaryStore.close(signal.id, {
        status: 'CLOSED',
        result: finalOutcome.correct ? 'WIN' : 'LOSS',
        closePrice: finalOutcome.priceAt,
        closedAt: now,
        worstAgainstEntry,
        worstAgainstTime,
        nearMissNote,
        resolvedCheckpoints,
      });

      // ---- Feed the real outcome back into calibration + performance
      // tracking. This is what turns "raw model probability" into
      // something that gets checked against reality over time, and what
      // powers the per-expiry / per-regime accuracy reporting. Every
      // closed trade updates exactly one calibration bucket (its own
      // expiry bucket x its own raw-probability bin) - never mixed with
      // other expiries or other probability ranges.
      try {
        const expiryBucketKey = signal.expiryBucket?.key
          || expiryBucketsSvc.getExpiryBucket(signal.durationMinutes).key;
        const regimeLabel = signal.regime?.label;
        const correct = finalOutcome.correct;
        if (Number.isFinite(signal.rawProbability)) {
          await calibrationSvc.recordCalibrationOutcome(expiryBucketKey, signal.rawProbability, correct);
        }
        await calibrationSvc.recordExpiryPerf(expiryBucketKey, correct);
        if (regimeLabel) {
          await calibrationSvc.recordRegimePerf(regimeLabel, correct);
          await calibrationSvc.recordExpiryRegimePerf(expiryBucketKey, regimeLabel, correct);
        }
        if (signal.session?.session) {
          await calibrationSvc.recordSessionPerf(signal.session.session, correct);
        }
        // Expected-expiry-price vs actual-expiry-price bias/error - a
        // SEPARATE validation from the direction win/loss above. Only
        // recorded when the signal actually carries a price target
        // (older persisted signals from before this field existed won't,
        // and are simply skipped here rather than poisoning the stat with
        // a null/zero).
        if (Number.isFinite(signal.expectedExpiryPrice) && Number.isFinite(finalOutcome.priceAt) && signal.entryPrice > 0) {
          await calibrationSvc.recordExpiryPriceAccuracy(expiryBucketKey, {
            entryPrice: signal.entryPrice,
            predictedPrice: signal.expectedExpiryPrice,
            actualPrice: finalOutcome.priceAt,
          });
        }
        // Feature-importance tracking (#16): each known boolean feature
        // flag gets its OWN outcome key ("<flag>:true" / "<flag>:false"),
        // so getAllFeaturePerf() can later show real win rate WITH vs.
        // WITHOUT each feature - e.g. was a volume-confirmed breakout
        // actually better than an unconfirmed one, in this bot's own
        // history, not by theoretical assumption.
        if (signal.featureFlags) {
          for (const [flag, value] of Object.entries(signal.featureFlags)) {
            if (typeof value === 'boolean') {
              // eslint-disable-next-line no-await-in-loop
              await calibrationSvc.recordFeatureOutcome(`${flag}:${value}`, correct);
            }
          }
        }
        // GROUP_WEIGHTS audit (#1): for each confluence group that had a
        // real (non-zero) directional lean, record whether THAT group's
        // own lean, on its own, agreed with the actual price outcome -
        // real evidence for whether a group is genuinely independently
        // predictive, never used to auto-adjust GROUP_WEIGHTS by itself.
        if (signal.confluenceGroupScores) {
          for (const [groupName, score] of Object.entries(signal.confluenceGroupScores)) {
            if (typeof score !== 'number' || score === 0) continue; // no opinion from this group - nothing to grade
            const groupDirection = score > 0 ? 'UP' : 'DOWN';
            const groupAgreed = groupDirection === finalOutcome.actualDirection;
            // eslint-disable-next-line no-await-in-loop
            await calibrationSvc.recordGroupDirectionOutcome(groupName, groupAgreed);
          }
        }
      } catch (calibErr) {
        // Never let calibration bookkeeping failures block closing the
        // trade itself - the WIN/LOSS record above is the source of
        // truth; calibration just re-derives from it.
        logger.error(`Calibration update failed for ${signal.id}: ${calibErr.message}`);
      }

      logger.info(`Binary signal ${signal.id} closed: ${finalOutcome.correct ? 'WIN' : 'LOSS'}`);
      return;
    }

    if (changed || worstAgainstEntry !== signal.worstAgainstEntry) {
      await binaryStore.update(signal.id, { resolvedCheckpoints, worstAgainstEntry, worstAgainstTime });
    }
  } catch (err) {
    logger.error(`Binary tracker error for ${signal.id} (${signal.symbol}): ${err.message}`);
  }
}

async function runBinaryTrackerCycle() {
  const open = await binaryStore.getOpen();
  if (!open.length) return;
  for (const signal of open) {
    // eslint-disable-next-line no-await-in-loop
    await checkOpenBinary(signal);
  }
}

module.exports = { runBinaryTrackerCycle, findPriceAtExpiry };
