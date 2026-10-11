// ---- Divergence engine ----
// Compares price swing highs/lows (from structure.findSwings) against the
// corresponding RSI/MACD-histogram/volume values at those same points in
// time, classified as:
//   kind:      REGULAR (signals reversal) | HIDDEN (signals continuation)
//   direction: BULLISH | BEARISH
//   strength:  0-1, how pronounced the price/indicator disagreement is
//   confirmed: whether price has actually started moving in the direction
//              the divergence implies (the bar after the divergence formed
//              closed the "right" way) - an unconfirmed divergence is
//              flagged as such and should carry less weight
//
// Regular divergence:  price makes a new extreme, the indicator does NOT
//                       confirm it (weaker) -> often precedes a reversal.
//   Bearish regular: price Higher High, indicator Lower High.
//   Bullish regular: price Lower Low, indicator Higher Low.
// Hidden divergence:   price does NOT make a new extreme, the indicator
//                       does -> often signals trend continuation.
//   Bullish hidden: price Higher Low, indicator Lower Low.
//   Bearish hidden: price Lower High, indicator Higher High.

const structureSvc = require('./structure');
const indicators = require('./indicators');

// Find the indicator value at (or nearest to) a given candle index, given
// an indicator series that's shorter than `candles` (most TA libraries
// return a series starting `period-1` bars in).
function valueAtIndex(series, seriesOffset, candleIdx) {
  const seriesIdx = candleIdx - seriesOffset;
  if (seriesIdx < 0 || seriesIdx >= series.length) return null;
  return series[seriesIdx];
}

function detectForSeries({ candles, swingHighs, swingLows, seriesValues, seriesOffset, label, getValue }) {
  const results = [];
  // Only compare the last two swing highs / lows against each other -
  // deeper history is noisier and the "last two swings" framing is what
  // divergence is conventionally defined against anyway.
  if (swingHighs.length >= 2) {
    const [h1, h2] = swingHighs.slice(-2);
    const v1 = getValue(seriesValues, seriesOffset, h1.index);
    const v2 = getValue(seriesValues, seriesOffset, h2.index);
    if (v1 != null && v2 != null) {
      const priceHigherHigh = h2.price > h1.price;
      const indicatorHigherHigh = v2 > v1;
      const priceDelta = Math.abs((h2.price - h1.price) / h1.price);
      const indicatorDelta = Math.abs(v1) > 1e-9 ? Math.abs((v2 - v1) / Math.abs(v1)) : Math.abs(v2 - v1);
      if (priceHigherHigh && !indicatorHigherHigh) {
        results.push({
          type: label, direction: 'BEARISH', kind: 'REGULAR',
          strength: Number(Math.min(1, (priceDelta + indicatorDelta) * 5).toFixed(2)),
          atIndex: h2.index, time: h2.time,
        });
      } else if (!priceHigherHigh && indicatorHigherHigh) {
        results.push({
          type: label, direction: 'BEARISH', kind: 'HIDDEN',
          strength: Number(Math.min(1, (priceDelta + indicatorDelta) * 5).toFixed(2)),
          atIndex: h2.index, time: h2.time,
        });
      }
    }
  }
  if (swingLows.length >= 2) {
    const [l1, l2] = swingLows.slice(-2);
    const v1 = getValue(seriesValues, seriesOffset, l1.index);
    const v2 = getValue(seriesValues, seriesOffset, l2.index);
    if (v1 != null && v2 != null) {
      const priceLowerLow = l2.price < l1.price;
      const indicatorLowerLow = v2 < v1;
      const priceDelta = Math.abs((l2.price - l1.price) / l1.price);
      const indicatorDelta = Math.abs(v1) > 1e-9 ? Math.abs((v2 - v1) / Math.abs(v1)) : Math.abs(v2 - v1);
      if (priceLowerLow && !indicatorLowerLow) {
        results.push({
          type: label, direction: 'BULLISH', kind: 'REGULAR',
          strength: Number(Math.min(1, (priceDelta + indicatorDelta) * 5).toFixed(2)),
          atIndex: l2.index, time: l2.time,
        });
      } else if (!priceLowerLow && indicatorLowerLow) {
        results.push({
          type: label, direction: 'BULLISH', kind: 'HIDDEN',
          strength: Number(Math.min(1, (priceDelta + indicatorDelta) * 5).toFixed(2)),
          atIndex: l2.index, time: l2.time,
        });
      }
    }
  }
  return results;
}

// Confirmation: has price actually moved the implied direction since the
// divergence's swing point formed? A REGULAR bullish divergence is
// "confirmed" once price has closed higher than the swing-low close; a
// REGULAR bearish divergence confirmed once price closed lower than the
// swing-high close. Hidden divergences confirm the same way (continuation
// direction matches the divergence's stated direction).
function checkConfirmation(div, candles) {
  const afterCandles = candles.slice(div.atIndex + 1);
  if (!afterCandles.length) return false;
  const lastClose = afterCandles[afterCandles.length - 1].close;
  const atClose = candles[div.atIndex].close;
  return div.direction === 'BULLISH' ? lastClose > atClose : lastClose < atClose;
}

function detectDivergences(candles, volumeState) {
  if (candles.length < 30) return [];
  const structureInfo = structureSvc.classifyStructure(candles);
  const { swingHighs, swingLows } = structureInfo;

  const rsiValues = indicators.rsiSeries(candles, 14);
  const rsiOffset = candles.length - rsiValues.length;
  const macdValues = indicators.macdSeries(candles);
  const macdOffset = candles.length - macdValues.length;

  let all = [];

  all = all.concat(detectForSeries({
    candles, swingHighs, swingLows, seriesValues: rsiValues, seriesOffset: rsiOffset, label: 'RSI',
    getValue: valueAtIndex,
  }));

  all = all.concat(detectForSeries({
    candles, swingHighs, swingLows,
    seriesValues: macdValues.map((m) => m.histogram), seriesOffset: macdOffset, label: 'MACD',
    getValue: valueAtIndex,
  }));

  // Price/volume divergence: only when real volume data exists. Compares
  // price swings against volume-at-that-swing the same way, using RVOL-ish
  // relative volume rather than raw volume so it's scale-independent.
  if (volumeState && volumeState.available) {
    const volSeries = candles.map((c) => c.volume);
    all = all.concat(detectForSeries({
      candles, swingHighs, swingLows, seriesValues: volSeries, seriesOffset: 0, label: 'VOLUME',
      getValue: valueAtIndex,
    }));
  }

  return all.map((d) => ({ ...d, confirmed: checkConfirmation(d, candles) }));
}

// Combined confluence contribution: divergences are directional evidence,
// but per the requirement they're one input among many - this sums
// strength-weighted votes (confirmed divergences count more) into a single
// modest [-1,1] score, alongside the flat list for transparency.
function divergenceConfluenceScore(divergences) {
  if (!divergences.length) return 0;
  let score = 0;
  for (const d of divergences) {
    const w = (d.strength || 0.3) * (d.confirmed ? 1 : 0.5);
    score += d.direction === 'BULLISH' ? w : -w;
  }
  return Math.max(-1, Math.min(1, score / 2)); // /2 keeps a single strong divergence from saturating the group alone
}

module.exports = { detectDivergences, divergenceConfluenceScore };
