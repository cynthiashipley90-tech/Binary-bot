// ---- Deterministic next-candle forecast ----
//
// A separate forecasting layer from (and never allowed to override) the
// binary expiry decision - see the comment in binaryEngine.js's
// generateBinarySignal where this is attached to the signal.
//
// ---- Timeframe (audit fix) ----
// "Next candle" is meaningless without saying which candle size it is.
// This module is always told an explicit `timeframeMinutes` by the caller
// (binaryEngine.js) - it never assumes 1-minute. binaryEngine.js derives
// that timeframe from `mtfFactorFor(duration)`, the SAME already-existing,
// already-justified parameter that decides which higher timeframe the
// engine checks for MTF context on this expiry (5min for 10-30min expiries,
// 15min for 30min+ expiries, native 1min below that) - so the next-candle
// timeframe is never a newly-invented arbitrary choice, and it is always
// genuinely smaller than the expiry duration itself (never duplicates the
// expected-expiry-price forecast - see prediction-type separation below).
// The caller passes in `candles` ALREADY resampled to that timeframe; this
// module never resamples anything itself.
//
// NO LOOKAHEAD: `candles` always ends at the last CLOSED bar of
// `timeframeMinutes` size - the bar being forecast is never part of its
// own input, live or in the backtester.
//
// ---- Prediction-type separation (audit fix) ----
// This module computes its OWN drift/volatility directly from the resampled
// series' own real historical returns (not reused/rescaled from the
// expiry's native 1-minute drift/vol) - so a next-candle read can never
// silently inherit or inflate the expiry-level probability, and vice versa.
// A bullish next-candle read does not mechanically make the expiry
// direction UP - they are computed from entirely separate return series.
//
// ---- Structure is LEARNED from history, never copied from "now" (audit
// fix) ----
// The predicted structure comes from a real (current-shape -> NEXT-shape)
// historical frequency table (buildCurrentToNextTable below) - i.e. what
// candle shape has ACTUALLY, historically, followed the current one in this
// same series, not a restatement of the current candle's own tag/pattern.
// If that historical read isn't trustworthy (too few similar prior
// candles), the forecast falls back to an explicitly generic, low-
// confidence description rather than inventing a specific pattern name.

function range(c) { return Math.max(c.high - c.low, 1e-12); }
function candleColor(c) { return c.close > c.open ? 'GREEN' : c.close < c.open ? 'RED' : 'FLAT'; }

// A coarse, real, measurable shape bucket - used ONLY to build/query the
// historical current-shape -> next-shape/next-color conditional table
// below. Buckets don't need to be exhaustive, just consistent between the
// table-building pass and the lookup of the current bar.
function shapeClass(c, avgRange) {
  const body = Math.abs(c.close - c.open);
  const r = range(c);
  const bodyRatio = r > 0 ? body / r : 0;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const color = candleColor(c);
  if (bodyRatio < 0.1) return 'DOJI';
  if (upperWick > body * 1.5 && upperWick > lowerWick) return 'UPPER_REJECTION';
  if (lowerWick > body * 1.5 && lowerWick > upperWick) return 'LOWER_REJECTION';
  const strongBody = bodyRatio > 0.6 && r > avgRange * 0.8;
  if (strongBody && color === 'GREEN') return 'STRONG_BULL';
  if (strongBody && color === 'RED') return 'STRONG_BEAR';
  return color === 'GREEN' ? 'WEAK_BULL' : color === 'RED' ? 'WEAK_BEAR' : 'FLAT';
}

const SHAPE_DESCRIPTIONS = {
  DOJI: 'Indecision / doji-type candle',
  UPPER_REJECTION: 'Bearish rejection candle (upper-wick rejection)',
  LOWER_REJECTION: 'Bullish rejection candle (lower-wick rejection)',
  STRONG_BULL: 'Strong bullish continuation candle',
  WEAK_BULL: 'Mild bullish candle',
  STRONG_BEAR: 'Strong bearish continuation candle',
  WEAK_BEAR: 'Mild bearish candle',
  FLAT: 'Flat / indecisive candle',
};

// Every (i, i+1) pair here is entirely historical relative to "now" - this
// is only ever called on the already-closed lookback window, so there is
// no leakage: candle i+1 in this table is itself a real past candle, never
// the one being forecast. Tracks BOTH the next candle's color (for the
// probability read) and its full shape class (for the structure read) -
// two genuinely different questions from the same real pairs.
function buildCurrentToNextTable(candles) {
  if (candles.length < 20) return null;
  const avgRange = candles.reduce((a, c) => a + range(c), 0) / candles.length;
  const table = {};
  for (let i = 0; i < candles.length - 1; i += 1) {
    const cls = shapeClass(candles[i], avgRange);
    const next = candles[i + 1];
    const nextColor = candleColor(next);
    const nextShape = shapeClass(next, avgRange);
    if (!table[cls]) {
      table[cls] = {
        GREEN: 0, RED: 0, FLAT: 0, total: 0, nextShapes: {},
      };
    }
    table[cls][nextColor] += 1;
    table[cls].nextShapes[nextShape] = (table[cls].nextShapes[nextShape] || 0) + 1;
    table[cls].total += 1;
  }
  return { table, avgRange };
}

// Below this, the conditional read for that shape class is not trustworthy
// enough to use at all - falls back to the drift/volatility projection
// alone (probability) and an explicitly generic description (structure).
const MIN_CLASS_SAMPLE = 8;

function conditionalRead(candles) {
  // Everything except the very last (current) bar is the training set; the
  // current bar is only ever the LOOKUP KEY, never one of the pairs it's
  // being compared against.
  const built = buildCurrentToNextTable(candles.slice(0, -1));
  if (!built) return null;
  const current = candles[candles.length - 1];
  const cls = shapeClass(current, built.avgRange);
  const stats = built.table[cls];
  if (!stats || stats.total < MIN_CLASS_SAMPLE) return { cls, stats: stats || null, trustworthy: false };

  let bestNextShape = null;
  let bestCount = 0;
  Object.entries(stats.nextShapes).forEach(([shape, count]) => {
    if (count > bestCount) {
      bestNextShape = shape;
      bestCount = count;
    }
  });

  return {
    cls,
    stats,
    trustworthy: true,
    greenPct: Number(((stats.GREEN / stats.total) * 100).toFixed(1)),
    nextShape: bestNextShape,
    nextShapePct: Number(((bestCount / stats.total) * 100).toFixed(1)),
    nextShapeCount: bestCount,
  };
}

// Structure comes from the historical (current-shape -> next-shape) read
// ONLY - never from directly restating the current candle's own tag. When
// the read isn't trustworthy, this returns an explicitly generic,
// low-confidence description instead of a specific pattern name.
function describeExpectedStructure(cond, driftPerBar) {
  if (cond && cond.trustworthy && cond.nextShape) {
    const base = SHAPE_DESCRIPTIONS[cond.nextShape] || 'Directional candle';
    // A real, geometry-based classic name is only appended when the
    // predicted shape class + the current known trend direction (driftPerBar,
    // already-real data, not a guess) together clearly map to one - framed
    // as conditional ("if it forms"), since this is inherently a forecast
    // of a candle that hasn't happened yet, never asserted as certain.
    let classicHint = null;
    if (cond.nextShape === 'LOWER_REJECTION') {
      classicHint = driftPerBar < 0 ? 'Hammer-type, bullish reversal setup' : driftPerBar > 0 ? 'Hanging-Man-type, bearish reversal setup' : null;
    } else if (cond.nextShape === 'UPPER_REJECTION') {
      classicHint = driftPerBar > 0 ? 'Shooting-Star-type, bearish reversal setup' : driftPerBar < 0 ? 'Inverted-Hammer-type, bullish reversal setup' : null;
    } else if (cond.nextShape === 'DOJI') {
      classicHint = 'Doji-type, indecision';
    }
    return {
      text: `${base} likely (historically followed a ${cond.cls}-shaped bar ${cond.nextShapePct}% of the time here, n=${cond.stats.total})${classicHint ? ` — if it forms, would classically read as a ${classicHint}` : ''}`,
      evidenceTags: [`historical: ${cond.cls} -> ${cond.nextShape} ${cond.nextShapePct}% (n=${cond.stats.total})`],
    };
  }
  return {
    text: 'No trustworthy historical structural evidence for this timeframe/shape yet - a generic, non-specific candle is expected',
    evidenceTags: [],
  };
}

// `timeframeMinutes` MUST be supplied by the caller (see file header) -
// there is no default, so a caller can never accidentally forecast a
// 1-minute candle while believing it matches the requested/selected expiry.
// `candles` must already be resampled to that timeframe by the caller.
// `logReturns`/`mean`/`stdev`/`studentTCdf` are injected from
// binaryEngine.js's own exports so this module computes its drift/vol with
// the EXACT same statistical functions, but on its OWN independent return
// series (see "prediction-type separation" in the file header) - never a
// rescale of the expiry-level drift/vol. studentTCdf (rather than a plain
// normal CDF) is used for the SAME reason binaryEngine.js's own checkpoint
// probabilities use it - the drift/vol read here is itself an ESTIMATE from
// a finite window of real bars, so its own uncertainty needs to be
// reflected, automatically scaled by how many bars actually went into the
// estimate (degrees of freedom = real observation count - never a fixed
// cap or a tuned constant).
function forecastNextCandle({
  candles, timeframeMinutes, candleQuality, studentTCdf, logReturns, mean, stdev,
}) {
  const timeframeLabel = timeframeMinutes === 1 ? '1 minute (native)' : `${timeframeMinutes} minutes (resampled)`;
  if (!candles || candles.length < 20 || !timeframeMinutes) {
    return {
      timeframeMinutes: timeframeMinutes || 1,
      timeframeLabel,
      direction: 'UNCERTAIN',
      probabilityGreenPct: null,
      probabilityRedPct: null,
      expectedStructure: 'Insufficient history at this timeframe to forecast the next candle',
      confidence: 'LOW',
      expectedOpen: null,
      expectedClose: null,
      expectedHigh: null,
      expectedLow: null,
      expectedMove: null,
      expectedMovePct: null,
      evidence: [],
    };
  }

  const last = candles[candles.length - 1];
  const expectedOpen = last.close; // next bar's open IS this bar's close on a continuous feed

  // ---- OWN, independent drift/vol for THIS timeframe's own returns ----
  const closes = candles.map((c) => c.close);
  const rets = logReturns(closes);
  const driftPerBar = mean(rets);
  const volPerBar = stdev(rets, driftPerBar);
  const zGreen = volPerBar > 0 ? driftPerBar / volPerBar : (driftPerBar > 0 ? 6 : driftPerBar < 0 ? -6 : 0);
  const rawGreenPct = Number((studentTCdf(zGreen, rets.length - 1) * 100).toFixed(1));

  const cond = conditionalRead(candles);
  const evidence = [`drift/volatility projection over this bar's own ${timeframeLabel} return history: ${rawGreenPct}% raw probability green`];
  let greenPct = rawGreenPct;
  if (cond && cond.trustworthy) {
    greenPct = Number(((rawGreenPct + cond.greenPct) / 2).toFixed(1));
    evidence.push(`historical current-shape evidence (shape=${cond.cls}, n=${cond.stats.total} similar ${timeframeLabel} bars): ${cond.greenPct}% were followed by a green bar`);
  } else if (cond) {
    evidence.push(`current-shape sample too small at this timeframe to use with confidence (shape=${cond.cls}, n=${cond.stats?.total || 0}) - relying on the drift/volatility projection alone`);
  } else {
    evidence.push('not enough bars at this timeframe yet for a historical current-shape read');
  }

  const redPct = Number((100 - greenPct).toFixed(1));
  const NEUTRAL_BAND_PP = 4;
  const direction = Math.abs(greenPct - 50) < NEUTRAL_BAND_PP ? 'UNCERTAIN' : (greenPct > 50 ? 'GREEN' : 'RED');

  const expectedClose = expectedOpen * (1 + driftPerBar);
  const expectedMove = Number((expectedClose - expectedOpen).toPrecision(8));
  const expectedMovePct = Number((driftPerBar * 100).toFixed(4));
  const rangeHalfWidth = expectedOpen * volPerBar;
  const expectedHigh = Number((Math.max(expectedOpen, expectedClose) + rangeHalfWidth).toPrecision(8));
  const expectedLow = Number((Math.min(expectedOpen, expectedClose) - rangeHalfWidth).toPrecision(8));

  const structure = describeExpectedStructure(cond, driftPerBar);
  evidence.push(...structure.evidenceTags);
  if (candleQuality?.tags?.length) {
    evidence.push(`(for reference only, not used as the prediction) current ${timeframeLabel} bar's own measured shape: ${candleQuality.tags.join(', ')}`);
  }

  let confidence = 'LOW';
  if (direction !== 'UNCERTAIN') {
    const edge = Math.abs(greenPct - 50);
    if (edge >= 15 && cond?.trustworthy) confidence = 'HIGH';
    else if (edge >= 7 || cond?.trustworthy) confidence = 'MEDIUM';
  }

  return {
    timeframeMinutes,
    timeframeLabel,
    direction,
    probabilityGreenPct: greenPct,
    probabilityRedPct: redPct,
    expectedStructure: structure.text,
    confidence,
    expectedOpen: Number(expectedOpen.toPrecision(8)),
    expectedClose: Number(expectedClose.toPrecision(8)),
    expectedHigh,
    expectedLow,
    expectedMove,
    expectedMovePct,
    evidence,
  };
}

module.exports = {
  forecastNextCandle,
  shapeClass,
  buildCurrentToNextTable,
  conditionalRead,
  describeExpectedStructure,
  MIN_CLASS_SAMPLE,
};
