// Swing-point based market structure analysis.
// No fixed coin/date assumptions - works purely off the candle array passed in.

function findSwings(candles, lookback = 3) {
  const swingHighs = [];
  const swingLows = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const windowSlice = candles.slice(i - lookback, i + lookback + 1);
    const c = candles[i];
    const isHigh = windowSlice.every((w) => w.high <= c.high);
    const isLow = windowSlice.every((w) => w.low >= c.low);
    if (isHigh) swingHighs.push({ index: i, price: c.high, time: c.time ?? c.openTime });
    if (isLow) swingLows.push({ index: i, price: c.low, time: c.time ?? c.openTime });
  }
  return { swingHighs, swingLows };
}

// Returns: 'HH_HL' (uptrend structure), 'LH_LL' (downtrend structure), 'MIXED'
function classifyStructure(candles) {
  const { swingHighs, swingLows } = findSwings(candles);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { pattern: 'INSUFFICIENT_DATA', score: 0, swingHighs, swingLows };
  }
  const lastHighs = swingHighs.slice(-2);
  const lastLows = swingLows.slice(-2);
  const higherHigh = lastHighs[1].price > lastHighs[0].price;
  const higherLow = lastLows[1].price > lastLows[0].price;
  const lowerHigh = lastHighs[1].price < lastHighs[0].price;
  const lowerLow = lastLows[1].price < lastLows[0].price;

  let pattern = 'MIXED';
  let score = 0;
  if (higherHigh && higherLow) {
    pattern = 'HH_HL';
    score = 1;
  } else if (lowerHigh && lowerLow) {
    pattern = 'LH_LL';
    score = -1;
  } else if (higherHigh || higherLow) {
    pattern = 'MIXED_BULLISH_LEAN';
    score = 0.3;
  } else if (lowerHigh || lowerLow) {
    pattern = 'MIXED_BEARISH_LEAN';
    score = -0.3;
  }
  return { pattern, score, swingHighs, swingLows };
}

// Cluster swing points into support/resistance levels using proximity grouping.
function findKeyLevels(candles, tolerancePct = 0.15) {
  const { swingHighs, swingLows } = findSwings(candles);
  const allPoints = [
    ...swingHighs.map((p) => ({ ...p, type: 'resistance' })),
    ...swingLows.map((p) => ({ ...p, type: 'support' })),
  ];

  const levels = [];
  for (const point of allPoints) {
    const existing = levels.find(
      (lvl) => Math.abs(lvl.price - point.price) / point.price * 100 < tolerancePct * 10
    );
    if (existing) {
      existing.touches += 1;
      existing.price = (existing.price * (existing.touches - 1) + point.price) / existing.touches;
      existing.touchTimes.push(point.time);
      existing.touchIndexes.push(point.index);
    } else {
      levels.push({ price: point.price, type: point.type, touches: 1, touchTimes: [point.time], touchIndexes: [point.index] });
    }
  }
  return levels.sort((a, b) => b.touches - a.touches);
}

function nearestLevels(currentPrice, levels) {
  const support = levels
    .filter((l) => l.price < currentPrice)
    .sort((a, b) => b.price - a.price)[0];
  const resistance = levels
    .filter((l) => l.price > currentPrice)
    .sort((a, b) => a.price - b.price)[0];
  return { support, resistance };
}

// Detect a recent breakout of a key level followed by a retest (price returned
// close to the broken level within a few candles).
function detectBreakoutRetest(candles, levels, lookback = 15) {
  const recent = candles.slice(-lookback);
  const currentPrice = candles[candles.length - 1].close;

  for (const level of levels) {
    const breakoutCandle = recent.find((c, idx) => {
      if (idx === 0) return false;
      const prev = recent[idx - 1];
      if (level.type === 'resistance') {
        return prev.close <= level.price && c.close > level.price;
      }
      return prev.close >= level.price && c.close < level.price;
    });
    if (!breakoutCandle) continue;

    const breakoutIdx = recent.indexOf(breakoutCandle);
    const afterBreakout = recent.slice(breakoutIdx + 1);
    const retested = afterBreakout.some(
      (c) => Math.abs(c.low - level.price) / level.price < 0.002 ||
             Math.abs(c.high - level.price) / level.price < 0.002
    );

    if (level.type === 'resistance' && currentPrice > level.price) {
      return {
        type: 'BULLISH_BREAKOUT_RETEST',
        level: level.price,
        retested,
        score: retested ? 1 : 0.5,
      };
    }
    if (level.type === 'support' && currentPrice < level.price) {
      return {
        type: 'BEARISH_BREAKDOWN_RETEST',
        level: level.price,
        retested,
        score: retested ? -1 : -0.5,
      };
    }
  }
  return { type: 'NONE', score: 0 };
}

// ---- S/R level strength (additive - findKeyLevels/nearestLevels above are
// unchanged in behavior, this just scores what they already return) ----
// Combines: touch count, spacing between touches (evenly-spaced touches
// over a long span are a stronger level than several touches clustered in
// one brief cluster), recency (a level last touched long ago is weaker -
// the market's memory of it fades), and optional volume confirmation at
// the touches (only applied when volume data is available).
function scoreLevelStrength(level, candles, opts = {}) {
  const lastCandleTime = candles[candles.length - 1]?.time ?? Date.now();
  const lastCandleIdx = candles.length - 1;
  const touches = level.touches || 1;
  const touchTimes = level.touchTimes || [];
  const touchIndexes = level.touchIndexes || [];

  // Touch count: diminishing returns past ~4 touches (a level doesn't get
  // meaningfully stronger just because it's been hit 10 times if 6 of
  // those were within the same tight cluster).
  const touchScore = Math.min(1, Math.log2(touches + 1) / Math.log2(5));

  // Spacing: coefficient of variation of gaps between touch indexes - low
  // variation (evenly spread) scores higher than touches bunched together.
  let spacingScore = 0.5; // neutral default when we can't judge (few touches)
  if (touchIndexes.length >= 3) {
    const sorted = [...touchIndexes].sort((a, b) => a - b);
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
    const meanGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const variance = gaps.reduce((a, b) => a + (b - meanGap) ** 2, 0) / gaps.length;
    const cv = meanGap > 0 ? Math.sqrt(variance) / meanGap : 1;
    spacingScore = Math.max(0, Math.min(1, 1 - cv / 1.5));
  }

  // Recency: most recent touch, as a fraction of how far back the series
  // goes - a touch right at the edge of "now" scores ~1, a touch at the
  // very start of the lookback window scores lower.
  let recencyScore = 0.5;
  if (touchIndexes.length) {
    const mostRecentIdx = Math.max(...touchIndexes);
    const ageFraction = lastCandleIdx > 0 ? (lastCandleIdx - mostRecentIdx) / lastCandleIdx : 0;
    recencyScore = Math.max(0, 1 - ageFraction);
  }

  // Optional volume confirmation at the touches (only when volume data is
  // real - see volume.js honesty note). Not required for a score; simply
  // omitted (weight redistributed to the other three) when unavailable.
  let volumeScore = null;
  if (opts.volumeState && opts.volumeState.available && typeof opts.rangeVolumeConfirmed === 'function' && touchIndexes.length) {
    const confirmedFlags = touchIndexes.map((idx) => opts.rangeVolumeConfirmed(candles, Math.max(0, idx - 1), Math.min(candles.length - 1, idx + 1)));
    const known = confirmedFlags.filter((f) => f !== null);
    if (known.length) volumeScore = known.filter(Boolean).length / known.length;
  }

  const parts = [touchScore, spacingScore, recencyScore];
  const weights = [0.4, 0.3, 0.3];
  if (volumeScore != null) {
    parts.push(volumeScore);
    weights.push(0.25);
    // renormalize
    const sum = weights.reduce((a, b) => a + b, 0);
    for (let i = 0; i < weights.length; i++) weights[i] /= sum;
  }
  const strength = parts.reduce((acc, p, i) => acc + p * weights[i], 0);

  return {
    strength: Number(strength.toFixed(2)),
    touchScore: Number(touchScore.toFixed(2)),
    spacingScore: Number(spacingScore.toFixed(2)),
    recencyScore: Number(recencyScore.toFixed(2)),
    volumeScore: volumeScore != null ? Number(volumeScore.toFixed(2)) : null,
  };
}

function enrichLevelsWithStrength(levels, candles, opts = {}) {
  return levels.map((lvl) => ({ ...lvl, ...scoreLevelStrength(lvl, candles, opts) }));
}

// ---- Breakout quality (additive - wraps/extends detectBreakoutRetest
// above, which is left completely untouched for backward compatibility) ----
// Adds: breakout-candle strength (via the caller-supplied candle quality
// analyzer, kept as an injected function to avoid a require() cycle between
// structure.js and candleQuality.js), volume confirmation (when available),
// distance beyond the level, follow-through candle count, and false-
// breakout detection (broke the level, then closed back on the wrong side
// within the lookback window without ever re-breaking).
function analyzeBreakoutQuality(candles, levels, opts = {}) {
  const base = detectBreakoutRetest(candles, levels, opts.lookback || 15);
  if (base.type === 'NONE') return { ...base, quality: null };

  const lookback = opts.lookback || 15;
  const recent = candles.slice(-lookback);
  const level = levels.find((l) => Math.abs(l.price - base.level) < 1e-9) || null;

  // Re-locate the breakout candle the same way detectBreakoutRetest did,
  // so distance/follow-through can be measured against it.
  let breakoutIdxInRecent = -1;
  if (level) {
    breakoutIdxInRecent = recent.findIndex((c, idx) => {
      if (idx === 0) return false;
      const prev = recent[idx - 1];
      if (level.type === 'resistance') return prev.close <= level.price && c.close > level.price;
      return prev.close >= level.price && c.close < level.price;
    });
  }
  if (breakoutIdxInRecent < 0) return { ...base, quality: null };

  const breakoutIdxAbsolute = candles.length - recent.length + breakoutIdxInRecent;
  const breakoutCandle = recent[breakoutIdxInRecent];
  const afterBreakout = recent.slice(breakoutIdxInRecent + 1);
  const currentPrice = candles[candles.length - 1].close;

  const distanceBeyondPct = Math.abs((currentPrice - base.level) / base.level) * 100;

  // Follow-through: how many of the bars after the breakout candle closed
  // on the "right" side of the level (continuing the break, not reverting).
  const isBullish = base.type === 'BULLISH_BREAKOUT_RETEST';
  const followThroughCandles = afterBreakout.filter((c) => (isBullish ? c.close > base.level : c.close < base.level)).length;

  // False breakout: broke the level, but has since closed back on the
  // WRONG side and, as of the current price, is still there (i.e. the
  // break didn't hold).
  const currentlyWrongSide = isBullish ? currentPrice <= base.level : currentPrice >= base.level;
  const falseBreakout = currentlyWrongSide && afterBreakout.length > 0;

  let breakoutCandleStrength = null;
  if (typeof opts.candleQualityFn === 'function') {
    const upToBreakout = candles.slice(0, breakoutIdxAbsolute + 1);
    const analyzed = opts.candleQualityFn(upToBreakout);
    if (analyzed && analyzed.available) breakoutCandleStrength = analyzed.bodyRatio;
  }

  let volumeConfirmed = null;
  if (opts.volumeState && opts.volumeState.available && typeof opts.rangeVolumeConfirmed === 'function') {
    volumeConfirmed = opts.rangeVolumeConfirmed(candles, breakoutIdxAbsolute, Math.min(candles.length - 1, breakoutIdxAbsolute + 2));
  }

  // Overall quality: starts from "retested" (base.score already reflects
  // that), then explicitly does NOT auto-upgrade to high confidence just
  // because a break happened - each additional confirming factor
  // (follow-through, volume, not-false) nudges quality up; their absence
  // nudges it down. This is the concrete form of the requirement
  // "breakout without confirmation != automatically high-confidence".
  let qualityScore = base.retested ? 0.5 : 0.2;
  if (followThroughCandles >= 2) qualityScore += 0.2;
  if (volumeConfirmed === true) qualityScore += 0.25;
  if (volumeConfirmed === false) qualityScore -= 0.2;
  if (falseBreakout) qualityScore -= 0.5;
  qualityScore = Math.max(0, Math.min(1, qualityScore));

  return {
    ...base,
    distanceBeyondPct: Number(distanceBeyondPct.toFixed(3)),
    followThroughCandles,
    falseBreakout,
    breakoutCandleStrength,
    volumeConfirmed,
    quality: Number(qualityScore.toFixed(2)),
  };
}

module.exports = {
  findSwings,
  classifyStructure,
  findKeyLevels,
  nearestLevels,
  detectBreakoutRetest,
  scoreLevelStrength,
  enrichLevelsWithStrength,
  analyzeBreakoutQuality,
};
