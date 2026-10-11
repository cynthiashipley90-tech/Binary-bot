// ---- Deterministic market-context summary (no AI) ----
// Extracted from the old services/ai/marketContext.js when the independent
// AI analyst was removed from this project. summarizeMarket() and
// collectLimitations() are pure, deterministic helpers over the RAW candle
// snapshot (services/binaryEngine.js's fetchSignalInputs output) and the
// bot's own result - they were never AI-specific themselves, just
// (also) used to brief the AI stage that no longer exists. Used by
// services/marketWorkflow.js to build the `market`/`limitations` fields of
// a !market result.

const dataQualitySvc = require('./dataQuality');

function iso(ms) {
  return new Date(ms).toISOString();
}

function isoMinute(ms) {
  return `${iso(ms).slice(0, 16)}Z`;
}

function roundPrice(n) {
  return Number.isFinite(n) ? Number(n.toPrecision(8)) : null;
}

function round(n, d = 4) {
  return Number.isFinite(n) ? Number(n.toFixed(d)) : null;
}

function horizonLabel(minutes) {
  if (!Number.isFinite(minutes)) return 'unknown';
  if (minutes < 1) return `${Math.round(minutes * 60)} sec`;
  if (minutes < 60) return `${Number(minutes.toFixed(2))} min`;
  const h = minutes / 60;
  return `${Number(h.toFixed(2))} h (${Number(minutes.toFixed(2))} min)`;
}

function ageMinutes(lastCandle, nowMs) {
  return Math.max(0, Math.round((nowMs - lastCandle.time) / 60000));
}

function pctChangeOver(candles, minutes) {
  const last = candles[candles.length - 1];
  const target = last.time - minutes * 60000;
  if (candles[0].time > target) return null; // window doesn't reach back that far
  let ref = null;
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i].time <= target) { ref = candles[i]; break; }
  }
  if (!ref || !(ref.close > 0)) return null;
  return round(((last.close - ref.close) / ref.close) * 100, 3);
}

function summarizeMarket(inputs, opts = {}) {
  const nowMs = opts.now != null ? opts.now : Date.now();
  const dq = dataQualitySvc.validateCandleSeries(inputs.candles);
  const candles = dq.cleaned;
  const last = candles[candles.length - 1];
  const lastHour = candles.filter((c) => c.time > last.time - 60 * 60000);
  return {
    symbol: inputs.symbol,
    horizonMinutes: inputs.duration,
    horizonLabel: horizonLabel(inputs.duration),
    referencePrice: roundPrice(inputs.entryPrice),
    priceSource: inputs.priceSource === 'live-quote' ? 'live quote' : 'last candle close',
    lastCandleUtc: isoMinute(last.time),
    lastCandleAgeMinutes: ageMinutes(last, nowMs),
    stale: !!(inputs.staleness && inputs.staleness.stale),
    window: { candles: candles.length, fromUtc: isoMinute(candles[0].time), toUtc: isoMinute(last.time) },
    windowHigh: roundPrice(Math.max(...candles.map((c) => c.high))),
    windowLow: roundPrice(Math.min(...candles.map((c) => c.low))),
    lastHourHigh: lastHour.length ? roundPrice(Math.max(...lastHour.map((c) => c.high))) : null,
    lastHourLow: lastHour.length ? roundPrice(Math.min(...lastHour.map((c) => c.low))) : null,
    changePct: { '15m': pctChangeOver(candles, 15), '1h': pctChangeOver(candles, 60), '4h': pctChangeOver(candles, 240) },
    volumeAvailable: candles.some((c) => c.volume != null && c.volume > 0),
    dataQualityIssues: dq.issues || [],
  };
}

// Merged, de-duplicated list of everything that limits how far the report
// can be trusted. Built in code, not left to prose.
function collectLimitations({ inputs, bot, opts = {} }) {
  const out = [];
  const add = (x) => { if (x && !out.includes(x)) out.push(x); };
  const market = inputs ? summarizeMarket(inputs, opts) : null;

  if (market) {
    market.dataQualityIssues.forEach((i) => add(`Data: ${i}`));
    if (market.stale) add(`Market data looks stale (last candle ~${market.lastCandleAgeMinutes} min old) - the market may be closed; treat this as a historical read, not a live one.`);
    if (!market.volumeAvailable) add('No usable volume data for this instrument - volume-based evidence is unavailable.');
    add('Analysis is built from 1-minute candles; the requested horizon is a forward-looking window, not a higher-timeframe chart study.');
  }
  if (!bot || bot.status !== 'OK') add(`Bot analysis unavailable: ${(bot && bot.reason) || 'did not run'}`);
  else {
    if (bot.signal.calibrationLowConfidence) add(`Bot calibration is provisional (only ${bot.signal.calibrationSampleSize} closed trades in this bucket).`);
    if (!bot.expiryPerf) add('Historical performance for this horizon bucket could not be loaded.');
  }
  return out;
}

module.exports = {
  summarizeMarket,
  collectLimitations,
  horizonLabel,
  pctChangeOver,
};
