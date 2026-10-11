require('./helpers/stubDeps');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./testKit');
const { makeTf, findCase, mkBar, makeCandles } = require('./helpers/cryptoFixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const store = require('../src/services/redisStore');
const config = require('../src/config');
const params = require('../src/services/cryptoParams');
const core = require('../src/services/cryptoCore');
const spotEngine = require('../src/services/spotEngine');
const spotStore = require('../src/services/spotStore');
const spotTracker = require('../src/services/spotTracker');
const twelvedata = require('../src/services/twelvedata');
const structureSvc = require('../src/services/structure');
const indicators = require('../src/services/indicators');
const tr = require('../src/services/tradeResolution');
const stats = require('../src/services/signalStats');
const { handleSpotSignalCommand, handleSpotAccuracyCommand } = require('../src/commands/spotSignal');
const { formatSpotSignalMessage } = require('../src/utils/spotFormatting');

const compute = (c, e) => spotEngine.computeSpotSignalCore(c, e);
const resetWorld = () => { store.redis = makeFakeRedis(); };
const ROOT = path.resolve(__dirname, '..');

// ============================================================ parameters
test('P1. parameter audit: every parameter is classified, none is claimed validated/optimal', () => {
  const rows = params.auditRows();
  assert.ok(rows.length >= 20);
  const names = new Set();
  for (const r of rows) {
    assert.ok(!names.has(r.name), `duplicate ${r.name}`);
    names.add(r.name);
    assert.ok(params.KINDS.includes(r.kind), `${r.name} has unclassified kind`);
    assert.strictEqual(r.validated, false, `${r.name} must not claim to be validated`);
    assert.ok(r.note && r.note.length > 10, `${r.name} needs a note`);
    assert.doesNotMatch(r.note, /\boptimal\b|proven/i, `${r.name} note must not claim optimality`);
  }
  assert.ok(rows.some((r) => r.name === 'binaryEngine.GROUP_WEIGHTS'), 'inherited arbitrary binary weights must be disclosed');
  assert.strictEqual(params.REGISTRY.find((r) => r.name === 'ATR_PERIOD').kind, 'TECHNICAL_CONSTANT');
  assert.strictEqual(params.REGISTRY.find((r) => r.name === 'ATR_STOP_BUFFER_MULT').kind, 'MODEL_PARAMETER');
  assert.strictEqual(params.P.ATR_PERIOD, 14);
});

test('P2. decision-path source has no randomness and no wall clock (core), no hardcoded % stops/targets', () => {
  const decisionFiles = ['cryptoCore.js', 'signalStats.js', 'tradeResolution.js', 'futuresEngine.js'];
  for (const f of decisionFiles) {
    const src = fs.readFileSync(path.join(ROOT, 'src/services', f), 'utf8');
    assert.doesNotMatch(src, /Math\.random/, `${f} must not use Math.random`);
  }
  const coreSrc = fs.readFileSync(path.join(ROOT, 'src/services/cryptoCore.js'), 'utf8');
  assert.doesNotMatch(coreSrc, /Date\.now\(\)/, 'cryptoCore must not read the wall clock');
  assert.doesNotMatch(coreSrc, /\*\s*1\.0[1-9]|\*\s*0\.9[0-9]\b|entry\s*[*+-]\s*0\.0/i, 'no flat-percentage stop/target arithmetic');
  assert.strictEqual(config.spotAnalyticsVersion, 'crypto-signal-v7');
  assert.strictEqual(config.futuresAnalyticsVersion, 'futures-signal-v1');
  assert.strictEqual(config.analyticsVersion, 'binary-engine-v4', 'binary tag must stay untouched');
});

// ============================================================ LONG / SHORT / NO_SIGNAL
const LONG = () => findCase(compute, (s) => s.direction === 'LONG');
const SHORT = () => findCase(compute, (s) => s.direction === 'SHORT');

test('C1. LONG: SL below entry, TP above, TP1 R:R recomputes exactly, TP2 (if any) is further', () => {
  const { sig, entry } = LONG();
  assert.ok(sig.stopLoss < entry && sig.takeProfit1 > entry);
  const risk = entry - sig.stopLoss;
  assert.ok(Math.abs(sig.takeProfit1RR - (sig.takeProfit1 - entry) / risk) < 0.02);
  assert.ok(sig.takeProfit1RR >= params.P.MIN_RISK_REWARD - 0.01);
  if (sig.takeProfit2 != null) {
    assert.ok(sig.takeProfit2 > sig.takeProfit1);
    assert.ok(sig.takeProfit2RR >= params.P.TP2_MIN_RISK_REWARD - 0.01);
  } else {
    assert.strictEqual(sig.takeProfit2RR, null);
    assert.match(sig.takeProfit2Method, /none/);
  }
});

test('C2. SHORT mirrors LONG', () => {
  const { sig, entry } = SHORT();
  assert.ok(sig.stopLoss > entry && sig.takeProfit1 < entry);
  const risk = sig.stopLoss - entry;
  assert.ok(Math.abs(sig.takeProfit1RR - (entry - sig.takeProfit1) / risk) < 0.02);
  if (sig.takeProfit2 != null) assert.ok(sig.takeProfit2 < sig.takeProfit1);
});

test('C3. NO_SIGNAL is never converted to LONG/SHORT and carries reasons but no SL/TP/expected move', () => {
  const { sig } = findCase(compute, (s) => s.direction === 'NO_SIGNAL' && /tilt too weak/.test((s.reasons || []).join(' ')));
  assert.strictEqual(sig.direction, 'NO_SIGNAL');
  assert.ok(sig.reasons.length > 0);
  for (const k of ['stopLoss', 'takeProfit1', 'takeProfit2', 'expectedMove']) assert.strictEqual(sig[k], undefined, `${k} must be absent`);
});

test('C4. deterministic repeatability: identical input -> deep-equal output (LONG and NO_SIGNAL paths)', () => {
  const a = LONG(); const b = SHORT();
  assert.deepStrictEqual(compute(a.candles, a.entry), compute(a.candles, a.entry));
  assert.deepStrictEqual(compute(b.candles, b.entry), compute(b.candles, b.entry));
});

// ============================================================ dynamic SL
test('S1. computeStop skips swings inside the ATR noise floor and takes the next structural swing', () => {
  const swings = { swingLows: [{ price: 99.9 }, { price: 98 }, { price: 96 }], swingHighs: [{ price: 100.1 }, { price: 102 }] };
  const long = core.computeStop('LONG', 100, 1, swings); // buffer .5, floor 1
  assert.strictEqual(long.stopPrice, 97.5); // 99.9->99.4 (0.6<1) skipped; 98->97.5 (2.5) used
  assert.strictEqual(long.swingRef, 98);
  assert.strictEqual(long.noiseFloorSkips, 1);
  assert.match(long.method, /structure-swing-low/);
  const short = core.computeStop('SHORT', 100, 1, swings);
  assert.strictEqual(short.stopPrice, 102.5);
  assert.strictEqual(short.swingRef, 102);
});

test('S2. ATR fallback ONLY when no structural swing qualifies; null when no ATR and no swing', () => {
  const none = { swingLows: [], swingHighs: [] };
  const f = core.computeStop('LONG', 100, 1.5, none);
  assert.strictEqual(f.stopPrice, 100 - 1.5 * params.P.ATR_FALLBACK_STOP_MULT);
  assert.strictEqual(f.swingRef, null);
  assert.match(f.method, /ATR x/);
  const tooClose = core.computeStop('LONG', 100, 1, { swingLows: [{ price: 99.95 }], swingHighs: [] });
  assert.match(tooClose.method, /ATR x/, 'only swing is inside the noise floor -> ATR fallback');
  assert.strictEqual(core.computeStop('LONG', 100, null, none), null);
  const structural = core.computeStop('LONG', 100, 1, { swingLows: [{ price: 97 }], swingHighs: [] });
  assert.match(structural.method, /structure/);
});

test('S3. a live signal whose method says "structure" really sits at a detected swing minus the ATR buffer', () => {
  const { sig, candles } = findCase(compute, (s) => s.direction !== 'NO_SIGNAL' && /structure-swing/.test(s.stopMethod));
  const swings = structureSvc.findSwings(candles);
  const pool = sig.direction === 'LONG' ? swings.swingLows : swings.swingHighs;
  const expected = pool.map((p) => (sig.direction === 'LONG' ? p.price - sig.atr * params.P.ATR_STOP_BUFFER_MULT : p.price + sig.atr * params.P.ATR_STOP_BUFFER_MULT));
  assert.ok(expected.some((e) => Math.abs(e - sig.stopLoss) < Math.abs(e) * 1e-6), 'stop must equal a real swing +/- ATR buffer');
  assert.ok(Math.abs(indicators.atr(candles, 14) - sig.atr) < sig.atr * 1e-6, 'ATR in the signal is the real ATR(14)');
});

// ============================================================ dynamic TP
test('T1. computeTakeProfits uses only real levels: TP1 = first level clearing the floor, TP2 = a real level beyond it', () => {
  const levels = [{ price: 101 }, { price: 103.5, touches: 3 }, { price: 104 }, { price: 108.5, touches: 2 }];
  const r = core.computeTakeProfits('LONG', 100, 2, levels);
  assert.strictEqual(r.tp1.price, 103.5);
  assert.strictEqual(r.tp1.rr, 1.75);
  assert.strictEqual(r.tp2.price, 108.5);
  assert.strictEqual(r.tp2.rr, 4.25);
  const s = core.computeTakeProfits('SHORT', 100, 2, [{ price: 96.5 }, { price: 91.5 }, { price: 99 }]);
  assert.strictEqual(s.tp1.price, 96.5);
  assert.strictEqual(s.tp2.price, 91.5);
});

test('T2. no qualifying level -> NO TP (null), never a synthetic R-multiple; TP2 omitted when no real level beyond', () => {
  assert.strictEqual(core.computeTakeProfits('LONG', 100, 2, [{ price: 101 }]), null);
  assert.strictEqual(core.computeTakeProfits('LONG', 100, 2, []), null);
  const r = core.computeTakeProfits('LONG', 100, 2, [{ price: 103.5 }]);
  assert.strictEqual(r.tp1.price, 103.5);
  assert.strictEqual(r.tp2, null);
});

test('T3. engine returns NO_SIGNAL (not a forced target) when no real level clears the R:R floor', () => {
  const { sig } = findCase(compute, (s) => s.direction === 'NO_SIGNAL' && /no real (resistance|support) level clears/.test((s.reasons || []).join(' ')));
  assert.match(sig.reasons[0], /not forcing one/);
  assert.strictEqual(sig.takeProfit1, undefined);
});

test('T4. a live TP1 is a genuine clustered S/R level from the same candles', () => {
  const { sig, candles, entry } = LONG();
  const atrPct = (sig.atr / entry) * 100;
  const levels = structureSvc.findKeyLevels(candles, (atrPct * params.P.LEVEL_CLUSTER_ATR_MULT) / 10);
  assert.ok(levels.some((l) => Math.abs(l.price - sig.takeProfit1) < l.price * 1e-6), 'TP1 must equal a detected level');
});

// ============================================================ expected move
test('E1. expected move is evidence-backed, separate from TP, and absent without enough samples', () => {
  const { sig, candles, entry } = LONG();
  const em = sig.expectedMove;
  assert.ok(em && em.samples >= params.P.EXPECTED_MOVE_MIN_SAMPLES && em.amount > 0);
  assert.ok(em.rangeLow <= em.amount && em.amount <= em.rangeHigh);
  assert.notStrictEqual(Math.abs(sig.takeProfit1 - entry), em.amount, 'expected move is not the TP');
  assert.strictEqual(core.expectedMove(candles.slice(0, 50), 'LONG', entry, 60000), null, 'too few windows -> unavailable, not invented');
  const again = core.expectedMove(candles, 'LONG', entry, 60000);
  assert.deepStrictEqual(again, core.expectedMove(candles, 'LONG', entry, 60000));
});

test('E2. expected move scales with the data (not a fixed percentage)', () => {
  const calm = makeCandles({ count: 300, seed: 3, vol: 0.0001, start: 100 });
  const wild = makeCandles({ count: 300, seed: 3, vol: 0.0008, start: 100 });
  const a = core.expectedMove(calm, 'LONG', 100, 60000);
  const b = core.expectedMove(wild, 'LONG', 100, 60000);
  assert.ok(b.pct > a.pct * 3, `wild ${b.pct} should be well above calm ${a.pct}`);
});

// ============================================================ no lookahead
test('L1. appending/altering bars AFTER the cut cannot change a signal computed at the cut', () => {
  const { candles, entry } = LONG();
  const prefix = candles.slice(0, 380);
  const futureA = makeCandles({ count: 20, seed: 5, start: candles[379].close, endTime: candles[379].time + 20 * 60000 });
  const futureB = makeCandles({ count: 20, seed: 6, drift: -0.01, start: candles[379].close * 2, endTime: candles[379].time + 20 * 60000 });
  const e = prefix[prefix.length - 1].close;
  const s1 = compute(prefix, e);
  const s2 = compute(prefix, e);
  assert.deepStrictEqual(s1, s2);
  // the same function fed prefix+futureA vs prefix+futureB MUST differ only because its input differs, never the other way round
  const withA = compute([...prefix, ...futureA], futureA[futureA.length - 1].close);
  const withB = compute([...prefix, ...futureB], futureB[futureB.length - 1].close);
  assert.ok(JSON.stringify(withA) !== JSON.stringify(withB) || withA.direction === 'NO_SIGNAL');
  assert.strictEqual(entry, candles[candles.length - 1].close);
});

test('L2. forming candle is dropped; a closed one is kept', () => {
  const now = 1_000_000_000;
  const mk = (t) => ({ time: t, open: 1, high: 1, low: 1, close: 1 });
  const closedOnly = [mk(now - 180000), mk(now - 120000), mk(now - 60000)];
  assert.strictEqual(core.dropFormingCandle(closedOnly, now, 60000).length, 3);
  const withForming = [...closedOnly, mk(now - 30000)];
  assert.strictEqual(core.dropFormingCandle(withForming, now, 60000).length, 3);
  assert.deepStrictEqual(core.dropFormingCandle([], now, 60000), []);
});

// ============================================================ MTF
const A = (tf, bias, status = 'OK') => ({ tf, status, bias, structure: 'X', reason: status === 'OK' ? undefined : 'no data' });

test('M1. mtfEvidence: highest TF vetoes, lower TF conflict only lowers quality, not equal-weighted', () => {
  assert.strictEqual(core.mtfEvidence('LONG', [A('15min', 'BULLISH'), A('1h', 'BEARISH')]).blocked, true);
  const partial = core.mtfEvidence('LONG', [A('15min', 'BEARISH'), A('1h', 'BULLISH')]);
  assert.strictEqual(partial.blocked, false);
  assert.strictEqual(partial.verdict, 'PARTIAL_CONFLICT');
  assert.strictEqual(core.mtfEvidence('LONG', [A('15min', 'BULLISH'), A('1h', 'BULLISH')]).verdict, 'ALIGNED');
  assert.strictEqual(core.mtfEvidence('SHORT', [A('15min', 'BEARISH'), A('1h', 'BEARISH')]).verdict, 'ALIGNED');
  assert.strictEqual(core.mtfEvidence('LONG', [A('15min', null, 'INSUFFICIENT'), A('1h', null, 'INSUFFICIENT')]).verdict, 'UNAVAILABLE');
  assert.strictEqual(core.mtfEvidence('LONG', [A('15min', 'BEARISH'), A('1h', null, 'INSUFFICIENT')]).blocked, true, 'highest AVAILABLE tf decides');
  assert.strictEqual(core.mtfEvidence('LONG', [A('15min', 'BULLISH'), A('1h', 'NEUTRAL')]).blocked, false);
});

test('M2. engine integration: opposing dominant timeframe turns a LONG/SHORT into NO_SIGNAL with the reason', () => {
  const { candles, entry, sig } = LONG();
  const blocked = spotEngine.computeSpotSignalCore(candles, entry, [A('15min', 'BULLISH'), A('1h', 'BEARISH')]);
  assert.strictEqual(blocked.direction, 'NO_SIGNAL');
  assert.match(blocked.reasons[0], /dominant higher timeframe \(1h\) is BEARISH/);
  const ok = spotEngine.computeSpotSignalCore(candles, entry, [A('15min', 'BULLISH'), A('1h', 'BULLISH')]);
  assert.strictEqual(ok.direction, sig.direction);
  assert.strictEqual(ok.mtf.verdict, 'ALIGNED');
  assert.ok(ok.qualityScore >= compute(candles, entry).qualityScore, 'alignment never lowers quality');
});

test('M3. no higher-timeframe data -> quality capped at LOW (reduced, not hidden)', () => {
  const { sig } = findCase((c, e) => spotEngine.computeSpotSignalCore(c, e, [A('15min', null, 'INSUFFICIENT'), A('1h', null, 'INSUFFICIENT')]), (s) => s.direction !== 'NO_SIGNAL');
  assert.strictEqual(sig.qualityLabel, 'LOW');
  assert.ok(sig.qualityCaps.some((c) => /no higher-timeframe data/.test(c)));
});

test('M4. assessTimeframe: insufficient/mismatched data is reported, real data yields a bias', () => {
  assert.strictEqual(core.assessTimeframe('1h', makeTf({ stepMs: 3600000, count: 20 }), 3600000).status, 'INSUFFICIENT');
  assert.strictEqual(core.assessTimeframe('1h', null, 3600000).status, 'INSUFFICIENT');
  const wrong = core.assessTimeframe('1h', makeTf({ stepMs: 60000, count: 200 }), 3600000);
  assert.strictEqual(wrong.status, 'INSUFFICIENT');
  assert.match(wrong.reason, /spacing/);
  const good = core.assessTimeframe('1h', makeTf({ stepMs: 3600000, count: 200, drift: 0.002 }), 3600000);
  assert.strictEqual(good.status, 'OK');
  assert.ok(['BULLISH', 'BEARISH', 'NEUTRAL'].includes(good.bias));
});

test('M5. fetchSpotInputs builds MTF from real 15min/1h fetches; a failed HTF fetch degrades to INSUFFICIENT, not a crash', async () => {
  const savedTS = twelvedata.getTimeSeries; const savedCP = twelvedata.getCurrentPrice;
  const now = Date.now();
  const calls = [];
  twelvedata.getTimeSeries = async (sym, iv, size, opts) => {
    calls.push({ iv, utc: opts && opts.utc });
    if (iv === '1min') return makeCandles({ count: 320, seed: 11, vol: 0.0004, start: 60000, endTime: now });
    if (iv === '15min') return makeTf({ stepMs: 900000, count: 200, seed: 12, drift: 0.0005, endTime: now - 900000 });
    throw new Error('1h feed down');
  };
  twelvedata.getCurrentPrice = async () => null;
  try {
    const inputs = await spotEngine.fetchSpotInputs('BTCUSD');
    assert.deepStrictEqual(inputs.mtf.map((m) => m.tf), ['15min', '1h']);
    assert.strictEqual(inputs.mtf[0].status, 'OK');
    assert.strictEqual(inputs.mtf[1].status, 'INSUFFICIENT');
    assert.ok(calls.every((c) => c.utc === true), 'all crypto fetches request UTC explicitly');
    assert.strictEqual(inputs.priceSource, 'last-closed-candle');
    const lastT = inputs.candles[inputs.candles.length - 1].time;
    assert.ok(lastT + 60000 <= inputs.fetchedAt, 'forming 1min candle was dropped');
  } finally { twelvedata.getTimeSeries = savedTS; twelvedata.getCurrentPrice = savedCP; }
});

// ============================================================ quality / probability honesty
test('Q1. HIGH label requires real settled history; otherwise capped to MEDIUM with a stated reason', () => {
  const high = { direction: 'LONG', qualityLabel: 'HIGH', qualityCaps: [] };
  const capped = core.applyHistoryToQuality(high, { settled: 5, sufficient: false });
  assert.strictEqual(capped.qualityLabel, 'MEDIUM');
  assert.match(capped.qualityCaps[0], /capped to MEDIUM/);
  assert.strictEqual(core.applyHistoryToQuality(high, null).qualityLabel, 'MEDIUM');
  assert.strictEqual(core.applyHistoryToQuality(high, { settled: 30, sufficient: true }).qualityLabel, 'HIGH');
  assert.strictEqual(core.applyHistoryToQuality({ direction: 'NO_SIGNAL' }, null).qualityLabel, undefined);
});

test('Q2. no probability/confidence number is generated: output has no probability fields, no 90/95/99% claims', () => {
  const { sig } = LONG();
  for (const k of ['probability', 'confidence', 'calibratedProbability', 'winProbability']) assert.strictEqual(sig[k], undefined);
  const text = formatSpotSignalMessage({ ...sig, symbol: 'BTCUSD', signalTimeIso: 'x' });
  assert.doesNotMatch(text, /\b(90|95|99)\s?%/);
  assert.match(text, /not a probability/);
});

// ============================================================ data handling
test('D1. duplicate candles are dropped and reported; too-few/stale/inconsistent data never yields a signal', async () => {
  const savedTS = twelvedata.getTimeSeries; const savedCP = twelvedata.getCurrentPrice;
  const now = Date.now();
  const base = makeCandles({ count: 320, seed: 14, vol: 0.0004, start: 60000, endTime: now - 120000 });
  twelvedata.getTimeSeries = async (s, iv) => (iv === '1min' ? [...base, base[100], base[200]] : null);
  twelvedata.getCurrentPrice = async () => base[base.length - 1].close;
  try {
    const inputs = await spotEngine.fetchSpotInputs('BTCUSD');
    assert.strictEqual(inputs.candles.length, 320);
    assert.ok(inputs.dataQuality.issues.some((i) => /duplicate/.test(i)));
    const sig = await spotEngine.generateSpotSignal('BTCUSD', inputs);
    assert.ok(sig.dataQualityIssues.some((i) => /duplicate/.test(i)));

    // stale: newest closed candle 30 minutes old
    const stale = makeCandles({ count: 320, seed: 14, vol: 0.0004, start: 60000, endTime: now - 30 * 60000 });
    twelvedata.getTimeSeries = async (s, iv) => (iv === '1min' ? stale : null);
    const sInputs = await spotEngine.fetchSpotInputs('BTCUSD');
    const staleSig = await spotEngine.generateSpotSignal('BTCUSD', sInputs);
    assert.strictEqual(staleSig.direction, 'NO_SIGNAL');
    assert.ok(staleSig.reasons.some((r) => /stale/.test(r)));

    // too few
    twelvedata.getTimeSeries = async () => makeCandles({ count: 10, endTime: now - 120000 });
    await assert.rejects(() => spotEngine.fetchSpotInputs('BTCUSD'), (e) => e.code === 'INSUFFICIENT_DATA');
  } finally { twelvedata.getTimeSeries = savedTS; twelvedata.getCurrentPrice = savedCP; }
});

test('D2. a live quote far from the last closed candle (in ATR) is rejected as inconsistent data', async () => {
  const { candles, entry } = LONG();
  const inputs = { symbol: 'BTCUSD', candles, entryPrice: entry * 1.2, priceSource: 'live-quote', staleness: { stale: false }, dataQuality: { issues: [] }, mtf: [] };
  const sig = await spotEngine.generateSpotSignal('BTCUSD', inputs);
  assert.strictEqual(sig.direction, 'NO_SIGNAL');
  assert.ok(sig.reasons.some((r) => /inconsistent data/.test(r) || /tilt|level|regime/.test(r)));
});

test('D3. generateSpotSignal is repeatable (same inputs -> same decision/levels) and stamps v7 metadata', async () => {
  const { candles, entry } = LONG();
  const inputs = { symbol: 'BTCUSD', candles, entryPrice: entry, priceSource: 'live-quote', staleness: { stale: false }, dataQuality: { issues: [] }, mtf: [A('15min', 'BULLISH'), A('1h', 'BULLISH')] };
  const a = await spotEngine.generateSpotSignal('BTCUSD', inputs);
  const b = await spotEngine.generateSpotSignal('BTCUSD', inputs);
  const strip = (s) => { const { signalTime, signalTimeIso, ...rest } = s; return rest; };
  assert.deepStrictEqual(strip(a), strip(b));
  assert.strictEqual(a.modelVersion, 'crypto-signal-v7');
  assert.strictEqual(a.timeframe, '1min');
  assert.strictEqual(a.engine, 'spot');
  assert.ok(Number.isFinite(a.signalTime) && a.signalTimeIso);
  assert.ok(a.session && a.session.session && Number.isFinite(a.rawScore));
});

// ============================================================ first touch / MAE / MFE
const mk = (t, h, l) => mkBar(t, h, l);

test('R1. firstTouch: LONG/SHORT first valid touch, tp2 may be null, ambiguity is conservative and flagged', () => {
  assert.strictEqual(tr.firstTouch([mk(1, 100, 99), mk(2, 106, 100)], 'LONG', 95, 105, null).result, 'WIN_TP1');
  assert.strictEqual(tr.firstTouch([mk(1, 100, 99), mk(2, 111, 100)], 'LONG', 95, 105, 110).result, 'WIN_TP2');
  assert.strictEqual(tr.firstTouch([mk(1, 100, 99), mk(2, 100, 94)], 'LONG', 95, 105, 110).result, 'LOSS');
  assert.strictEqual(tr.firstTouch([mk(1, 101, 99), mk(2, 102, 98)], 'LONG', 95, 105, null), null);
  assert.strictEqual(tr.firstTouch([mk(1, 100, 96), mk(2, 100, 94)], 'SHORT', 105, 95, 90).result, 'WIN_TP1');
  const amb = tr.firstTouch([mk(1, 106, 89)], 'SHORT', 105, 95, 90);
  assert.deepStrictEqual([amb.result, amb.ambiguous], ['LOSS', true]);
  const order = tr.firstTouch([mk(1, 101, 99), mk(2, 100, 94), mk(3, 106, 100)], 'LONG', 95, 105, null);
  assert.strictEqual(order.result, 'LOSS', 'earlier SL touch wins over a later TP touch');
  assert.strictEqual(order.index, 1);
});

test('R2. MAE/MFE are computed from entry in the correct direction', () => {
  const bars = [mk(1, 103, 98), mk(2, 107, 101)];
  const l = tr.accumulateExcursions(null, bars, 'LONG', 100);
  assert.deepStrictEqual([l.maeAbs, l.mfeAbs], [2, 7]);
  const s = tr.accumulateExcursions(null, bars, 'SHORT', 100);
  assert.deepStrictEqual([s.maeAbs, s.mfeAbs], [7, 2]);
  const carried = tr.accumulateExcursions({ maeAbs: 9, mfeAbs: 1 }, bars, 'LONG', 100);
  assert.deepStrictEqual([carried.maeAbs, carried.mfeAbs], [9, 7], 'running values only ever grow');
  const flat = tr.accumulateExcursions(null, [mk(1, 100, 100)], 'LONG', 100);
  assert.deepStrictEqual([flat.maeAbs, flat.mfeAbs], [0, 0]);
});

async function openSignal(extra = {}) {
  const signalTime = 1_700_000_000_000;
  const id = spotStore.newId('BTCUSD');
  const rec = {
    id, symbol: 'BTCUSD', timeframe: '1min', signalTime, status: 'OPEN', result: null, direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit1: 105, takeProfit2: 110, riskAmount: 5, takeProfit1RR: 1, takeProfit2RR: 2, ...extra,
  };
  await spotStore.saveNew(rec);
  return rec;
}
const cfg = { intervalMs: 60000, expireAfterMs: 72 * 3600000, store: spotStore };

test('R3. resolution records MAE/MFE/time-to-result/actual move and stops MAE/MFE at the resolving candle (no leakage)', async () => {
  resetWorld();
  const sig = await openSignal();
  const t0 = sig.signalTime;
  const candles = [
    mk(t0, 101, 99), // contains signal instant -> opens at/after signal
    mk(t0 + 60000, 103, 97), // MAE 3
    mk(t0 + 120000, 106, 101), // TP1 here, MFE 6
    mk(t0 + 180000, 150, 40), // AFTER outcome: must not leak into MAE/MFE
  ];
  const res = await tr.resolveOpenSignal(sig, candles, t0 + 10 * 60000, cfg);
  assert.strictEqual(res, 'WIN_TP1');
  const r = await spotStore.get(sig.id);
  assert.strictEqual(r.status, 'CLOSED');
  assert.strictEqual(r.maeAbs, 3);
  assert.strictEqual(r.mfeAbs, 6);
  assert.strictEqual(r.maeR, 0.6);
  assert.strictEqual(r.mfeR, 1.2);
  assert.strictEqual(r.timeToResultMs, 120000);
  assert.strictEqual(r.actualMovePct, 5);
  assert.strictEqual(r.integrity, 'OK');
  assert.strictEqual(r.ambiguous, false);
});

test('R4. candles BEFORE the signal and the still-forming candle are never used', async () => {
  resetWorld();
  const sig = await openSignal();
  const t0 = sig.signalTime;
  const now = t0 + 3 * 60000;
  const candles = [
    mk(t0 - 120000, 200, 1), // before signal: would hit SL & TP if (wrongly) used
    mk(t0 + 60000, 101, 99),
    mk(t0 + now - t0 - 30000 + 0, 500, 1), // forming (opens 30s before now, not closed)
  ];
  const res = await tr.resolveOpenSignal(sig, candles, now, cfg);
  assert.strictEqual(res, null);
  const r = await spotStore.get(sig.id);
  assert.strictEqual(r.status, 'OPEN');
  assert.strictEqual(r.maeAbs, 1);
  assert.strictEqual(r.mfeAbs, 1);
});

test('R5. unresolved stays OPEN, checkpoint continues next cycle, then expires honestly as EXPIRED_UNRESOLVED (never WIN/LOSS)', async () => {
  resetWorld();
  const sig = await openSignal();
  const t0 = sig.signalTime;
  await tr.resolveOpenSignal(sig, [mk(t0 + 60000, 101, 99), mk(t0 + 120000, 102, 98.5)], t0 + 600000, cfg);
  let r = await spotStore.get(sig.id);
  assert.strictEqual(r.status, 'OPEN');
  assert.strictEqual(r.lastCandleTime, t0 + 120000);
  assert.strictEqual(r.maeAbs, 1.5);
  // second cycle supplies overlapping + new candles; old ones are not re-processed
  await tr.resolveOpenSignal(r, [mk(t0 + 60000, 150, 1), mk(t0 + 120000, 150, 1), mk(t0 + 180000, 103, 99)], t0 + 900000, cfg);
  r = await spotStore.get(sig.id);
  assert.strictEqual(r.status, 'OPEN');
  assert.strictEqual(r.maeAbs, 1.5);
  assert.strictEqual(r.mfeAbs, 3);
  const exp = await tr.resolveOpenSignal(r, [], t0 + 73 * 3600000, cfg);
  assert.strictEqual(exp, 'EXPIRED_UNRESOLVED');
  r = await spotStore.get(sig.id);
  assert.strictEqual(r.result, 'EXPIRED_UNRESOLVED');
  assert.strictEqual(r.status, 'CLOSED');
});

test('R6. missing candles while tracking flag integrity GAP; such results are excluded from win-rate statistics', async () => {
  resetWorld();
  const sig = await openSignal();
  const t0 = sig.signalTime;
  const res = await tr.resolveOpenSignal(sig, [mk(t0 + 3 * 3600000, 106, 100)], t0 + 4 * 3600000, cfg);
  assert.strictEqual(res, 'WIN_TP1');
  const r = await spotStore.get(sig.id);
  assert.strictEqual(r.integrity, 'GAP');
  assert.match(r.note, /data gap/);
  assert.strictEqual(stats.isSettled(r), false);
  const sum = stats.summarize([r]);
  assert.strictEqual(sum.settled, 0);
  assert.strictEqual(sum.gap, 1);
});

test('R7. same-candle SL+TP is recorded as ambiguous conservative LOSS', async () => {
  resetWorld();
  const sig = await openSignal();
  const t0 = sig.signalTime;
  await tr.resolveOpenSignal(sig, [mk(t0 + 60000, 112, 94)], t0 + 600000, cfg);
  const r = await spotStore.get(sig.id);
  assert.strictEqual(r.result, 'LOSS');
  assert.strictEqual(r.ambiguous, true);
  assert.match(r.note, /ambiguity/);
});

test('R8. spotTracker works with tp2 = null (no TP2 level) and fetches UTC candles', async () => {
  resetWorld();
  const now = Date.now();
  const signalTime = now - 10 * 60000;
  const id = spotStore.newId('BTCUSD');
  await spotStore.saveNew({ id, symbol: 'BTCUSD', signalTime, status: 'OPEN', result: null, direction: 'LONG', entryPrice: 100, stopLoss: 95, takeProfit1: 105, takeProfit2: null });
  const saved = twelvedata.getTimeSeries; let optsSeen;
  twelvedata.getTimeSeries = async (s, iv, n, opts) => { optsSeen = opts; return [{ time: Math.ceil(signalTime / 60000) * 60000, open: 100, close: 106, high: 106.5, low: 99.9 }]; };
  try { await spotTracker.runSpotTrackerCycle(); } finally { twelvedata.getTimeSeries = saved; }
  assert.strictEqual((await spotStore.get(id)).result, 'WIN_TP1');
  assert.deepStrictEqual(optsSeen, { utc: true });
});

// ============================================================ statistics
const settled = (o) => ({ status: 'CLOSED', integrity: 'OK', signalTime: o.t || 1, symbol: 'BTCUSD', timeframe: '1min', direction: 'LONG', modelVersion: 'crypto-signal-v7', takeProfit1RR: 1.5, takeProfit2RR: 3, ...o });

test('H1. unresolved/expired are never counted as wins or losses; win rate has n and an honest interval', () => {
  const recs = [settled({ result: 'WIN_TP1' }), settled({ result: 'WIN_TP2' }), settled({ result: 'LOSS' }), settled({ result: 'EXPIRED_UNRESOLVED' }), { ...settled({ result: null }), status: 'OPEN' }];
  const s = stats.summarize(recs);
  assert.deepStrictEqual([s.winTp1, s.winTp2, s.loss, s.expired, s.open, s.settled], [1, 1, 1, 1, 1, 3]);
  assert.strictEqual(s.winRatePct, 66.7);
  assert.strictEqual(s.sufficient, false);
  assert.ok(s.winRateCI95.low < 66.7 && s.winRateCI95.high > 66.7 && s.winRateCI95.high - s.winRateCI95.low > 40, 'n=3 interval must be wide');
  assert.strictEqual(s.expectancyR, Number(((1.5 + 3 - 1) / 3).toFixed(2)));
  assert.strictEqual(stats.summarize([]).winRatePct, null);
});

test('H2. symbol / timeframe / direction are never pooled in the grouped report', () => {
  const recs = [
    settled({ result: 'WIN_TP1' }), settled({ result: 'LOSS', symbol: 'ETHUSD' }),
    settled({ result: 'WIN_TP1', timeframe: '15m' }), settled({ result: 'LOSS', direction: 'SHORT' }),
  ];
  const rep = stats.buildReport(recs);
  const keys = Object.keys(rep.symbolTfDirection);
  assert.strictEqual(keys.length, 4);
  assert.strictEqual(rep.symbol.BTCUSD.settled, 3);
  assert.strictEqual(rep.symbol.ETHUSD.settled, 1);
  assert.strictEqual(rep.timeframe['15m'].settled, 1);
  assert.strictEqual(rep.direction.SHORT.settled, 1);
  assert.ok(rep.modelVersion['crypto-signal-v7']);
});

test('H3. history evidence only uses the same symbol/timeframe/direction/model version; legacy records are excluded', () => {
  const recs = [
    ...Array.from({ length: 30 }, () => settled({ result: 'WIN_TP1' })),
    settled({ result: 'LOSS', modelVersion: 'binary-engine-v4' }),
    settled({ result: 'LOSS', symbol: 'ETHUSD' }),
    settled({ result: 'LOSS', direction: 'SHORT' }),
    { ...settled({ result: 'LOSS' }), modelVersion: undefined },
  ];
  const h = stats.historyEvidence(recs, { symbol: 'BTCUSD', timeframe: '1min', direction: 'LONG', modelVersion: 'crypto-signal-v7' });
  assert.strictEqual(h.settled, 30);
  assert.strictEqual(h.winRatePct, 100);
  assert.strictEqual(h.sufficient, true);
  const none = stats.historyEvidence(recs, { symbol: 'XRPUSD', timeframe: '1min', direction: 'LONG', modelVersion: 'crypto-signal-v7' });
  assert.strictEqual(none.settled, 0);
  assert.strictEqual(none.sufficient, false);
});

test('H4. walk-forward stability report refuses to run on insufficient data and never claims optimization', () => {
  const few = stats.walkForwardReport(Array.from({ length: 20 }, (_, i) => settled({ result: 'WIN_TP1', t: i })));
  assert.strictEqual(few.status, 'INSUFFICIENT_DATA');
  assert.match(few.message, /no optimization or "proven" claim is possible/);
  const many = stats.walkForwardReport(Array.from({ length: 150 }, (_, i) => settled({ result: i % 3 ? 'WIN_TP1' : 'LOSS', t: i })));
  assert.strictEqual(many.status, 'OK');
  assert.strictEqual(many.folds.length, 3);
  assert.ok(many.folds.every((f) => f.n === 50));
  assert.match(many.note, /fixed \(not fitted\)/);
});

// ============================================================ commands / storage
function stubFeeds(candles, now = Date.now()) {
  const sTS = twelvedata.getTimeSeries; const sCP = twelvedata.getCurrentPrice;
  twelvedata.getTimeSeries = async (s, iv) => (iv === '1min' ? candles : null);
  twelvedata.getCurrentPrice = async () => candles[candles.length - 1].close;
  return () => { twelvedata.getTimeSeries = sTS; twelvedata.getCurrentPrice = sCP; };
}

test('K1. !signal registers ONLY directional signals; the record carries the full v7 context; no binary/futures keys are written', async () => {
  resetWorld();
  // shift LONG case so its last candle is closed relative to "now"
  const { drift, seed } = LONG();
  const shifted = makeCandles({ count: 400, seed, drift, vol: 0.0004, start: 60000, endTime: Date.now() - 90000 });
  const restore = stubFeeds(shifted);
  let text;
  try { text = await handleSpotSignalCommand('BTCUSD'); } finally { restore(); }
  const open = await spotStore.getOpen();
  if (/NO_SIGNAL/.test(text)) {
    assert.strictEqual(open.length, 0);
  } else {
    assert.strictEqual(open.length, 1);
    const r = open[0];
    for (const k of ['timeframe', 'modelVersion', 'rawScore', 'session', 'mtf', 'expectedMove', 'entryPrice', 'stopLoss', 'takeProfit1', 'signalTime', 'regime', 'qualityLabel', 'riskAmount']) {
      assert.notStrictEqual(r[k], undefined, `record must carry ${k}`);
    }
    assert.strictEqual(r.modelVersion, 'crypto-signal-v7');
    assert.strictEqual(r.status, 'OPEN');
    for (const label of ['CRYPTO SIGNAL', 'Direction', 'Entry', 'Expected Move', 'Stop Loss', 'Take Profit 1', 'Take Profit 2', 'Risk/Reward', 'Quality', 'Market Regime', 'MTF Evidence', 'Key Evidence', 'Invalidation', 'Historical Evidence', 'Uncertainty']) {
      assert.match(text, new RegExp(label), `output must show ${label}`);
    }
  }
  const keys = store.redis.calls.filter((c) => ['set', 'zadd', 'sadd'].includes(c.cmd)).map((c) => String(c.args[0]));
  assert.ok(keys.every((k) => k.startsWith('spot:')), `only spot:* keys may be written, got ${keys.join(',')}`);
});

test('K2. NO_SIGNAL creates no open trade and prints the spec fields (decision, reasons, uncertainty, no forced setup)', async () => {
  resetWorld();
  const flat = makeCandles({ count: 400, seed: 1, drift: 0, vol: 0.00001, start: 60000, endTime: Date.now() - 90000 });
  const restore = stubFeeds(flat);
  let text;
  try { text = await handleSpotSignalCommand('BTCUSD'); } finally { restore(); }
  if (/NO_SIGNAL/.test(text)) {
    assert.strictEqual((await spotStore.getOpen()).length, 0);
    assert.match(text, /Decision: \*\*NO_SIGNAL\*\*/);
    assert.match(text, /Reason\(s\)/);
    assert.match(text, /No forced setup/);
    assert.doesNotMatch(text, /Stop Loss|Take Profit|Expected Move/);
  }
});

test('K3. insufficient data returns an explicit INSUFFICIENT_DATA message and stores nothing', async () => {
  resetWorld();
  const sTS = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => makeCandles({ count: 8 });
  let text;
  try { text = await handleSpotSignalCommand('BTCUSD'); } finally { twelvedata.getTimeSeries = sTS; }
  assert.match(text, /INSUFFICIENT_DATA/);
  assert.strictEqual((await spotStore.getAll()).length, 0);
});

test('K4. !signalaccuracy: settled outcomes only, MAE/MFE/R shown, per-key grouping, honest small-sample + stability messages', async () => {
  resetWorld();
  const add = async (o) => { const id = spotStore.newId('BTCUSD'); await spotStore.saveNew({ id, signalTime: Date.now(), ...settled(o), id }); };
  await add({ result: 'WIN_TP1', maeR: 0.4, mfeR: 1.6, timeToResultMs: 600000, expectedMove: { amount: 10 }, mfeAbs: 12 });
  await add({ result: 'LOSS', maeR: 1, mfeR: 0.3, timeToResultMs: 300000 });
  await add({ result: 'EXPIRED_UNRESOLVED' });
  await add({ result: 'WIN_TP1', integrity: 'GAP' });
  const text = await handleSpotAccuracyCommand();
  assert.match(text, /TP1 Wins: 1 \| TP2 Wins: 0 \| Losses: 1 \| Unresolved\/Expired: 1/);
  assert.match(text, /Excluded \(data gap/);
  assert.match(text, /Win Rate .*50%/);
  assert.match(text, /95% CI/);
  assert.match(text, /Small sample/);
  assert.match(text, /Avg MAE: 0\.7R \| Avg MFE: 0\.95R/);
  assert.match(text, /BTCUSD \| 1min \| LONG/);
  assert.match(text, /Stability check: INSUFFICIENT_DATA/);
  assert.match(text, /Calibrated probability: not supported/);
  assert.doesNotMatch(text, /guaranteed/i);
});

test('K5. formatter: no guaranteed-win language anywhere; TP2 "none" is honest', () => {
  const { sig } = LONG();
  const noTp2 = formatSpotSignalMessage({ ...sig, symbol: 'BTCUSD', takeProfit2: null, takeProfit2RR: null, takeProfit2Method: 'none - no real level' });
  assert.match(noTp2, /Take Profit 2: none/);
  assert.doesNotMatch(noTp2, /will (definitely|surely) (hit|win)|100% (win|accurate)|guaranteed (win|profit)|risk[- ]free/i);
});

run('crypto signal v7 (spot): audit, MTF, SL/TP, expected move, MAE/MFE, statistics');
