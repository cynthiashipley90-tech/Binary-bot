// Deterministic helpers for the crypto/futures suites (no randomness beyond
// the seeded generator already used by fixtures.js).
const { makeCandles } = require('./fixtures');

// Re-time a 1-minute synthetic series onto a different candle spacing.
function makeTf({ stepMs, count, seed = 7, drift = 0, vol = 0.0004, start = 60000, endTime = Date.now() - 2 * stepMs, withVolume = false }) {
  const base = makeCandles({ count, seed, drift, vol, start, endTime, withVolume });
  const t0 = endTime - (count - 1) * stepMs;
  return base.map((c, i) => ({ ...c, time: t0 + i * stepMs, closeTime: t0 + (i + 1) * stepMs - 1 }));
}

// Find (deterministically) a synthetic series that produces the wanted
// outcome from computeSpotSignalCore. Throws if none found so a regression
// in the engine can never silently turn a test into a no-op.
function findCase(computeFn, predicate, { drifts = [0.00005, -0.00005, 0.0001, -0.0001], seeds = 80, vol = 0.0004, start = 60000, count = 400 } = {}) {
  for (const drift of drifts) {
    for (let seed = 1; seed <= seeds; seed++) {
      const candles = makeCandles({ count, seed, drift, vol, start });
      const entry = candles[candles.length - 1].close;
      const sig = computeFn(candles, entry);
      if (predicate(sig)) return { candles, entry, sig, seed, drift };
    }
  }
  throw new Error('findCase: no synthetic series matched the predicate');
}

function mkBar(time, high, low, open, close) {
  return { time, open: open ?? (high + low) / 2, close: close ?? (high + low) / 2, high, low, volume: null };
}

module.exports = { makeTf, findCase, mkBar, makeCandles };
