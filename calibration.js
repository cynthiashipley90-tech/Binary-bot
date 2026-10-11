// ---- WHY THIS FILE EXISTS ----
// The engine's raw probability (binaryEngine.js) is a *model output* - the
// result of a normal-CDF calculation over measured drift/volatility. It is
// NOT automatically the same thing as "how often this model is actually
// right", any more than a weather model's "70% chance of rain" is
// guaranteed to mean it rains exactly 70% of days it says that. Calibration
// is the process of checking, from real closed outcomes, what a given raw
// probability *actually* corresponded to historically, and nudging future
// probabilities of that kind toward the measured truth instead of taking
// the raw math at face value.
//
// Design choice (stated plainly, not hidden): calibration is bucketed by
// (expiry bucket x probability bin) - i.e. it answers "when THIS model
// said 65-70% on A 5-10 MINUTE trade, how often was it actually right?"
// separately from the same question on a 40-90 minute trade. It is NOT
// additionally split by market regime, because splitting by
// (expiry x probability x regime) fragments the sample count into buckets
// too small to trust for a bot that hasn't run millions of trades - a
// regime-specific calibration bucket with n=4 would be worse than no
// calibration at all. Regime performance is instead tracked and REPORTED
// separately (see recordRegimePerf/getRegimePerf below) so you can see if
// a regime is a problem, and regime is used as a hard NO_TRADE gate when
// UNSTABLE - it just isn't used to further slice the calibration curve
// until there's enough volume for that to be statistically meaningful.

const store = require('./redisStore');
const { allBucketKeys, bucketLabel } = require('./expiryBuckets');

const PROB_BINS = [
  { key: '50-55', min: 50, max: 55 },
  { key: '55-60', min: 55, max: 60 },
  { key: '60-65', min: 60, max: 65 },
  { key: '65-70', min: 65, max: 70 },
  { key: '70-75', min: 70, max: 75 },
  { key: '75-80', min: 75, max: 80 },
  { key: '80-85', min: 80, max: 85 },
  { key: '85-90', min: 85, max: 90 },
  { key: '90-95', min: 90, max: 95 },
  { key: '95-100', min: 95, max: 100.01 },
];

function getProbBin(pct) {
  return PROB_BINS.find((b) => pct >= b.min && pct < b.max) || PROB_BINS[PROB_BINS.length - 1];
}

// How much weight the raw (uncalibrated) probability keeps as a "prior" -
// equivalent to that many pseudo-trades worth of belief in the model's own
// math. A bucket with 0 real outcomes yet returns the raw probability
// unchanged (all weight on the prior); as real outcomes accumulate, the
// empirical win rate increasingly dominates.
const PRIOR_WEIGHT = 20;
// Below this many real closed outcomes in a bucket, the calibrated number
// is still computed (so it keeps improving smoothly) but flagged
// low-confidence rather than presented as a settled calibration.
const MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION = 30;

const KEYS = {
  calib: (expiryBucketKey, probBinKey) => `binary:calib:${expiryBucketKey}:${probBinKey}`,
  calibRecent: (expiryBucketKey, probBinKey) => `binary:calib:recent:${expiryBucketKey}:${probBinKey}`,
  expiryPerf: (expiryBucketKey) => `binary:perf:expiry:${expiryBucketKey}`,
  regimePerf: (regimeLabel) => `binary:perf:regime:${regimeLabel}`,
  regimeLabelsSeen: 'binary:perf:regime:labels',
  expiryRegimePerf: (expiryBucketKey, regimeLabel) => `binary:perf:expiryregime:${expiryBucketKey}:${regimeLabel}`,
  // Generic (category, key) performance counters - used for BOTH session
  // performance (category='session') and feature-importance tracking
  // (category='feature', e.g. 'volume_confirmed_breakout',
  // 'divergence_present') so #16 "which features actually help" can be
  // answered from real recorded outcomes, not assumed from theory.
  genericPerf: (category, key) => `binary:perf:${category}:${key}`,
  genericLabelsSeen: (category) => `binary:perf:${category}:labels`,
  // Expected-expiry-price vs actual-expiry-price validation, tracked per
  // expiry bucket alongside (never instead of) the direction-only win-rate
  // above - a bot can be directionally right while its price target is
  // systematically off, and that would never show up in win/loss alone.
  expiryPriceAccuracy: (expiryBucketKey) => `binary:priceacc:expiry:${expiryBucketKey}`,
};

// How many of the most recent outcomes to keep per calibration bucket, for
// a "recent performance" read distinct from the all-time one - a model
// whose long-term calibration looks fine but whose last 20 trades in a
// bucket have gone badly is worth surfacing separately (regime shifts,
// provider data changes, etc. show up here first).
const RECENT_WINDOW_SIZE = 40;

async function readCounter(key) {
  const raw = await store.redis.get(key);
  const val = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { wins: 0, total: 0 };
  return val;
}

async function bumpCounter(key, won) {
  const val = await readCounter(key);
  val.total += 1;
  if (won) val.wins += 1;
  await store.redis.set(key, JSON.stringify(val));
  return val;
}

// ---- Calibration curve ----

async function getCalibrationStats(expiryBucketKey, probBinKey) {
  return readCounter(KEYS.calib(expiryBucketKey, probBinKey));
}

async function recordCalibrationOutcome(expiryBucketKey, rawProbabilityPct, correct) {
  const bin = getProbBin(rawProbabilityPct);
  const result = await bumpCounter(KEYS.calib(expiryBucketKey, bin.key), correct);
  // Maintain the capped recent-outcomes window alongside the all-time
  // counter (see RECENT_WINDOW_SIZE above).
  const recentKey = KEYS.calibRecent(expiryBucketKey, bin.key);
  const raw = await store.redis.get(recentKey);
  const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  list.push(correct ? 1 : 0);
  while (list.length > RECENT_WINDOW_SIZE) list.shift();
  await store.redis.set(recentKey, JSON.stringify(list));
  return result;
}

// Recent-window win rate for a bucket - see RECENT_WINDOW_SIZE. Returns
// null (not 0) when there's no recent data yet, so callers can distinguish
// "no recent trades" from "recent trades, 0% win rate".
async function getRecentCalibrationWinRate(expiryBucketKey, probBinKey) {
  const raw = await store.redis.get(KEYS.calibRecent(expiryBucketKey, probBinKey));
  const list = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : [];
  if (!list.length) return { winRatePct: null, sampleSize: 0 };
  const wins = list.reduce((a, b) => a + b, 0);
  return { winRatePct: Number(((wins / list.length) * 100).toFixed(1)), sampleSize: list.length };
}

// Returns the calibrated probability (0-100) that the predicted direction
// is actually correct, for a given raw probability + expiry bucket, plus
// enough metadata to be honest about how much to trust that number.
async function calibrateProbability(rawProbabilityPct, expiryBucketKey) {
  const bin = getProbBin(rawProbabilityPct);
  const stats = await getCalibrationStats(expiryBucketKey, bin.key);
  const priorProb = rawProbabilityPct / 100;
  const calibratedProb = (stats.wins + priorProb * PRIOR_WEIGHT) / (stats.total + PRIOR_WEIGHT);
  const recent = await getRecentCalibrationWinRate(expiryBucketKey, bin.key);
  return {
    calibratedPct: Number((calibratedProb * 100).toFixed(1)),
    rawPct: Number(rawProbabilityPct.toFixed(1)),
    probBin: bin.key,
    expiryBucket: expiryBucketKey,
    sampleSize: stats.total,
    lowConfidence: stats.total < MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION,
    // Long-term (all-time, shown above) vs recent (last RECENT_WINDOW_SIZE)
    // win rate for this exact bucket - a divergence between the two is
    // worth surfacing (e.g. "long-term 68%, recent 20 trades only 45%").
    recentWinRatePct: recent.winRatePct,
    recentSampleSize: recent.sampleSize,
  };
}

// ---- Performance reporting (expiry-wise and regime-wise, separate from
// the calibration curve above, and separate from the model's own
// probability number - this is the actual historical WIN RATE) ----

async function recordExpiryPerf(expiryBucketKey, correct) {
  return bumpCounter(KEYS.expiryPerf(expiryBucketKey), correct);
}

async function recordRegimePerf(regimeLabel, correct) {
  await store.redis.sadd(KEYS.regimeLabelsSeen, regimeLabel);
  return bumpCounter(KEYS.regimePerf(regimeLabel), correct);
}

async function recordExpiryRegimePerf(expiryBucketKey, regimeLabel, correct) {
  return bumpCounter(KEYS.expiryRegimePerf(expiryBucketKey, regimeLabel), correct);
}

async function getExpiryPerf(expiryBucketKey) {
  const stats = await readCounter(KEYS.expiryPerf(expiryBucketKey));
  return {
    expiryBucket: expiryBucketKey,
    label: bucketLabel(expiryBucketKey),
    wins: stats.wins,
    total: stats.total,
    winRatePct: stats.total ? Number(((stats.wins / stats.total) * 100).toFixed(1)) : null,
  };
}

async function getAllExpiryPerf() {
  return Promise.all(allBucketKeys().map(getExpiryPerf));
}async function getRegimePerf(regimeLabel) {
  const stats = await readCounter(KEYS.regimePerf(regimeLabel));
  return {
    regime: regimeLabel,
    wins: stats.wins,
    total: stats.total,
    winRatePct: stats.total ? Number(((stats.wins / stats.total) * 100).toFixed(1)) : null,
  };
}

async function getAllRegimePerf() {
  const labels = await store.redis.smembers(KEYS.regimeLabelsSeen);
  if (!labels || !labels.length) return [];
  const rows = await Promise.all(labels.map(getRegimePerf));
  return rows.sort((a, b) => b.total - a.total);
}

// ---- Generic category performance (session-of-day, feature-importance) ----
// Same pattern as regime perf above, generalized so new breakdown
// dimensions don't need bespoke Redis key plumbing each time. Used for:
//   category='session' -> ASIAN / LONDON / NEW_YORK / LONDON_NY_OVERLAP / OFF_HOURS
//   category='feature'  -> e.g. 'volume_confirmed_breakout',
//                           'volume_unconfirmed_breakout',
//                           'divergence_present', 'divergence_absent',
//                           'htf_ltf_agree', 'htf_ltf_disagree'
// Recording BOTH the presence and absence side of a feature (e.g. both
// 'divergence_present' and 'divergence_absent') is what makes the later
// comparison in getAllFeaturePerf() answer "did this feature actually help"
// rather than just "how did trades with this feature do in isolation".
async function recordGenericPerf(category, key, correct) {
  await store.redis.sadd(KEYS.genericLabelsSeen(category), key);
  return bumpCounter(KEYS.genericPerf(category, key), correct);
}

async function getGenericPerfOne(category, key) {
  const stats = await readCounter(KEYS.genericPerf(category, key));
  return {
    key,
    wins: stats.wins,
    total: stats.total,
    winRatePct: stats.total ? Number(((stats.wins / stats.total) * 100).toFixed(1)) : null,
  };
}

async function getAllGenericPerf(category) {
  const labels = await store.redis.smembers(KEYS.genericLabelsSeen(category));
  if (!labels || !labels.length) return [];
  const rows = await Promise.all(labels.map((k) => getGenericPerfOne(category, k)));
  return rows.sort((a, b) => b.total - a.total);
}

async function recordSessionPerf(session, correct) {
  return recordGenericPerf('session', session, correct);
}
async function getAllSessionPerf() {
  return getAllGenericPerf('session');
}

async function recordFeatureOutcome(featureKey, correct) {
  return recordGenericPerf('feature', featureKey, correct);
}
async function getAllFeaturePerf() {
  return getAllGenericPerf('feature');
}

// ---- Per-confluence-group empirical tracking (GROUP_WEIGHTS audit) ----
// binaryEngine.js's GROUP_WEIGHTS (TREND/MOMENTUM/PRICE_ACTION/etc) are
// currently fixed, documented PRIORS - see the audit comment above their
// definition. This records, from real settled trades only, whether each
// group's OWN directional tilt (sign of its groupScore, independent of the
// other groups) agreed with the ACTUAL price outcome - reusing the exact
// same real-outcome win/loss counter recordFeatureOutcome already uses for
// individual boolean flags, just keyed by group name. This never changes a
// weight by itself; it only accumulates the real evidence ("did this group
// actually have independent predictive value, on its own, in this bot's
// real history") a future, deliberate weight change could point to.
async function recordGroupDirectionOutcome(groupName, groupAgreedWithOutcome) {
  return recordGenericPerf('group', groupName, groupAgreedWithOutcome);
}
async function getAllGroupPerf() {
  return getAllGenericPerf('group');
}

// ---- Expected-expiry-price vs actual-expiry-price validation ----
// Direction (win/loss) tracking above answers "was UP/DOWN right". It says
// nothing about whether the model's actual *expected expiry price* target
// (binaryEngine.js's expectedExpiryPrice, i.e. the final checkpoint's
// predictedPrice) is anywhere near what price genuinely does at expiry - a
// model can be directionally correct while its price target is
// systematically biased (always overshoots) or simply noisy (high average
// error even when unbiased). Both are tracked, per expiry bucket, from real
// settled trades only - never estimated or assumed.
async function readAccCounter(key) {
  const raw = await store.redis.get(key);
  const val = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { count: 0, sumErrPct: 0, sumAbsErrPct: 0 };
  return val;
}

// errPct is signed: positive means price at expiry finished HIGHER than the
// model expected, negative means LOWER - so the running mean (biasPct) shows
// a genuine systematic over/under-shoot rather than cancelling itself out.
// maePct (mean absolute error) is the separate, always-positive "how far off
// is it typically" number - a model can have biasPct near 0 while maePct is
// still large (unbiased but noisy), which is exactly why both are kept.
async function recordExpiryPriceAccuracy(expiryBucketKey, { entryPrice, predictedPrice, actualPrice }) {
  if (!(entryPrice > 0) || !Number.isFinite(predictedPrice) || !Number.isFinite(actualPrice)) return null;
  const errPct = ((actualPrice - predictedPrice) / entryPrice) * 100;
  const key = KEYS.expiryPriceAccuracy(expiryBucketKey);
  const val = await readAccCounter(key);
  val.count += 1;
  val.sumErrPct += errPct;
  val.sumAbsErrPct += Math.abs(errPct);
  await store.redis.set(key, JSON.stringify(val));
  return val;
}

async function getExpiryPriceAccuracy(expiryBucketKey) {
  const stats = await readAccCounter(KEYS.expiryPriceAccuracy(expiryBucketKey));
  return {
    expiryBucket: expiryBucketKey,
    label: bucketLabel(expiryBucketKey),
    sampleSize: stats.count,
    biasPct: stats.count ? Number((stats.sumErrPct / stats.count).toFixed(4)) : null,
    maePct: stats.count ? Number((stats.sumAbsErrPct / stats.count).toFixed(4)) : null,
    lowConfidence: stats.count < MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION,
  };
}

async function getAllExpiryPriceAccuracy() {
  return Promise.all(allBucketKeys().map(getExpiryPriceAccuracy));
}

module.exports = {
  getProbBin,
  calibrateProbability,
  recordCalibrationOutcome,
  getRecentCalibrationWinRate,
  recordExpiryPerf,
  recordRegimePerf,
  recordExpiryRegimePerf,
  getExpiryPerf,
  getAllExpiryPerf,
  getRegimePerf,
  getAllRegimePerf,
  recordSessionPerf,
  getAllSessionPerf,
  recordFeatureOutcome,
  getAllFeaturePerf,
  recordGroupDirectionOutcome,
  getAllGroupPerf,
  recordExpiryPriceAccuracy,
  getExpiryPriceAccuracy,
  getAllExpiryPriceAccuracy,
  MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION,
  RECENT_WINDOW_SIZE,
};
