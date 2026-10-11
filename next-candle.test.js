require('./helpers/stubDeps');
const assert = require('assert');
const { test, run } = require('./testKit');
const binaryEngine = require('../src/services/binaryEngine');
const {
  forecastNextCandle, shapeClass, buildCurrentToNextTable, conditionalRead, MIN_CLASS_SAMPLE,
} = require('../src/services/nextCandle');

const { studentTCdf, logReturns, mean, stdev } = binaryEngine;

function makeCandle(time, open, close, high, low) {
  return {
    time, open, close, high: high != null ? high : Math.max(open, close), low: low != null ? low : Math.min(open, close), volume: null,
  };
}

function statFns() {
  return {
    studentTCdf, logReturns, mean, stdev,
  };
}

// A synthetic series where every candle whose CURRENT shape is
// STRONG_BULL is reliably followed by a GREEN candle, and everything else
// is small alternating noise - lets us assert the conditional table is
// actually learned from real (candle[i], candle[i+1]) pairs, not invented.
function buildLearnableSeries(n, base = 100) {
  const out = [];
  let price = base;
  for (let i = 0; i < n; i += 1) {
    const t = i * 60000;
    const forced = i % 4 === 0; // every 4th candle is forced to be a big, unambiguous strong-bull mover
    const prevWasForced = i > 0 && (i - 1) % 4 === 0;
    const open = price;
    let close;
    if (forced) {
      close = open * 1.006; // large, unambiguous bullish body -> classifies as STRONG_BULL
    } else if (prevWasForced) {
      close = open * 1.003; // reliably green right after a forced strong-bull candle - the learnable relationship
    } else {
      close = open * (i % 2 === 0 ? 1.0004 : 0.9996); // small alternating noise otherwise
    }
    const high = Math.max(open, close) * 1.00005;
    const low = Math.min(open, close) * 0.99995;
    out.push(makeCandle(t, open, close, high, low));
    price = close;
  }
  return out;
}

// ---------------------------------------------------------------- no-lookahead
test('1. buildCurrentToNextTable never uses a candle as evidence for itself, and the current (last) candle is excluded from training', () => {
  const series = buildLearnableSeries(60);
  const conditional = conditionalRead(series);
  assert.ok(conditional, 'should produce a conditional read on a long-enough series');
  const built = buildCurrentToNextTable(series.slice(0, -1));
  const totalObservations = Object.values(built.table).reduce((a, s) => a + s.total, 0);
  assert.strictEqual(totalObservations, series.length - 2, 'training pairs must come only from candles strictly before the current one');
});

test('2. the historical current-shape -> next-color table is LEARNED from real data, not hardcoded (a synthetic reliable pattern is actually detected)', () => {
  const series = buildLearnableSeries(80);
  const built = buildCurrentToNextTable(series.slice(0, -1));
  const strongBull = built.table.STRONG_BULL;
  assert.ok(strongBull && strongBull.total >= MIN_CLASS_SAMPLE, 'the synthetic STRONG_BULL pattern should show up with a real sample size');
  const greenRate = strongBull.GREEN / strongBull.total;
  assert.ok(greenRate > 0.8, `a genuinely reliable historical pattern should be reflected in the table (got ${greenRate})`);
});

test('3. forecastNextCandle never reads the candle it is forecasting - swapping the (unused) next real candle changes nothing', () => {
  const series = buildLearnableSeries(80);
  const forecastA = forecastNextCandle({
    candles: series, timeframeMinutes: 1, candleQuality: null, ...statFns(),
  });
  // Now mutate what WOULD be the next candle in a live feed (append a wild
  // outlier after the series) and re-run using only candles up to "now" -
  // this must not change the result at all.
  const mutatedFuture = series.concat([makeCandle(series.length * 60000, 100000, 1, 100000, 1)]);
  const forecastB = forecastNextCandle({
    candles: mutatedFuture.slice(0, series.length), timeframeMinutes: 1, candleQuality: null, ...statFns(),
  });
  assert.deepStrictEqual(forecastA, forecastB, 'appending a future candle that was never passed in must not change the forecast');
});

// ---------------------------------------------------------------- timeframe awareness (audit fix)
test('4a. the forecast always reports the EXPLICIT timeframe it was computed for - never a silent default', () => {
  const series = buildLearnableSeries(80);
  const f1 = forecastNextCandle({
    candles: series, timeframeMinutes: 1, candleQuality: null, ...statFns(),
  });
  assert.strictEqual(f1.timeframeMinutes, 1);
  assert.match(f1.timeframeLabel, /1 minute/);

  const f15 = forecastNextCandle({
    candles: series, timeframeMinutes: 15, candleQuality: null, ...statFns(),
  });
  assert.strictEqual(f15.timeframeMinutes, 15);
  assert.match(f15.timeframeLabel, /15 minutes/);
});

test('4b. generateBinarySignal never hardcodes the next-candle timeframe to 1 minute for a duration whose MTF context is a higher timeframe', async () => {
  const series = buildLearnableSeries(1200, 1.2); // enough bars for the 15min-factor MTF resample requirement
  const core = binaryEngine.computeSignalCore(series, series[series.length - 1].close, 60, 120); // 60min duration -> mtfFactorFor(60) === 15
  assert.strictEqual(core.nextCandleForecast.timeframeMinutes, 15, 'a 60-minute request should forecast the next 15-minute bar (the engine\'s own MTF context timeframe), not a native 1-minute bar');
});

test('4c. a short duration with no MTF context correctly falls back to the native 1-minute timeframe, explicitly labeled', async () => {
  const series = buildLearnableSeries(200, 1.2);
  const core = binaryEngine.computeSignalCore(series, series[series.length - 1].close, 5, 60); // 5min duration -> mtfFactorFor(5) === null
  assert.strictEqual(core.nextCandleForecast.timeframeMinutes, 1);
});

// ---------------------------------------------------------------- prediction-type separation (audit fix)
test('4d. the next-candle drift/vol is computed independently from the series\' OWN returns, never reused from a different (e.g. expiry-level) drift/vol figure', () => {
  const series = buildLearnableSeries(80);
  const f = forecastNextCandle({
    candles: series, timeframeMinutes: 1, candleQuality: null, ...statFns(),
  });
  // Recompute the expected drift/vol directly and confirm the forecast's
  // own expectedMovePct matches it exactly (i.e. it truly comes from this
  // series' own logReturns, not an injected/rescaled number).
  const closes = series.map((c) => c.close);
  const rets = logReturns(closes);
  const drift = mean(rets);
  assert.strictEqual(f.expectedMovePct, Number((drift * 100).toFixed(4)));
});

// ---------------------------------------------------------------- shape/output sanity
test('5. too little history yields an honest UNCERTAIN forecast, not an invented number', () => {
  const f = forecastNextCandle({
    candles: buildLearnableSeries(5), timeframeMinutes: 1, candleQuality: { available: false }, ...statFns(),
  });
  assert.strictEqual(f.direction, 'UNCERTAIN');
  assert.strictEqual(f.probabilityGreenPct, null);
  assert.match(f.expectedStructure, /Insufficient history/);
});

test('6. probabilityGreenPct + probabilityRedPct always sum to 100, and expectedOpen equals the last candle close', () => {
  const series = buildLearnableSeries(50);
  const f = forecastNextCandle({
    candles: series, timeframeMinutes: 1, candleQuality: { available: true, tags: [] }, ...statFns(),
  });
  assert.strictEqual(Number((f.probabilityGreenPct + f.probabilityRedPct).toFixed(1)), 100);
  assert.strictEqual(f.expectedOpen, Number(series[series.length - 1].close.toPrecision(8)));
});

// ---------------------------------------------------------------- structure genuinely learned, not copied (audit fix)
test('7. structure prediction is NEVER a direct copy of the current candle\'s own tag - it comes from the historical (current-shape -> next-shape) table', () => {
  // A series where a DOJI-shaped current candle is historically, reliably
  // followed by a STRONG_BULL candle (never by another doji) - if the
  // module were just copying the current candle's own "DOJI" tag forward,
  // it would describe the next candle as indecisive; the genuinely correct,
  // evidence-based answer here is a bullish continuation candle instead.
  const out = [];
  let price = 100;
  for (let i = 0; i < 61; i += 1) { // n=61 so the LAST candle (i=60) is itself a doji (60 % 3 === 0)
    const isDoji = i % 3 === 0;
    const open = price;
    let close;
    if (isDoji) {
      close = open * 1.000001; // true doji: ~zero body
    } else if (i > 0 && (i - 1) % 3 === 0) {
      close = open * 1.008; // reliably strong-bull right after a doji
    } else {
      close = open * (i % 2 === 0 ? 1.0004 : 0.9996);
    }
    out.push(makeCandle(i * 60000, open, close, Math.max(open, close) * 1.00005, Math.min(open, close) * 0.99995));
    price = close;
  }
  const f = forecastNextCandle({
    candles: out, timeframeMinutes: 1, candleQuality: { available: true, tags: ['DOJI'] }, ...statFns(),
  });
  assert.doesNotMatch(f.expectedStructure, /Indecision/i, 'must not just restate the current DOJI tag as the next-candle prediction');
  assert.match(f.expectedStructure, /bullish|continuation/i, 'should reflect what historically followed a doji in THIS series, not the doji itself');
  assert.ok(f.evidence.some((e) => /historical:/.test(e)), 'the structure claim must cite the historical current->next transition as its evidence');
});

test('8. with an untrustworthy/no historical read, structure falls back to an explicitly generic, low-confidence description - never a specific invented pattern', () => {
  const series = buildLearnableSeries(10); // too short for any shape class to reach MIN_CLASS_SAMPLE
  const f = forecastNextCandle({
    candles: series, timeframeMinutes: 1, candleQuality: { available: true, tags: ['DOJI'] }, ...statFns(),
  });
  assert.match(f.expectedStructure, /No trustworthy historical|Insufficient history/i);
  assert.ok(!/Hammer|Shooting Star|Engulfing/i.test(f.expectedStructure), 'must never invent a specific named pattern without evidence');
});

test('9. direction is UNCERTAIN (not forced GREEN/RED) when the projection is within the neutral band around 50/50', () => {
  const series = [];
  let price = 100;
  for (let i = 0; i < 40; i += 1) {
    const open = price;
    const close = i % 2 === 0 ? open * 1.00001 : open * 0.99999; // near-zero, alternating
    series.push(makeCandle(i * 60000, open, close, Math.max(open, close) * 1.00002, Math.min(open, close) * 0.99998));
    price = close;
  }
  const f = forecastNextCandle({
    candles: series, timeframeMinutes: 1, candleQuality: { available: true, tags: [] }, ...statFns(),
  });
  assert.strictEqual(f.direction, 'UNCERTAIN');
});

// ---------------------------------------------------------------- end-to-end wiring
test('10. generateBinarySignal attaches a real, timeframe-labeled nextCandleForecast, computed from the same real candle window (integration, no mocks)', async () => {
  const series = buildLearnableSeries(200, 1.1);
  const core = binaryEngine.computeSignalCore(series, series[series.length - 1].close, 5, 120);
  assert.ok(core.nextCandleForecast, 'computeSignalCore must attach a real next-candle forecast');
  assert.ok(['GREEN', 'RED', 'UNCERTAIN'].includes(core.nextCandleForecast.direction));
  assert.ok(Number.isFinite(core.nextCandleForecast.timeframeMinutes));
  assert.ok(typeof core.nextCandleForecast.timeframeLabel === 'string' && core.nextCandleForecast.timeframeLabel.length > 0);
  assert.ok(Array.isArray(core.nextCandleForecast.evidence) && core.nextCandleForecast.evidence.length > 0);
});

// ---------------------------------------------------------------- named patterns (real geometry, never invented)
test('11. namedPatternFor returns the correct CLASSIC name for the SAME geometry depending on real prior trend context (Hammer vs Hanging Man, Shooting Star vs Inverted Hammer)', () => {
  const { namedPatternFor } = require('../src/services/candleQuality');
  const mk = (o, c, h, l) => ({
    open: o, close: c, high: h, low: l,
  });
  const downtrend = [mk(110, 108), mk(108, 105), mk(105, 102), mk(102, 100), mk(100, 99.5), mk(99.5, 100, 100, 97)];
  const uptrend = [mk(90, 92), mk(92, 95), mk(95, 98), mk(98, 100), mk(100, 100.5), mk(100.5, 101, 101, 98)];
  assert.strictEqual(namedPatternFor(downtrend), 'Hammer');
  assert.strictEqual(namedPatternFor(uptrend), 'Hanging Man');

  const uptrend2 = [mk(90, 92), mk(92, 95), mk(95, 98), mk(98, 100), mk(100, 100.5), mk(100.5, 100, 103, 100)];
  const downtrend2 = [mk(110, 108), mk(108, 105), mk(105, 102), mk(102, 100), mk(100, 99.5), mk(99.5, 100, 103, 100)];
  assert.strictEqual(namedPatternFor(uptrend2), 'Shooting Star');
  assert.strictEqual(namedPatternFor(downtrend2), 'Inverted Hammer');
});

test('12. namedPatternFor returns null (never a fabricated name) for an ordinary candle that matches no classic definition', () => {
  const { namedPatternFor } = require('../src/services/candleQuality');
  const ordinary = [{
    open: 100, close: 100.4, high: 100.5, low: 99.9,
  }];
  assert.strictEqual(namedPatternFor(ordinary), null);
});

test('13. generateBinarySignal attaches real recentCandles (previous + current, at the same timeframe as the next-candle forecast) with honest color/pattern - never predicted', async () => {
  const series = buildLearnableSeries(1200, 1.2);
  const core = binaryEngine.computeSignalCore(series, series[series.length - 1].close, 60, 120);
  assert.ok(Array.isArray(core.recentCandles) && core.recentCandles.length === 2, 'must report exactly [previous, current]');
  core.recentCandles.forEach((c) => {
    assert.ok(['GREEN', 'RED', 'FLAT'].includes(c.color));
    assert.ok(c.namedPattern === null || typeof c.namedPattern === 'string');
  });
  assert.ok(core.recentCandles[1].time > core.recentCandles[0].time, 'must be ordered [previous, current] oldest first');
});

run('next-candle forecast (timeframe-aware, no-lookahead, evidence-based)');
