// ---- Data quality checks ----
// Pure, structural checks on a candle array - no wall-clock dependency, so
// they behave identically live and inside the walk-forward backtester
// (which is exactly the point: a backtest that skipped these checks would
// be validating a code path the live bot doesn't actually run).
//
// Staleness (is this candle series too OLD relative to right now) is a
// separate, wall-clock-dependent check - see checkStaleness() below - and
// is intentionally NOT part of validateCandleSeries(), since "stale
// relative to now" isn't a meaningful concept when the backtester is
// deliberately looking at old data.

function inferIntervalMs(candles) {
  if (candles.length < 3) return 60000; // assume 1-minute, can't infer from <3 points
  const diffs = [];
  for (let i = 1; i < Math.min(candles.length, 30); i++) {
    diffs.push(candles[i].time - candles[i - 1].time);
  }
  diffs.sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || 60000; // median
}

// Structural validation + cleaning: sorts ascending, drops exact-duplicate
// timestamps (keeping the first occurrence), flags missing-bar gaps, and
// flags/repairs individual candles with invalid OHLC (non-finite, or
// high<low, or high/low not enclosing open/close).
function validateCandleSeries(candles) {
  const issues = [];
  if (!Array.isArray(candles) || candles.length === 0) {
    return { ok: false, issues: ['empty candle series'], cleaned: [], gapCount: 0, duplicateCount: 0, invalidCount: 0, invalidVolumeCount: 0 };
  }

  // Sort ascending by time (defensive - callers are expected to already
  // pass chronological data, but a provider hiccup could reorder a page).
  const sorted = [...candles].sort((a, b) => a.time - b.time);

  // De-duplicate exact-timestamp repeats.
  const deduped = [];
  let duplicateCount = 0;
  for (const c of sorted) {
    const prev = deduped[deduped.length - 1];
    if (prev && prev.time === c.time) {
      duplicateCount += 1;
      continue;
    }
    deduped.push(c);
  }
  if (duplicateCount > 0) issues.push(`${duplicateCount} duplicate-timestamp candle(s) dropped`);

  // Invalid OHLC: non-finite values, or a high/low that doesn't actually
  // enclose open/close (internally inconsistent bar - treat as corrupt).
  let invalidCount = 0;
  let invalidVolumeCount = 0;
  const cleaned = [];
  for (const c of deduped) {
    const nums = [c.open, c.high, c.low, c.close];
    const allFinite = nums.every((n) => Number.isFinite(n) && n > 0);
    const encloses = allFinite && c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && c.high >= c.low;
    if (!allFinite || !encloses) {
      invalidCount += 1;
      continue; // drop the bar rather than silently trade on corrupt OHLC
    }
    // Invalid volume is flagged, not silently coerced to 0 or dropped -
    // the bar itself is still usable for price analysis, it just loses its
    // volume reading for this one candle.
    let volume = c.volume;
    if (volume !== null && volume !== undefined) {
      if (!Number.isFinite(volume) || volume < 0) {
        invalidVolumeCount += 1;
        volume = null;
      }
    } else {
      volume = null;
    }
    cleaned.push({ ...c, volume });
  }
  if (invalidCount > 0) issues.push(`${invalidCount} candle(s) with invalid/inconsistent OHLC dropped`);
  if (invalidVolumeCount > 0) issues.push(`${invalidVolumeCount} candle(s) had an invalid volume value (negative/non-numeric) - volume nulled for those bars, price data kept`);

  // Gap detection: count runs of missing bars against the series' own
  // median spacing (so this works for 1min, 5min, whatever interval was
  // requested, without hardcoding 60000ms).
  const intervalMs = inferIntervalMs(cleaned);
  let gapCount = 0;
  let largestGapBars = 0;
  for (let i = 1; i < cleaned.length; i++) {
    const dt = cleaned[i].time - cleaned[i - 1].time;
    const missingBars = Math.round(dt / intervalMs) - 1;
    if (missingBars > 0) {
      gapCount += 1;
      largestGapBars = Math.max(largestGapBars, missingBars);
    }
  }
  if (gapCount > 0) issues.push(`${gapCount} gap(s) in the candle timeline (largest: ${largestGapBars} missing bar(s))`);

  const ok = cleaned.length >= 30 && invalidCount < deduped.length * 0.1;

  return { ok, issues, cleaned, gapCount, largestGapBars, duplicateCount, invalidCount, invalidVolumeCount, intervalMs };
}

// Wall-clock staleness: is the most recent candle suspiciously old for a
// call that's supposed to be reading LIVE data right now? Only meaningful
// for the live path - the backtester should never call this.
function checkStaleness(candles, nowMs, intervalMs = 60000, maxStaleBars = 5) {
  if (!candles.length) return { stale: true, ageMs: Infinity, ageBars: Infinity };
  const last = candles[candles.length - 1];
  const ageMs = nowMs - last.time;
  const ageBars = ageMs / intervalMs;
  return { stale: ageBars > maxStaleBars, ageMs, ageBars: Number(ageBars.toFixed(1)) };
}

module.exports = { validateCandleSeries, checkStaleness, inferIntervalMs };
