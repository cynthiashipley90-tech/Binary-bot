require('./helpers/stubDeps');
const assert = require('assert');
const { test, run } = require('./testKit');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const store = require('../src/services/redisStore');
const calibrationSvc = require('../src/services/calibration');
const expiryBucketsSvc = require('../src/services/expiryBuckets');
const {
  evaluateExpiryOptions, evidenceStrength, candidateDurations, assessmentLabel, MATERIAL_MARGIN,
} = require('../src/services/expirySelection');

store.redis = makeFakeRedis();

function evalFor(durationMinutes, overrides = {}) {
  return {
    durationMinutes,
    expiryBucket: expiryBucketsSvc.getExpiryBucket(durationMinutes),
    direction: 'UP',
    calibratedProbability: 60,
    calibrationSampleSize: 0,
    mtfAgreement: null,
    expectedExpiryPrice: 1.1,
    expectedMoveAmount: 0.001,
    expectedMovePct: 0.09,
    ...overrides,
  };
}

// ---------------------------------------------------------------- pool/filtering
test('1. candidateDurations only returns durations within the 0.4x-2.5x ratio band and within data availability', () => {
  const mtfNeed = (d) => d * 2; // pretend each minute of duration needs 2 candles of MTF context
  const cands = candidateDurations(60, /* availableCandleCount */ 500, mtfNeed);
  cands.forEach((d) => {
    assert.ok(d >= 24 && d <= 150, `${d} should be within 0.4x-2.5x of 60`);
    assert.ok(mtfNeed(d) <= 500);
  });
  assert.ok(!cands.includes(60), 'requested duration itself is never its own candidate');
});

test('2. candidateDurations excludes anything the fetched data cannot actually support', () => {
  const mtfNeed = (d) => d * 1000; // impossible requirement
  const cands = candidateDurations(60, 500, mtfNeed);
  assert.deepStrictEqual(cands, [], 'nothing should be offered as a candidate without enough data to evaluate it honestly');
});

// ---------------------------------------------------------------- scoring
test('3. evidenceStrength is a flat -1 for NO_TRADE regardless of other inputs', () => {
  const s = evidenceStrength({ evaluation: evalFor(30, { direction: 'NO_TRADE', calibratedProbability: 90 }), expiryPerf: { total: 500, winRatePct: 90 }, priceAccuracy: { sampleSize: 500, maePct: 0.01 } });
  assert.strictEqual(s, -1);
});

test('4. an untrustworthy (too-small-sample) historical win rate contributes NOTHING to the score, positive or negative', () => {
  const base = evalFor(30, { calibratedProbability: 55 });
  const withoutSample = evidenceStrength({ evaluation: base, expiryPerf: { total: 0, winRatePct: null }, priceAccuracy: { sampleSize: 0, maePct: null } });
  const withTinySample = evidenceStrength({ evaluation: base, expiryPerf: { total: 2, winRatePct: 100 }, priceAccuracy: { sampleSize: 0, maePct: null } });
  assert.strictEqual(withoutSample, withTinySample, 'a 2-trade 100% win rate must not move the score - not trustworthy yet');
});

test('5. a real, trustworthy historical edge and low price error both increase the score; a large price error decreases it', () => {
  const base = evalFor(30, { calibratedProbability: 55 });
  const min = calibrationSvc.MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION;
  const goodHistory = evidenceStrength({ evaluation: base, expiryPerf: { total: min, winRatePct: 70 }, priceAccuracy: { sampleSize: 0, maePct: null } });
  const badHistory = evidenceStrength({ evaluation: base, expiryPerf: { total: min, winRatePct: 30 }, priceAccuracy: { sampleSize: 0, maePct: null } });
  assert.ok(goodHistory > badHistory);

  const lowError = evidenceStrength({ evaluation: base, expiryPerf: { total: 0, winRatePct: null }, priceAccuracy: { sampleSize: min, maePct: 0.1 } });
  const highError = evidenceStrength({ evaluation: base, expiryPerf: { total: 0, winRatePct: null }, priceAccuracy: { sampleSize: min, maePct: 4 } });
  assert.ok(lowError > highError, 'a large historical expiry-price error must reduce the score');
});

test('6. assessmentLabel thresholds are internally consistent (STRONG > ACCEPTABLE > WEAK, NO_TRADE always NO_TRADE)', () => {
  assert.strictEqual(assessmentLabel('NO_TRADE', 5), 'NO_TRADE');
  assert.strictEqual(assessmentLabel('UP', 1.2), 'STRONG');
  assert.strictEqual(assessmentLabel('UP', 0.5), 'ACCEPTABLE');
  assert.strictEqual(assessmentLabel('UP', 0.0), 'WEAK');
});

// ---------------------------------------------------------------- the full gate
test('7. no alternative is surfaced when every candidate is only marginally different (never a cosmetic score bump)', async () => {
  store.redis = makeFakeRedis();
  const requestedEvaluation = evalFor(60, { calibratedProbability: 58 });
  const result = await evaluateExpiryOptions({
    requestedDuration: 60,
    requestedEvaluation,
    evaluateCandidate: async (d) => evalFor(d, { calibratedProbability: 58.2 }), // trivially different
    availableCandleCount: 100000,
    mtfCandlesNeededFn: () => 1,
  });
  assert.strictEqual(result.alternative, null);
  assert.ok(result.note && /strongest supported window/.test(result.note));
});

test('8. an alternative IS surfaced when a candidate clears the material margin AND has a trustworthy sample, with concrete reasons', async () => {
  store.redis = makeFakeRedis();
  const requestedEvaluation = evalFor(60, { calibratedProbability: 52 });
  const min = calibrationSvc.MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION;
  // seed real calibration history so the strong candidate's bucket has a trustworthy, materially better track record
  const strongBucket = expiryBucketsSvc.getExpiryBucket(30).key;
  for (let i = 0; i < min; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await calibrationSvc.recordExpiryPerf(strongBucket, true);
  }
  const result = await evaluateExpiryOptions({
    requestedDuration: 60,
    requestedEvaluation,
    evaluateCandidate: async (d) => (d === 30 ? evalFor(30, { calibratedProbability: 85 }) : evalFor(d, { calibratedProbability: 51 })),
    availableCandleCount: 100000,
    mtfCandlesNeededFn: () => 1,
  });
  assert.ok(result.alternative, 'a materially and trustworthily stronger candidate should be surfaced');
  assert.strictEqual(result.alternative.durationMinutes, 30);
  assert.ok(result.alternative.scoreDelta >= MATERIAL_MARGIN);
  assert.ok(result.alternative.reasons.length > 0);
  assert.ok(result.alternative.reasons.some((r) => /calibrated probability/.test(r)));
});

test('9. a candidate with a big score edge but an UNtrustworthy (small) sample is never recommended as the alternative', async () => {
  store.redis = makeFakeRedis();
  const requestedEvaluation = evalFor(60, { calibratedProbability: 52 });
  const result = await evaluateExpiryOptions({
    requestedDuration: 60,
    requestedEvaluation,
    evaluateCandidate: async (d) => evalFor(d, { calibratedProbability: 95 }), // huge edge, but bucket has 0 history (fresh Redis)
    availableCandleCount: 100000,
    mtfCandlesNeededFn: () => 1,
  });
  // fresh store => 0 samples everywhere => not trustworthy => no alternative regardless of score
  assert.strictEqual(result.alternative, null);
});

test('10. a NO_TRADE candidate is never picked as the alternative, no matter what', async () => {
  store.redis = makeFakeRedis();
  const requestedEvaluation = evalFor(60, { calibratedProbability: 52 });
  const result = await evaluateExpiryOptions({
    requestedDuration: 60,
    requestedEvaluation,
    evaluateCandidate: async (d) => evalFor(d, { direction: 'NO_TRADE', calibratedProbability: 99 }),
    availableCandleCount: 100000,
    mtfCandlesNeededFn: () => 1,
  });
  assert.strictEqual(result.alternative, null);
});

run('expiry selection (requested vs alternative expiry evaluation)');
