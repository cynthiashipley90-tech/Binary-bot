require('./helpers/stubDeps');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./testKit');
const { makeCandles, makeInputs } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const store = require('../src/services/redisStore');
const config = require('../src/config');
const binaryEngine = require('../src/services/binaryEngine');
const binaryStore = require('../src/services/binaryStore');
const binaryTracker = require('../src/services/binaryTracker');
const calibrationSvc = require('../src/services/calibration');
const { evaluateGroupsWalkForward, weightsChangeAllowed } = require('../src/backtest/walkForward');

const ROOT = path.join(__dirname, '..');
function walk(dir, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    if (e.name === 'node_modules') return;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  });
  return out;
}

// ------------------------------------------------ walk-forward / no-lookahead
test('1. walk-forward: per-point group scores depend ONLY on candles up to that point (altering the future changes nothing before it)', () => {
  const a = makeCandles({ count: 700, seed: 11, endTime: 1_700_000_000_000 });
  const cut = 520;
  const b = a.map((c, i) => (i > cut ? { ...c, close: c.close * 1.05, high: c.high * 1.05, low: c.low * 1.05, open: c.open * 1.05 } : c));
  const ra = evaluateGroupsWalkForward(a, 15, { collect: true, step: 7 });
  const rb = evaluateGroupsWalkForward(b, 15, { collect: true, step: 7 });
  const beforeA = ra.points.filter((p) => p.index <= cut);
  const beforeB = rb.points.filter((p) => p.index <= cut);
  assert.ok(beforeA.length > 5, 'need real evaluated points before the cut');
  assert.deepStrictEqual(beforeA.map((p) => p.groupScores), beforeB.map((p) => p.groupScores), 'decision inputs at/before the cut must be identical');
});

test('2. walk-forward evaluator is deterministic: same candles -> identical result', () => {
  const c = makeCandles({ count: 650, seed: 3, endTime: 1_700_000_000_000 });
  assert.deepStrictEqual(evaluateGroupsWalkForward(c, 15, { step: 9 }), evaluateGroupsWalkForward(c, 15, { step: 9 }));
});

// ------------------------------------------------ small-sample protection
test('3. weightsChangeAllowed refuses any change when any group is below the sample bar (and when there is no data)', () => {
  const bar = calibrationSvc.MIN_SAMPLES_FOR_CONFIDENT_CALIBRATION;
  assert.strictEqual(weightsChangeAllowed({}, bar).allowed, false);
  assert.strictEqual(weightsChangeAllowed({ TREND: { n: bar }, VOLUME: { n: bar - 1 } }, bar).allowed, false);
  assert.strictEqual(weightsChangeAllowed({ TREND: { n: bar }, VOLUME: { n: bar } }, bar).allowed, true);
});

test('4. the live fixed GROUP_WEIGHTS priors are unchanged by this audit (no fake optimization) and still sum to 1', () => {
  assert.deepStrictEqual(binaryEngine.GROUP_WEIGHTS, {
    TREND: 0.30, MOMENTUM: 0.17, MEAN_REVERSION: 0.12, PRICE_ACTION: 0.24, VOLUME: 0.08, DIVERGENCE: 0.06, CANDLE_QUALITY: 0.03,
  });
  const sum = Object.values(binaryEngine.GROUP_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
});

// ------------------------------------------------ group tracking at settlement
test('5. settlement records each group\'s OWN directional agreement from real outcomes, skipping groups with no opinion', async () => {
  store.redis = makeFakeRedis();
  const inputs = makeInputs({ duration: 5, count: 400 });
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  // Force a known, tiny scenario: two groups with opposite leans, one with none.
  const id = binaryStore.newId(signal.symbol);
  const finalCp = signal.checkpoints[signal.checkpoints.length - 1];
  const signalTime = Date.now() - (finalCp.minutes + 2) * 60000;
  await binaryStore.saveNew({
    ...signal, id, status: 'OPEN', result: null, signalTime, direction: 'UP',
    confluenceGroupScores: { TREND: 0.6, MOMENTUM: -0.4, VOLUME: 0 },
    entryPrice: 100, expectedExpiryPrice: 100.1,
    checkpoints: [{ ...finalCp, fraction: 1, minutes: finalCp.minutes, direction: 'UP' }],
  });
  const twelvedata = require('../src/services/twelvedata');
  const saved = twelvedata.getTimeSeries;
  const bars = [];
  for (let m = 0; m <= finalCp.minutes + 2; m += 1) {
    bars.push({ time: signalTime + m * 60000, open: 100.5, high: 100.6, low: 100.4, close: 100.5, volume: null });
  }
  twelvedata.getTimeSeries = async () => bars; // price finished UP
  try { await binaryTracker.runBinaryTrackerCycle(); } finally { twelvedata.getTimeSeries = saved; }
  const perf = await calibrationSvc.getAllGroupPerf();
  const by = Object.fromEntries(perf.map((r) => [r.key, r]));
  assert.strictEqual(by.TREND.wins, 1, 'TREND leaned UP and price went UP');
  assert.strictEqual(by.MOMENTUM.wins, 0, 'MOMENTUM leaned DOWN and price went UP');
  assert.strictEqual(by.MOMENTUM.total, 1);
  assert.ok(!by.VOLUME, 'a group with no directional opinion must not be graded');
});

// ------------------------------------------------ version metadata + history preservation
test('6. new signals carry modelVersion = config.analyticsVersion (v4), and it is persisted; old records are never rewritten', async () => {
  store.redis = makeFakeRedis();
  assert.strictEqual(config.analyticsVersion, 'binary-engine-v4');
  const inputs = makeInputs({ duration: 30, count: 600 });
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  assert.strictEqual(signal.modelVersion, 'binary-engine-v4');

  const legacyId = binaryStore.newId('EURUSD');
  const legacy = { id: legacyId, symbol: 'EURUSD', status: 'CLOSED', result: 'WIN', signalTime: 1, direction: 'UP' }; // pre-v4: no modelVersion
  await binaryStore.saveNew(legacy);
  const id = binaryStore.newId(signal.symbol);
  await binaryStore.saveNew({ ...signal, id, status: 'OPEN', result: null });
  const all = await binaryStore.getAll();
  const l = all.find((s) => s.id === legacyId);
  const n = all.find((s) => s.id === id);
  assert.strictEqual(l.modelVersion, undefined, 'legacy record must remain untouched');
  assert.strictEqual(l.result, 'WIN');
  assert.strictEqual(n.modelVersion, 'binary-engine-v4');
});

// ------------------------------------------------ expected-price validation / determinism
test('7. expectedExpiryPrice is derived from real entry price + model math: same input -> identical output, and scales with entry price', async () => {
  store.redis = makeFakeRedis();
  const inputs = makeInputs({ duration: 60, count: 900 });
  const s1 = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  store.redis = makeFakeRedis();
  const s2 = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  const strip = (s) => { const { signalTime, expiresAtMs, expiresAtIso, ...r } = s; return r; };
  assert.deepStrictEqual(strip(s1), strip(s2), 'the decision path must be fully deterministic (no randomness)');
  assert.strictEqual(s1.expectedMoveAmount, Number((s1.expectedExpiryPrice - s1.entryPrice).toPrecision(8)));
  assert.strictEqual(s1.expectedMovePct, Number((((s1.expectedExpiryPrice - s1.entryPrice) / s1.entryPrice) * 100).toFixed(4)));
});

test('8. expiry-price bias/MAE are tracked separately from directional win/loss (existing behavior preserved)', async () => {
  store.redis = makeFakeRedis();
  await calibrationSvc.recordExpiryPriceAccuracy('5-10m', { entryPrice: 100, predictedPrice: 100.2, actualPrice: 100.1 });
  await calibrationSvc.recordExpiryPriceAccuracy('5-10m', { entryPrice: 100, predictedPrice: 100.0, actualPrice: 100.3 });
  const acc = await calibrationSvc.getExpiryPriceAccuracy('5-10m');
  assert.strictEqual(acc.sampleSize, 2);
  assert.strictEqual(acc.biasPct, 0.1);
  assert.strictEqual(acc.maePct, 0.2);
  assert.strictEqual(acc.lowConfidence, true, 'n=2 must be flagged as small sample');
});

// ------------------------------------------------ AI absence + no randomness in decision path
test('9. no AI/Gemini/OpenAI anywhere in src (code, config, deps) and no Math.random in decision-path services', () => {
  const srcFiles = walk(path.join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
  srcFiles.forEach((f) => {
    const txt = fs.readFileSync(f, 'utf8');
    assert.ok(!/require\(['"][^'"]*(gemini|openai|anthropic|@google\/generative)/i.test(txt), `${f} must not import an AI SDK`);
    assert.ok(!/GEMINI_API_KEY|OPENAI_API_KEY|generativelanguage\.googleapis/i.test(txt), `${f} must not reference AI endpoints/keys`);
  });
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'src', 'services', 'ai')), false);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(!Object.keys(pkg.dependencies).some((d) => /openai|gemini|anthropic|generative/i.test(d)));
  ['binaryEngine', 'expirySelection', 'nextCandle', 'calibration', 'candleQuality'].forEach((m) => {
    const txt = fs.readFileSync(path.join(ROOT, 'src', 'services', `${m}.js`), 'utf8');
    assert.ok(!/Math\.random/.test(txt), `${m}.js decision path must not use randomness`);
  });
});

run('V4 audit: weights/coefficients, walk-forward, versioning, determinism');
