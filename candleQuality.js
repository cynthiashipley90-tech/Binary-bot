// ---- Candle / price-action quality ----
// Pure OHLC-derived candle classification. Per the requirement this is
// explicitly NOT a standalone signal generator - analyzeLastCandle()
// returns a small, capped [-1,1] score meant to be one modest input inside
// binaryEngine's grouped confluence (its own CANDLE_QUALITY group, low
// weight), always read alongside structure/momentum/volume, never alone.

function bodyRange(c) {
  const range = c.high - c.low;
  const body = Math.abs(c.close - c.open);
  const bodyRatio = range > 0 ? body / range : 0;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const upperWickRatio = range > 0 ? upperWick / range : 0;
  const lowerWickRatio = range > 0 ? lowerWick / range : 0;
  const bullish = c.close > c.open;
  return { range, body, bodyRatio, upperWick, lowerWick, upperWickRatio, lowerWickRatio, bullish };
}

function classifySingle(c) {
  const m = bodyRange(c);
  const tags = [];

  if (m.bodyRatio < 0.1) tags.push('DOJI');
  if (m.bodyRatio > 0.7) tags.push(m.bullish ? 'MOMENTUM_BULL' : 'MOMENTUM_BEAR');
  // Rejection: a long wick on one side with a small body near the other
  // end - "price tried to go there and got rejected".
  if (m.lowerWickRatio > 0.55 && m.bodyRatio < 0.4) tags.push('BULLISH_REJECTION'); // long lower wick
  if (m.upperWickRatio > 0.55 && m.bodyRatio < 0.4) tags.push('BEARISH_REJECTION'); // long upper wick

  return { ...m, tags };
}

// Engulfing: current body fully engulfs the prior body, opposite direction.
function isEngulfing(prev, cur) {
  const prevM = bodyRange(prev);
  const curM = bodyRange(cur);
  if (curM.body <= prevM.body) return null;
  if (prevM.bullish === curM.bullish) return null;
  const engulfsBody = curM.bullish
    ? cur.open <= Math.min(prev.open, prev.close) && cur.close >= Math.max(prev.open, prev.close)
    : cur.open >= Math.max(prev.open, prev.close) && cur.close <= Math.min(prev.open, prev.close);
  if (!engulfsBody) return null;
  return curM.bullish ? 'BULLISH_ENGULFING' : 'BEARISH_ENGULFING';
}

// Inside bar: current bar's full range sits inside the prior bar's range -
// a compression/indecision signal, context-dependent (continuation setup
// in a trend, indecision in a range).
function isInsideBar(prev, cur) {
  return cur.high <= prev.high && cur.low >= prev.low;
}

// Consecutive same-direction candles - momentum persistence, or (if long)
// exhaustion risk. Just the count + direction; interpretation is left to
// the confluence weighting, not decided here.
function consecutiveDirectional(candles, maxLookback = 8) {
  const slice = candles.slice(-maxLookback);
  if (slice.length < 2) return { count: 0, direction: null };
  let direction = slice[slice.length - 1].close >= slice[slice.length - 1].open ? 'BULL' : 'BEAR';
  let count = 0;
  for (let i = slice.length - 1; i >= 0; i--) {
    const isBull = slice[i].close >= slice[i].open;
    if ((direction === 'BULL') === isBull) count += 1;
    else break;
  }
  return { count, direction };
}

// Compression/expansion: is the current bar's range small or large relative
// to its own recent average range (ATR-free, self-referential so it works
// even when the caller hasn't computed ATR).
function rangeState(candles, period = 14) {
  if (candles.length < period + 1) return { state: 'UNKNOWN', ratio: null };
  const ranges = candles.slice(-period - 1, -1).map((c) => c.high - c.low);
  const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
  const cur = candles[candles.length - 1];
  const curRange = cur.high - cur.low;
  if (avgRange <= 0) return { state: 'UNKNOWN', ratio: null };
  const ratio = curRange / avgRange;
  const state = ratio < 0.6 ? 'COMPRESSION' : ratio > 1.6 ? 'EXPANSION' : 'NORMAL';
  return { state, ratio: Number(ratio.toFixed(2)) };
}

// Top-level snapshot: classifies the most recent candle in context (prior
// candle for engulfing/inside-bar, recent run for consecutive-direction and
// compression/expansion), and derives one modest confluence score.
function analyzeLastCandle(candles) {
  if (candles.length < 3) return { available: false };
  const cur = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const single = classifySingle(cur);
  const engulfing = isEngulfing(prev, cur);
  const insideBar = isInsideBar(prev, cur);
  const consecutive = consecutiveDirectional(candles);
  const range = rangeState(candles);

  const tags = [...single.tags];
  if (engulfing) tags.push(engulfing);
  if (insideBar) tags.push('INSIDE_BAR');
  if (range.state !== 'UNKNOWN' && range.state !== 'NORMAL') tags.push(range.state);

  // Score: modest by design (see file header). Momentum/engulfing/rejection
  // tags each contribute a small signed nudge; multiple agreeing tags
  // still cap at +-1 via the final clamp, they don't stack unboundedly.
  let score = 0;
  if (tags.includes('MOMENTUM_BULL')) score += 0.4;
  if (tags.includes('MOMENTUM_BEAR')) score -= 0.4;
  if (tags.includes('BULLISH_ENGULFING')) score += 0.5;
  if (tags.includes('BEARISH_ENGULFING')) score -= 0.5;
  if (tags.includes('BULLISH_REJECTION')) score += 0.35;
  if (tags.includes('BEARISH_REJECTION')) score -= 0.35;
  if (tags.includes('DOJI')) score *= 0.5; // indecision dampens whatever else was found
  // Consecutive-direction: a short run adds a small momentum nudge; a long
  // run (>=5) is flagged as possible exhaustion instead and nudges the
  // OTHER way, lightly - stretched moves are more likely to pause/revert.
  if (consecutive.count >= 2 && consecutive.count < 5) {
    score += consecutive.direction === 'BULL' ? 0.15 : -0.15;
  } else if (consecutive.count >= 5) {
    tags.push('POSSIBLE_EXHAUSTION');
    score += consecutive.direction === 'BULL' ? -0.15 : 0.15;
  }
  score = Math.max(-1, Math.min(1, score));

  return {
    available: true,
    bodyRatio: Number(single.bodyRatio.toFixed(2)),
    upperWickRatio: Number(single.upperWickRatio.toFixed(2)),
    lowerWickRatio: Number(single.lowerWickRatio.toFixed(2)),
    tags,
    consecutiveCount: consecutive.count,
    consecutiveDirection: consecutive.direction,
    rangeState: range.state,
    rangeRatio: range.ratio,
    confluenceScore: Number(score.toFixed(2)),
  };
}

// ---- Classic single-candle pattern naming (real, geometry-only definitions) ----
// These are textbook geometric definitions (body/wick ratios + prior-trend
// context), not a statistical/learned claim - a name is only ever returned
// when the actual measured geometry clears the stated thresholds. The SAME
// geometry means a different name depending on what came before it (a
// small-body, long-lower-wick candle is a bullish "Hammer" after a
// downtrend, but a bearish "Hanging Man" after an uptrend) - so this always
// needs the recent trend context, never just the one candle in isolation.
function priorTrendDirection(candles) {
  // A simple, real measure: net direction of the last few candles BEFORE
  // the one being classified (close[-1] vs close[-N]) - not a prediction,
  // just "what was actually happening going into this candle".
  const n = Math.min(5, candles.length - 1);
  if (n < 2) return null;
  const from = candles[candles.length - 1 - n].close;
  const to = candles[candles.length - 2].close; // up to (not including) the classified candle
  if (!(from > 0)) return null;
  const pct = (to - from) / from;
  if (pct > 0.0003) return 'UP';
  if (pct < -0.0003) return 'DOWN';
  return null;
}

// `candles` must end at the candle being named; earlier candles provide
// the trend context. Returns a real classic name, or null when the
// geometry/context genuinely doesn't clear a named pattern's definition -
// callers must show a generic description in that case, never invent one.
function namedPatternFor(candles) {
  if (candles.length < 3) return null;
  const cur = candles[candles.length - 1];
  const m = bodyRange(cur);
  const trend = priorTrendDirection(candles.slice(0, -1).concat([cur]));

  if (m.bodyRatio < 0.1) return 'Doji';
  if (m.bodyRatio > 0.9) return m.bullish ? 'Bullish Marubozu' : 'Bearish Marubozu';

  // Small body, one dominant wick >= 2x the body, other wick small.
  const smallBody = m.bodyRatio < 0.35;
  const lowerDominant = smallBody && m.lowerWick >= m.body * 2 && m.upperWick <= m.body * 0.5;
  const upperDominant = smallBody && m.upperWick >= m.body * 2 && m.lowerWick <= m.body * 0.5;

  if (lowerDominant) {
    if (trend === 'DOWN') return 'Hammer';
    if (trend === 'UP') return 'Hanging Man';
    return null; // geometry matches but no clear prior trend to interpret it against - don't guess the name
  }
  if (upperDominant) {
    if (trend === 'UP') return 'Shooting Star';
    if (trend === 'DOWN') return 'Inverted Hammer';
    return null;
  }
  if (smallBody && m.upperWickRatio > 0.25 && m.lowerWickRatio > 0.25) return 'Spinning Top';
  return null; // a real, ordinary candle that doesn't match any classic named pattern - that's fine, most candles don't
}

module.exports = {
  bodyRange, classifySingle, isEngulfing, isInsideBar, consecutiveDirectional, rangeState, analyzeLastCandle, namedPatternFor,
};
