// ---- Synthetic market data for tests ----
// Deterministic (seeded) random-walk 1-minute candles. No network, no clock
// dependence beyond the `endTime` argument, so tests are reproducible.

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Returns `count` chronological (oldest -> newest) 1-minute candles ending
// at `endTime` (ms). `drift` is the per-candle % drift; `withVolume` adds a
// positive volume figure (crypto-style) instead of null (forex-style).
function makeCandles({ count = 200, start = 1.08, drift = 0.0, vol = 0.0002, seed = 7, endTime = Date.now(), withVolume = false } = {}) {
  const rand = mulberry32(seed);
  const candles = [];
  let price = start;
  const t0 = endTime - (count - 1) * 60000;
  for (let i = 0; i < count; i++) {
    const open = price;
    const move = (rand() - 0.5) * 2 * vol * open + drift * open;
    const close = open + move;
    const high = Math.max(open, close) + rand() * vol * open * 0.5;
    const low = Math.min(open, close) - rand() * vol * open * 0.5;
    candles.push({
      time: t0 + i * 60000,
      open: Number(open.toFixed(6)),
      high: Number(high.toFixed(6)),
      low: Number(low.toFixed(6)),
      close: Number(close.toFixed(6)),
      volume: withVolume ? Math.round(1000 + rand() * 500) : null,
    });
    price = close;
  }
  return candles;
}

// A snapshot shaped exactly like binaryEngine.fetchSignalInputs() returns
// (raw candles + quote + bookkeeping, no analysis). Fresh by default (last
// candle one minute old); pass `endTime` to make it stale.
function makeInputs({ symbol = 'EURUSD', duration = 240, count = 825, endTime = Date.now() - 60000, priceSource = 'live-quote', ...candleOpts } = {}) {
  const dataQualitySvc = require('../../src/services/dataQuality');
  const candles = makeCandles({ count, endTime, ...candleOpts });
  const fetchedAt = Date.now();
  return {
    symbol,
    duration,
    statsLookback: 360,
    fetchSize: candles.length,
    candles,
    entryPrice: candles[candles.length - 1].close,
    priceSource,
    staleness: dataQualitySvc.checkStaleness(candles, fetchedAt, 60000, 5),
    fetchedAt,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { makeCandles, makeInputs, deferred, sleep, mulberry32 };
