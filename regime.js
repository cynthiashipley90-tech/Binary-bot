// Market-regime detection, computed fresh from the same candles already
// fetched for the signal - zero extra API calls.
//
// Two independent axes, combined into one label:
//   primary:    TRENDING | RANGING | BREAKOUT | REVERSAL | UNSTABLE
//   volatility: LOW | NORMAL | HIGH
//
// "primary" and "volatility" are genuinely different questions (a market
// can trend calmly or trend violently), so they're detected separately and
// then joined into a label like "TRENDING_HIGH_VOL" for calibration/
// reporting buckets. UNSTABLE overrides everything else on the primary
// axis - it means "don't trust this reading", not "market is ranging".

const indicators = require('./indicators');
const structureSvc = require('./structure');

function volatilityAxis(candles) {
  const series = indicators.atrSeries(candles, 14).filter(Number.isFinite);
  if (series.length < 20) return { level: 'UNKNOWN', percentile: null };
  const atrNow = series[series.length - 1];
  const sorted = [...series].sort((a, b) => a - b);
  const rank = sorted.findIndex((v) => v >= atrNow);
  const percentile = Math.round((rank / sorted.length) * 100);
  const level = percentile <= 25 ? 'LOW' : percentile >= 75 ? 'HIGH' : 'NORMAL';
  return { level, percentile, series };
}

// A market is "unstable" when recent data itself is untrustworthy -
// extreme ATR spike (near-100th percentile AND meaningfully larger than
// the rest of the recent distribution, not just barely above it) or gaps
// in the candle timeline (missing minutes = the drift/vol stats below are
// being computed over a broken series). This is a data-quality flag, not
// a trading opinion.
function detectUnstable(candles, volAxis) {
  const reasons = [];
  if (volAxis.level === 'HIGH' && volAxis.percentile >= 97 && volAxis.series.length >= 20) {
    const recent = volAxis.series.slice(-20);
    const median = [...recent].sort((a, b) => a - b)[Math.floor(recent.length / 2)];
    const atrNow = volAxis.series[volAxis.series.length - 1];
    if (median > 0 && atrNow / median > 3) reasons.push('volatility spike (ATR >3x its recent median)');
  }
  let gapCount = 0;
  for (let i = 1; i < candles.length; i++) {
    const dt = candles[i].time - candles[i - 1].time;
    if (dt > 3 * 60 * 1000) gapCount += 1; // more than 3 missed minutes back-to-back
  }
  if (gapCount >= 3) reasons.push(`${gapCount} gaps in recent candle history`);
  return { unstable: reasons.length > 0, reasons };
}

// Reversal: the most recent swing leg breaks against the prior structure -
// e.g. series was making HH/HL (uptrend) and the latest swing just printed
// a lower high or lower low, or momentum (MACD histogram) has flipped sign
// opposite to where price structure still says the trend is. Kept as a
// distinct event flag from RANGING/TRENDING since a reversal can occur
// right at the boundary of either.
function detectReversal(candles, structureInfo) {
  const { swingHighs, swingLows } = structureInfo;
  if (swingHighs.length < 3 || swingLows.length < 3) return { reversal: false };

  const priorHH = swingHighs[swingHighs.length - 2].price > swingHighs[swingHighs.length - 3].price;
  const priorHL = swingLows[swingLows.length - 2].price > swingLows[swingLows.length - 3].price;
  const priorLH = swingHighs[swingHighs.length - 2].price < swingHighs[swingHighs.length - 3].price;
  const priorLL = swingLows[swingLows.length - 2].price < swingLows[swingLows.length - 3].price;
  const wasUptrend = priorHH && priorHL;
  const wasDowntrend = priorLH && priorLL;

  const lastHigh = swingHighs[swingHighs.length - 1];
  const lastLow = swingLows[swingLows.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const prevLow = swingLows[swingLows.length - 2];

  const brokeDownFromUptrend = wasUptrend && (lastHigh.price < prevHigh.price || lastLow.price < prevLow.price);
  const brokeUpFromDowntrend = wasDowntrend && (lastHigh.price > prevHigh.price || lastLow.price > prevLow.price);

  if (brokeDownFromUptrend) return { reversal: true, direction: 'BEARISH_REVERSAL' };
  if (brokeUpFromDowntrend) return { reversal: true, direction: 'BULLISH_REVERSAL' };
  return { reversal: false };
}

function classifyRegime(candles, structureInfo, breakoutInfo, volumeState) {
  const volAxis = volatilityAxis(candles);
  const unstable = detectUnstable(candles, volAxis);
  const adxVal = indicators.adx(candles, 14);
  const adx = adxVal && Number.isFinite(adxVal.adx) ? adxVal.adx : null;
  const reversalInfo = detectReversal(candles, structureInfo);

  let primary;
  const reasons = [];

  if (unstable.unstable) {
    primary = 'UNSTABLE';
    reasons.push(...unstable.reasons);
  } else if (reversalInfo.reversal) {
    primary = 'REVERSAL';
    reasons.push(`structure flipped: ${reversalInfo.direction}`);
  } else if (breakoutInfo && breakoutInfo.type !== 'NONE' && !breakoutInfo.retested) {
    // A break that hasn't been retested yet is the most "breakout-y"
    // moment - once retested it behaves more like a continuation of the
    // new trend, so it's left to fall through to TRENDING below.
    primary = 'BREAKOUT';
    reasons.push(`unretested ${breakoutInfo.type.replace(/_/g, ' ').toLowerCase()}`);
  } else if (adx != null && adx >= 22 && (structureInfo.pattern === 'HH_HL' || structureInfo.pattern === 'LH_LL')) {
    primary = 'TRENDING';
    reasons.push(`ADX ${adx.toFixed(1)}, structure ${structureInfo.pattern}`);
  } else if (adx != null && adx < 18) {
    primary = 'RANGING';
    reasons.push(`ADX ${adx.toFixed(1)} (weak/no trend)`);
  } else {
    // In between - not a clean trend, not clearly range-bound either.
    primary = 'RANGING';
    reasons.push('mixed/transitional structure');
  }

  const label = `${primary}${volAxis.level && volAxis.level !== 'UNKNOWN' ? `_${volAxis.level}_VOL` : ''}`;
  // Reliable for trading purposes: UNSTABLE regimes are the one case that
  // should actively push toward NO TRADE regardless of what the
  // probability math says, since the inputs to that math can't be trusted.
  const reliable = primary !== 'UNSTABLE';

  // Volume state is folded in as descriptive context only (never flips
  // primary/reliable by itself - volume is frequently unavailable, e.g.
  // for forex, and a regime classifier that depended on it would silently
  // behave differently per-instrument in a way that's hard to reason
  // about). When available, a TRENDING regime moving on weak/contradicting
  // volume is noted as a caveat in `reasons` for transparency.
  let volumeNote = null;
  if (volumeState && volumeState.available) {
    if (primary === 'TRENDING' && volumeState.priceVolumeRelationship === 'PRICE_MOVE_WEAK_VOLUME') {
      volumeNote = 'trend is moving on below-average volume - weaker than the price action alone suggests';
      reasons.push(volumeNote);
    } else if (primary === 'BREAKOUT' && volumeState.priceVolumeRelationship !== 'PRICE_UP_VOLUME_UP' && volumeState.priceVolumeRelationship !== 'PRICE_DOWN_VOLUME_UP') {
      volumeNote = 'breakout lacks clear volume confirmation';
      reasons.push(volumeNote);
    }
  }

  return {
    primary,
    volatility: volAxis.level,
    volatilityPercentile: volAxis.percentile,
    label,
    reliable,
    reasons,
    volumeNote,
  };
}

module.exports = { classifyRegime };
