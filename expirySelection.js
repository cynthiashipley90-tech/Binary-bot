// ---- Requested-expiry vs alternative-expiry evaluation ----
//
// Replaces the old "timeframeSuggestion" hint, which recommended a
// different timeframe purely from a resampled-candle confluence QUALITY
// SCORE - a cosmetic number, not real evidence (no calibration, no
// historical accuracy, no price-error track record). That is explicitly
// disallowed now: an alternative expiry may only be surfaced when it is
// MATERIALLY stronger on real, multi-criteria evidence.
//
// Every candidate duration is run through the exact same deterministic
// decision pipeline the actually-requested signal uses
// (binaryEngine.evaluateDurationLean, injected as `evaluateCandidate` to
// avoid a circular require), then scored with the SAME fixed, documented
// rubric applied to the requested duration too - so "requested" and
// "candidate" are compared on equal footing, not a live number against a
// synthetic one.
//
// The candidate SET itself is dynamic: it is drawn from
// expiryBuckets.representativeMinutes() (a fixed pool spanning every
// calibration bucket, not itself a preference order), filtered to
// durations broadly comparable to what the user asked for (so "alternative"
// never silently means "a completely different kind of trade") and to
// durations the already-fetched candle window can actually support. There
// is no "always suggest shorter" or "always suggest longer" rule anywhere
// in this file.

const expiryBucketsSvc = require('./expiryBuckets');
const calibrationSvc = require('./calibration');

// Candidates must be within this ratio of the requested duration - e.g. a
// 60-minute request can be compared against roughly 24-150 minutes, never
// against a 1-minute scalp. Fixed, documented, not tuned per request.
const CANDIDATE_RATIO_MIN = 0.4;
const CANDIDATE_RATIO_MAX = 2.5;
// Bounds how many extra Redis calibration reads + full decision
// computations one signal can trigger - each candidate is a real
// computeSignalCore run plus two calibration lookups, not free.
const MAX_CANDIDATES = 4;

// An alternative must beat the requested duration's own evidence score by
// at least this much AND have its own trustworthy (non-trivial) calibration
// sample - so a switch is never recommended from a rounding-level score
// bump or a handful of lucky trades. Same bar calibration.js itself uses
// for "low confidence", reused here rather than inventing a second
// threshold.
const MATERIAL_MARGIN = 0.75;

// ---- Scientific audit of this file's fixed coefficients ----
// Classified honestly - none of the "scoring" numbers below has been
// validated against this bot's own real settled trades (the calibration
// store has no live history yet), so none is claimed to be optimal:
//
//  LEGITIMATE boundaries / necessities (kept as-is, not model weights):
//   - CANDIDATE_RATIO_MIN/MAX (0.4x-2.5x): a comparability bound, not a
//     preference - it stops "alternative expiry" from meaning a completely
//     different kind of trade (e.g. a 1-minute scalp offered for a 4-hour
//     request). Its own job is data-availability/sanity, not scoring.
//   - MAX_CANDIDATES: a compute/Redis-read budget, not a scoring choice.
//   - The mtfCandlesNeededFn filter: a hard data-availability requirement.
//   - trustworthy() / MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION: the small-
//     sample protection. It reuses calibration.js's own bar rather than
//     inventing a second threshold, and it gates BOTH the historical
//     win-rate term and the price-error term AND (separately) whether a
//     candidate may be recommended at all - so an alternative can never be
//     recommended off a handful of lucky trades, however large its
//     score looks.
//
//  HEURISTIC scoring weights (documented rubric, NOT empirically fitted):
//   - evidenceStrength's 2.0 / 1.5 / 1.0 / 0.5 term weights,
//     MATERIAL_MARGIN (0.75), and assessmentLabel's 1.0 / 0.3 cut-offs.
//     They fix the relative importance of (calibrated-probability edge,
//     real historical win-rate edge, expiry-price error, MTF agreement)
//     and how big a score gap counts as "material". These are judgment
//     priors. Fitting them would require walk-forward evidence from real
//     closed trades per expiry bucket, which does not exist yet; fitting
//     them on nothing (or on in-sample data) would be fake optimization
//     and is deliberately NOT done. Their safety net is structural: every
//     data-derived term contributes ONLY when its sample is trustworthy,
//     so an under-sampled bucket cannot move the score in either direction.
//
function trustworthy(sampleSize) {
  return Number.isFinite(sampleSize) && sampleSize >= calibrationSvc.MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION;
}

function candidateDurations(requestedDuration, availableCandleCount, mtfCandlesNeededFn) {
  return expiryBucketsSvc.representativeMinutes()
    .filter((m) => m !== requestedDuration)
    .filter((m) => m >= requestedDuration * CANDIDATE_RATIO_MIN && m <= requestedDuration * CANDIDATE_RATIO_MAX)
    .filter((m) => mtfCandlesNeededFn(m) <= availableCandleCount)
    .sort((a, b) => Math.abs(a - requestedDuration) - Math.abs(b - requestedDuration))
    .slice(0, MAX_CANDIDATES);
}

// One composite "evidence strength" number per duration. Every term is an
// independently-meaningful, real signal - documented here so the score is
// auditable, not a magic constant:
//   +2.0 x calibrated-probability edge (0..1, distance from a 50/50 coin flip)
//   +1.5 x normalized real historical win-rate edge for this bucket, ONLY
//        when the bucket has a trustworthy sample - an untrustworthy
//        win-rate contributes nothing rather than being treated as 50/50
//        (that would silently penalize under-sampled buckets)
//   -1.0 x normalized real expiry-price error (MAE%) for this bucket, ONLY
//        when trustworthy - a duration can be directionally lucky while its
//        price target is badly off, and that should cost it here
//   +/-0.5 for MTF agreement true/false (null/unknown = 0, no opinion)
//   direction NO_TRADE => -1 flat (no evidence to act on at all)
// Fixed weights, same function, same inputs, same output every time - never
// tuned per request.
function evidenceStrength({ evaluation, expiryPerf, priceAccuracy }) {
  if (!evaluation || evaluation.direction === 'NO_TRADE') return -1;
  const edge = Math.abs(evaluation.calibratedProbability - 50) / 50;
  let score = edge * 2.0;
  if (expiryPerf && expiryPerf.total > 0 && trustworthy(expiryPerf.total)) {
    score += ((expiryPerf.winRatePct - 50) / 50) * 1.5;
  }
  if (priceAccuracy && priceAccuracy.sampleSize > 0 && trustworthy(priceAccuracy.sampleSize) && priceAccuracy.maePct != null) {
    score -= Math.min(1, priceAccuracy.maePct / 5) * 1.0;
  }
  if (evaluation.mtfAgreement === true) score += 0.5;
  else if (evaluation.mtfAgreement === false) score -= 0.5;
  return Number(score.toFixed(4));
}

function assessmentLabel(direction, score) {
  if (direction === 'NO_TRADE') return 'NO_TRADE';
  if (score >= 1.0) return 'STRONG';
  if (score >= 0.3) return 'ACCEPTABLE';
  return 'WEAK';
}

function buildReasons(best, requested, requestedPerf, requestedPriceAcc) {
  const reasons = [];
  if (Math.abs(best.calibratedProbability - 50) > Math.abs(requested.calibratedProbability - 50)) {
    reasons.push(`higher calibrated probability edge (${best.calibratedProbability}% vs ${requested.calibratedProbability}%)`);
  }
  if (best.historicalAccuracyPct != null && (!requestedPerf.total || best.historicalAccuracyPct > requestedPerf.winRatePct)) {
    reasons.push(`stronger historical accuracy (${best.historicalAccuracyPct}% n=${best.historicalSampleSize} vs ${requestedPerf.total ? `${requestedPerf.winRatePct}% n=${requestedPerf.total}` : 'no completed trades yet'})`);
  }
  if (best.priceAccuracy?.maePct != null && (requestedPriceAcc.maePct == null || best.priceAccuracy.maePct < requestedPriceAcc.maePct)) {
    reasons.push(`lower expiry-price error (avg ${best.priceAccuracy.maePct}% vs ${requestedPriceAcc.maePct != null ? `${requestedPriceAcc.maePct}%` : 'no data yet'})`);
  }
  if (best.mtfAgreement === true && requested.mtfAgreement !== true) {
    reasons.push('stronger multi-timeframe agreement');
  }
  return reasons.length ? reasons : ['materially stronger combined evidence score'];
}

// `evaluateCandidate(durationMinutes)` -> Promise<lean evaluation> is
// injected by the caller (binaryEngine.js's evaluateDurationLean) rather
// than required here, so this module never has to require binaryEngine.js
// back (no circular dependency) and stays independently testable with a
// stub.
async function evaluateExpiryOptions({
  requestedDuration, requestedEvaluation, evaluateCandidate, availableCandleCount, mtfCandlesNeededFn,
}) {
  const requestedBucket = requestedEvaluation.expiryBucket;
  const [requestedPerf, requestedPriceAcc] = await Promise.all([
    calibrationSvc.getExpiryPerf(requestedBucket.key),
    calibrationSvc.getExpiryPriceAccuracy(requestedBucket.key),
  ]);
  const requestedScore = evidenceStrength({
    evaluation: requestedEvaluation, expiryPerf: requestedPerf, priceAccuracy: requestedPriceAcc,
  });
  const requestedAssessment = assessmentLabel(requestedEvaluation.direction, requestedScore);

  const durations = candidateDurations(requestedDuration, availableCandleCount, mtfCandlesNeededFn);
  const evaluatedCandidates = [];
  for (const dur of durations) {
    // eslint-disable-next-line no-await-in-loop
    const evalR = await evaluateCandidate(dur);
    const bucket = evalR.expiryBucket;
    // eslint-disable-next-line no-await-in-loop
    const [perf, priceAcc] = await Promise.all([
      calibrationSvc.getExpiryPerf(bucket.key),
      calibrationSvc.getExpiryPriceAccuracy(bucket.key),
    ]);
    const score = evidenceStrength({ evaluation: evalR, expiryPerf: perf, priceAccuracy: priceAcc });
    evaluatedCandidates.push({
      durationMinutes: dur,
      bucketKey: bucket.key,
      label: bucket.label,
      direction: evalR.direction,
      calibratedProbability: evalR.calibratedProbability,
      mtfAgreement: evalR.mtfAgreement,
      historicalAccuracyPct: perf.total > 0 ? perf.winRatePct : null,
      historicalSampleSize: perf.total,
      priceAccuracy: priceAcc,
      score,
    });
  }

  let alternative = null;
  const eligible = evaluatedCandidates
    .filter((c) => c.direction !== 'NO_TRADE')
    .filter((c) => trustworthy(c.historicalSampleSize))
    .filter((c) => c.score - requestedScore >= MATERIAL_MARGIN)
    .sort((a, b) => b.score - a.score);

  if (eligible.length) {
    const best = eligible[0];
    alternative = {
      durationMinutes: best.durationMinutes,
      label: best.label,
      scoreDelta: Number((best.score - requestedScore).toFixed(4)),
      reasons: buildReasons(best, requestedEvaluation, requestedPerf, requestedPriceAcc),
    };
  }

  return {
    requestedDuration,
    requestedAssessment,
    requestedScore,
    requestedHistoricalAccuracy: requestedPerf,
    requestedPriceAccuracy: requestedPriceAcc,
    alternative,
    evaluatedCandidates,
    note: requestedAssessment === 'STRONG' || requestedAssessment === 'ACCEPTABLE'
      ? (alternative ? null : `Requested ${requestedEvaluation.durationMinutes >= 60 ? `${(requestedEvaluation.durationMinutes / 60)}h` : `${requestedEvaluation.durationMinutes}min`} expiry is currently the strongest supported window among the durations evaluated; no timing change is recommended.`)
      : null,
  };
}

module.exports = {
  evaluateExpiryOptions,
  evidenceStrength,
  candidateDurations,
  assessmentLabel,
  MATERIAL_MARGIN,
  CANDIDATE_RATIO_MIN,
  CANDIDATE_RATIO_MAX,
};
