const { EMA, RSI, MACD, ATR, Stochastic, BollingerBands, ADX } = require('technicalindicators');

function closes(candles) {
  return candles.map((c) => c.close);
}

function ema(candles, period) {
  const values = EMA.calculate({ period, values: closes(candles) });
  return values.length ? values[values.length - 1] : null;
}

function emaSeries(candles, period) {
  return EMA.calculate({ period, values: closes(candles) });
}

function rsi(candles, period = 14) {
  const values = RSI.calculate({ period, values: closes(candles) });
  return values.length ? values[values.length - 1] : null;
}

function rsiSeries(candles, period = 14) {
  return RSI.calculate({ period, values: closes(candles) });
}

function macd(candles) {
  const values = MACD.calculate({
    values: closes(candles),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
  return values.length ? values[values.length - 1] : null;
}

function macdSeries(candles) {
  return MACD.calculate({
    values: closes(candles),
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    SimpleMAOscillator: false,
    SimpleMASignal: false,
  });
}

function atr(candles, period = 14) {
  const values = ATR.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
  return values.length ? values[values.length - 1] : null;
}

// Full ATR series (not just the last value) - used to judge whether
// CURRENT volatility is high/low relative to its OWN recent history
// (a percentile), rather than an arbitrary fixed threshold.
function atrSeries(candles, period = 14) {
  return ATR.calculate({
    period,
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
  });
}

function stochastic(candles, period = 14, signalPeriod = 3) {
  const values = Stochastic.calculate({
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    close: candles.map((c) => c.close),
    period,
    signalPeriod,
  });
  return values.length ? values[values.length - 1] : null; // { k, d }
}

function bollingerBands(candles, period = 20, stdDev = 2) {
  const values = BollingerBands.calculate({ period, values: closes(candles), stdDev });
  return values.length ? values[values.length - 1] : null; // { middle, upper, lower }
}

function adx(candles, period = 14) {
  const values = ADX.calculate({
    close: candles.map((c) => c.close),
    high: candles.map((c) => c.high),
    low: candles.map((c) => c.low),
    period,
  });
  return values.length ? values[values.length - 1] : null; // { adx, ... }
}

module.exports = { ema, emaSeries, rsi, rsiSeries, macd, macdSeries, atr, atrSeries, stochastic, bollingerBands, adx };
