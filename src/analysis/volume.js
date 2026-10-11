// ---- Volume analysis ----
//
// AVAILABILITY HONESTY NOTE: Twelve Data reports real volume for crypto and
// many equities, but forex/FX pairs have no centralized exchange, so there
// is no real "volume" for them - the field is typically absent. This
// module NEVER invents a number when volume is missing: computeVolumeState()
// checks how much of the recent series actually has a genuine (non-null)
// volume reading (see twelvedata.js for how null vs. a real 0 is decided)
// and returns `available: false` with everything else `null` if too little
// of the series has real data to compute anything meaningful from. Callers
// (binaryEngine's confluence groups, the NO_TRADE gate) must check
// `available` before using any other field here - and must not penalize a
// setup just because volume happens to be unavailable for that instrument.

const MIN_COVERAGE_FOR_AVAILABLE = 0.8; // >=80% of the lookback needs a real reading

function hasUsableVolume(candles) {
  if (!candles.length) return false;
  const withVolume = candles.filter((c) => Number.isFinite(c.volume) && c.volume >= 0).length;
  return withVolume / candles.length >= MIN_COVERAGE_FOR_AVAILABLE;
}

function mean(arr) {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// Relative volume: current bar's volume vs. the average of the prior N bars
// (current bar excluded from its own baseline, standard RVOL definition).
function computeRVOL(candles, period = 20) {
  if (candles.length < period + 1) return null;
  const current = candles[candles.length - 1].volume;
  const baseline = candles.slice(-period - 1, -1).map((c) => c.volume);
  if (!Number.isFinite(current) || baseline.some((v) => !Number.isFinite(v))) return null;
  const avg = mean(baseline);
  if (avg <= 0) return null;
  return current / avg;
}

// Trend of volume itself over the recent window - is participation growing
// or shrinking, independent of price direction.
function computeVolumeTrend(candles, period = 10) {
  if (candles.length < period * 2) return { trend: 'UNKNOWN', changePct: null };
  const recentAvg = mean(candles.slice(-period).map((c) => c.volume));
  const priorAvg = mean(candles.slice(-period * 2, -period).map((c) => c.volume));
  if (!Number.isFinite(recentAvg) || !Number.isFinite(priorAvg) || priorAvg <= 0) {
    return { trend: 'UNKNOWN', changePct: null };
  }
  const changePct = ((recentAvg - priorAvg) / priorAvg) * 100;
  const trend = changePct > 15 ? 'INCREASING' : changePct < -15 ? 'DECREASING' : 'FLAT';
  return { trend, changePct: Number(changePct.toFixed(1)) };
}

// Price-volume relationship over the last `period` bars: does volume
// confirm the price move, or contradict/undercut it?
//   PRICE_UP_VOLUME_UP     -> confirming (healthy advance)
//   PRICE_DOWN_VOLUME_UP   -> confirming (healthy decline / real selling)
//   PRICE_MOVE_WEAK_VOLUME -> move happened on below-average participation,
//                             i.e. less trustworthy than it looks
//   PRICE_FLAT_VOLUME_UP   -> volume without a resolved price move yet
//                             (absorption / potential move brewing)
function priceVolumeRelationship(candles, period = 10) {
  if (candles.length < period + 1) return { relationship: 'UNKNOWN', priceChangePct: null, volumeChangePct: null };
  const slice = candles.slice(-period);
  const priceChangePct = ((slice[slice.length - 1].close - slice[0].open) / slice[0].open) * 100;
  const { trend: volTrend, changePct: volumeChangePct } = computeVolumeTrend(candles, period);

  const priceMoved = Math.abs(priceChangePct) > 0.05; // arbitrary-but-small floor to call it "a move" at all
  let relationship;
  if (!priceMoved && volTrend === 'INCREASING') relationship = 'PRICE_FLAT_VOLUME_UP';
  else if (priceMoved && volTrend === 'INCREASING') relationship = priceChangePct > 0 ? 'PRICE_UP_VOLUME_UP' : 'PRICE_DOWN_VOLUME_UP';
  else if (priceMoved && (volTrend === 'DECREASING' || volTrend === 'FLAT')) relationship = 'PRICE_MOVE_WEAK_VOLUME';
  else relationship = 'UNCLEAR';

  return { relationship, priceChangePct: Number(priceChangePct.toFixed(3)), volumeChangePct };
}

// A single-bar volume spike: current bar's RVOL far above normal.
function detectVolumeSpike(candles, period = 20, spikeThreshold = 2.0) {
  const rvol = computeRVOL(candles, period);
  if (rvol == null) return { spike: false, rvol: null };
  return { spike: rvol >= spikeThreshold, rvol: Number(rvol.toFixed(2)) };
}

// Did the given index range (e.g. a breakout candle + a couple of
// follow-through bars) show above-average volume? Used by
// structure.analyzeBreakoutQuality() to decide breakout confirmation -
// kept here rather than duplicated there, single source of truth for what
// "volume confirmed" means.
function rangeVolumeConfirmed(candles, startIdx, endIdx, period = 20, confirmMultiple = 1.3) {
  const baselineSlice = candles.slice(Math.max(0, startIdx - period), startIdx);
  const baseline = baselineSlice.map((c) => c.volume).filter(Number.isFinite);
  if (baseline.length < Math.min(10, period * 0.5)) return null; // not enough baseline to judge
  const avgBaseline = mean(baseline);
  if (avgBaseline <= 0) return null;
  const rangeSlice = candles.slice(startIdx, endIdx + 1);
  const rangeVols = rangeSlice.map((c) => c.volume).filter(Number.isFinite);
  if (!rangeVols.length) return null;
  const avgRange = mean(rangeVols);
  return avgRange / avgBaseline >= confirmMultiple;
}

// Top-level snapshot used by binaryEngine's confluence + the reply/UI.
function computeVolumeState(candles, period = 20) {
  const recentWindow = candles.slice(-Math.max(period * 2, 40));
  if (!hasUsableVolume(recentWindow)) {
    return {
      available: false,
      reason: 'Provider did not return usable volume data for this instrument/window (expected for most forex pairs - no centralized volume exists for them).',
    };
  }

  const currentVolume = candles[candles.length - 1].volume;
  const avgVolume = mean(candles.slice(-period - 1, -1).map((c) => c.volume).filter(Number.isFinite));
  const rvolInfo = detectVolumeSpike(candles, period);
  const trendInfo = computeVolumeTrend(candles);
  const pvInfo = priceVolumeRelationship(candles);

  // A simple, transparent [-1,1] contribution for the confluence engine:
  // volume itself is directionless, so its "score" is not "bullish/
  // bearish" the way an oscillator's is - it's a CONFIRMATION multiplier
  // concept expressed as a same-signed nudge in whatever direction price
  // already moved, scaled down when volume looks weak/contradictory. This
  // is intentionally modest (never the primary driver) per the requirement
  // that volume must never become a standalone signal.
  let confluenceScore = 0;
  if (pvInfo.relationship === 'PRICE_UP_VOLUME_UP') confluenceScore = Math.min(1, (pvInfo.priceChangePct || 0) / 0.3);
  else if (pvInfo.relationship === 'PRICE_DOWN_VOLUME_UP') confluenceScore = Math.max(-1, (pvInfo.priceChangePct || 0) / 0.3);
  else if (pvInfo.relationship === 'PRICE_MOVE_WEAK_VOLUME') {
    // The move happened without real participation - this is a caution
    // flag, expressed as a small nudge AGAINST the direction that just
    // printed (weak-volume moves are the ones most likely to fail/revert).
    confluenceScore = pvInfo.priceChangePct > 0 ? -0.2 : pvInfo.priceChangePct < 0 ? 0.2 : 0;
  }
  confluenceScore = Math.max(-1, Math.min(1, confluenceScore));

  return {
    available: true,
    currentVolume,
    avgVolume: Number.isFinite(avgVolume) ? Number(avgVolume.toFixed(2)) : null,
    rvol: rvolInfo.rvol,
    spike: rvolInfo.spike,
    trend: trendInfo.trend,
    volumeChangePct: trendInfo.changePct,
    priceVolumeRelationship: pvInfo.relationship,
    priceChangePct: pvInfo.priceChangePct,
    confluenceScore: Number(confluenceScore.toFixed(2)),
  };
}

module.exports = {
  hasUsableVolume,
  computeRVOL,
  computeVolumeTrend,
  priceVolumeRelationship,
  detectVolumeSpike,
  rangeVolumeConfirmed,
  computeVolumeState,
  MIN_COVERAGE_FOR_AVAILABLE,
};
