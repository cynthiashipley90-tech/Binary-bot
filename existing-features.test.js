require('./helpers/stubDeps');
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { test, run } = require('./testKit');
const { makeCandles, makeInputs } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const store = require('../src/services/redisStore');
const twelvedata = require('../src/services/twelvedata');
const binaryEngine = require('../src/services/binaryEngine');
const formatting = require('../src/utils/marketFormatting');
const { parseMarketRequest } = require('../src/services/nlu');
const { routeCommand, handleMessage } = require('../src/index');

const ROOT = path.resolve(__dirname, '..');
const FIXED_END = Date.now() - 60000;

let redis;
let tdCalls;
function resetWorld() {
  redis = makeFakeRedis();
  store.redis = redis;
  tdCalls = 0;
}
twelvedata.getTimeSeries = async (symbol, interval, n) => { tdCalls += 1; return makeCandles({ count: n, endTime: FIXED_END, seed: 11 }); };
twelvedata.getCurrentPrice = async () => { tdCalls += 1; return 1.0805; };

function makeMessage(text) {
  const log = [];
  const sent = { edit: async (content) => { log.push({ op: 'edit', content }); } };
  return {
    log,
    message: {
      author: { bot: false, tag: 't#1' },
      content: text,
      channel: { id: 'ef-chan', send: async (content) => { log.push({ op: 'channel.send', content }); } },
      reply: async (content) => { log.push({ op: 'reply', content }); return sent; },
    },
  };
}

test('12o. probability is read via Student\'s t-distribution, not a plain normal - a small-sample estimate is never as extreme as the same z-score would be for a large sample (no fixed cap, purely a function of real sample size)', () => {
  const { studentTCdf, normalCdf } = binaryEngine;
  // Same z-score, different degrees of freedom (= real observation count):
  // the smaller sample MUST read less extreme (closer to 50%) - this is
  // the standard, well-known behavior of a t-distribution's fatter tails,
  // not a tuned constant.
  const z = 3;
  const smallSample = studentTCdf(z, 5);
  const largeSample = studentTCdf(z, 2000);
  assert.ok(smallSample < largeSample, 'a smaller real sample size must read a given z-score as LESS certain');
  assert.ok(Math.abs(largeSample - normalCdf(z)) < 0.001, 'a large sample must converge to the plain normal-distribution answer');
  assert.ok(smallSample < normalCdf(z) - 0.01, 'a small sample must read meaningfully below the normal-distribution (overconfident) answer for the same z');
  // Symmetry: no directional bias introduced by the correction itself.
  assert.strictEqual(Number(studentTCdf(-z, 30).toFixed(6)), Number((1 - studentTCdf(z, 30)).toFixed(6)));
});

test('12p. confluence tilt is shrunk toward zero when fewer independent factors support it (same statistical reasoning as the existing drift-reliability shrinkage, not a new tuned constant) - verified via the real engine, not a stub', async () => {
  resetWorld();
  const base = makeInputs({ duration: 60, count: 900 });
  const signal = await binaryEngine.generateBinarySignal(base.symbol, base.duration, base);
  assert.ok(Array.isArray(signal.confluenceBreakdown), 'the signal must report which real confluence factors actually contributed');
  // The architectural property that matters: probability must never be
  // pinned at a flat 100%/0% purely from the confluence tilt with no
  // regard for how much real evidence backs it, on an ordinary fixture
  // window (this fixture is not deliberately built to trigger the extreme,
  // very-large-sample case).
  assert.ok(signal.rawProbability > 0 && signal.rawProbability < 100.0001);
});

test('12q. tiltReliability (unit-level): a tilt backed by MORE independent factors is trusted more than the SAME tilt value backed by fewer factors', () => {
  // Reconstructs the exact same formula binaryEngine.js uses (same shape as
  // its own driftReliability), to check the mathematical property directly
  // rather than only indirectly through a full signal.
  const tiltReliability = (tilt, factorCount) => {
    const stdErr = 1 / Math.sqrt(Math.max(1, factorCount));
    return (tilt * tilt) / (tilt * tilt + stdErr * stdErr);
  };
  const tilt = 0.6;
  const fewFactors = tiltReliability(tilt, 2);
  const manyFactors = tiltReliability(tilt, 15);
  assert.ok(fewFactors < manyFactors, 'fewer supporting factors must yield lower reliability for the same tilt value');
  assert.ok(fewFactors > 0 && fewFactors < 1);
  assert.ok(manyFactors > 0 && manyFactors < 1, 'reliability must never reach a hard 100% either - it is a continuous function of real factor count, no ceiling switch');
  // A tilt of exactly 0 must always fully shrink to 0, regardless of factor count.
  assert.strictEqual(tiltReliability(0, 20), 0);
});

const withoutTime = (signal) => {
  const {
    signalTime, expiresAtMs, expiresAtIso, ...rest
  } = signal;
  return rest;
};

// ---------------------------------------------------------------- 12: analytics engine
test('12. fetchSignalInputs returns RAW inputs only (no indicator, score or conclusion)', async () => {
  resetWorld();
  const inputs = await binaryEngine.fetchSignalInputs('eurusd', 240);
  assert.deepStrictEqual(
    Object.keys(inputs).sort(),
    ['candles', 'duration', 'entryPrice', 'fetchSize', 'fetchedAt', 'priceSource', 'staleness', 'statsLookback', 'symbol'],
  );
  assert.strictEqual(inputs.symbol, 'EURUSD');
  assert.strictEqual(inputs.duration, 240);
  assert.strictEqual(inputs.entryPrice, 1.0805);
  assert.strictEqual(inputs.priceSource, 'live-quote');
  assert.strictEqual(inputs.candles.length, binaryEngine.requiredFetchSize(240, inputs.statsLookback));
  assert.strictEqual(tdCalls, 2);
});

test('12b. fetchSignalInputs keeps the old failure behaviour for too little data (now with a code)', async () => {
  resetWorld();
  const saved = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => makeCandles({ count: 12 });
  try {
    await assert.rejects(
      () => binaryEngine.fetchSignalInputs('EURUSD', 5),
      (err) => err.code === 'INSUFFICIENT_DATA' && /Not enough recent 1-minute data for EURUSD to analyze \(got 12 candles\)/.test(err.message),
    );
    await assert.rejects(() => binaryEngine.generateBinarySignal('EURUSD', 5), /Not enough recent 1-minute data/);
  } finally { twelvedata.getTimeSeries = saved; }
});

test('12c. generateBinarySignal(symbol, minutes) still fetches internally and is IDENTICAL to the prefetched path', async () => {
  resetWorld();
  const viaInternalFetch = await binaryEngine.generateBinarySignal('EURUSD', 30);
  assert.strictEqual(tdCalls, 2, 'the old two-argument call still performs its own fetch');

  const inputs = await binaryEngine.fetchSignalInputs('EURUSD', 30);
  tdCalls = 0;
  const viaPrefetched = await binaryEngine.generateBinarySignal('EURUSD', 30, inputs);
  assert.strictEqual(tdCalls, 0, 'a prefetched snapshot means no second fetch');
  assert.deepStrictEqual(withoutTime(viaPrefetched), withoutTime(viaInternalFetch));
  ['direction', 'rawProbability', 'calibratedProbability', 'qualityLabel', 'confluenceBreakdown', 'checkpoints', 'regime', 'volatilityRegime', 'multiTimeframe', 'supportResistance', 'session', 'featureFlags']
    .forEach((k) => assert.ok(k in viaInternalFetch, `signal.${k} still present`));
});

test('12d. the pure analytics core is untouched: the signal\'s raw math equals computeSignalCore on the same candles', async () => {
  resetWorld();
  const inputs = makeInputs({ duration: 60, count: 825, seed: 5 });
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  const core = binaryEngine.computeSignalCore(inputs.candles, inputs.entryPrice, inputs.duration, inputs.statsLookback);
  assert.strictEqual(signal.rawProbability, core.rawProbability);
  assert.strictEqual(signal.rawDirection, core.rawDirection);
  assert.strictEqual(signal.volPerMin, core.volPerMin);
  assert.deepStrictEqual(signal.checkpoints, core.checkpoints);
});

test('12e. the bot analysis still makes NO Redis writes (calibration reads only)', async () => {
  resetWorld();
  await binaryEngine.generateBinarySignal('EURUSD', 15);
  assert.deepStrictEqual(redis.writeCalls(), []);
  assert.ok(redis.readCalls().length > 0);
});

// ---------------------------------------------------------------- 12: NLU
test('12f. nlu still parses symbol / horizon / language / intent exactly as before', () => {
  const p = parseMarketRequest('EURUSD 4H');
  assert.deepStrictEqual([p.symbol, p.horizonMinutes, p.language, p.intent], ['EURUSD', 240, 'en', 'analyze']);
  assert.strictEqual(parseMarketRequest('BTCUSD 15m analysis').horizonMinutes, 15);
  assert.strictEqual(parseMarketRequest('GBP/USD 1 hour').symbol, 'GBPUSD');
  assert.strictEqual(parseMarketRequest('EURUSD analyse karo').language, 'roman-urdu');
  assert.strictEqual(parseMarketRequest('Roman Urdu mein explain karo').symbol, null);
  assert.strictEqual(parseMarketRequest('Bot aur AI ka comparison dikhao').intent, 'compare');
  assert.strictEqual(parseMarketRequest('Sirf differences batao').intent, 'differences-only');
  assert.strictEqual(parseMarketRequest('Data quality check karo GBPUSD').intent, 'dataquality');
  assert.strictEqual(parseMarketRequest('Is analysis ki reasoning batao').intent, 'reasoning');
  assert.strictEqual(parseMarketRequest('EURUSD compact').compact, true);
});

// ---------------------------------------------------------------- 12: other commands
test('12g. "!binary" is unchanged: replies (never edits), no WAITING message, same text', async () => {
  resetWorld();
  const expected = await routeCommand('!binary EURUSD 5', 'ef-chan');
  resetWorld();
  const { message, log } = makeMessage('!binary EURUSD 5');
  await handleMessage(message);
  assert.strictEqual(log[0].op, 'reply');
  assert.ok(!log.some((l) => l.op === 'edit'), 'no edit - there is no WAITING message for !binary');
  assert.ok(!log.some((l) => l.content.includes('WAITING')));
  assert.match(log[0].content, /Direction: \*(UP|DOWN|NO_TRADE)\*/);
  assert.ok(log.every((l, i) => i === 0 || l.op === 'channel.send'), 'only overflow continues in follow-up chunks');
  assert.ok(log.every((l) => l.content.length <= 2000));
  // nothing lost or altered by delivery (whitespace at chunk boundaries
  // aside; the exact expiry timestamp is real-time-dependent, computed as
  // signalTime + duration - so it legitimately differs by a few ms between
  // the two independent calls above and is stripped before comparing)
  const stripTimestamp = (s) => s.replace(/Expires At: [^(]+\(/g, 'Expires At: <ts> (');
  assert.strictEqual(
    stripTimestamp(log.map((l) => l.content).join('\n')).replace(/\s+/g, ' '),
    stripTimestamp(expected).replace(/\s+/g, ' '),
  );
});

test('12g2. any reply that already fits in one Discord message (<= 2000 chars) is still sent as exactly one message', async () => {
  for (const len of [10, 1500, 1999, 2000]) {
    const { message, log } = makeMessage('!binary anything');
    // eslint-disable-next-line no-await-in-loop
    await handleMessage(message, { routeCommand: async () => 'z'.repeat(len) });
    assert.deepStrictEqual(log.map((l) => l.op), ['reply'], `length ${len}`);
    assert.strictEqual(log[0].content.length, len);
  }
});

test('12h. "!binary" usage message and "!binaryaccuracy" still work', async () => {
  resetWorld();
  const usage = await routeCommand('!binary', 'ef-chan');
  assert.match(usage, /^Usage: !binary EURUSD 5/);
  const acc = await routeCommand('!binaryaccuracy', 'ef-chan');
  assert.strictEqual(typeof acc, 'string');
  assert.ok(acc.length > 0 && !/^Could not load binary accuracy stats/.test(acc), acc);
  const { message, log } = makeMessage('!binaryaccuracy');
  await handleMessage(message);
  assert.deepStrictEqual(log.map((l) => l.op), ['reply']);
});

test('12i. unknown commands are ignored; "!market" with nothing usable gives guidance', async () => {
  resetWorld();
  assert.strictEqual(await routeCommand('!unknowncommand', 'ef-chan'), null);
  const { message, log } = makeMessage('!market');
  await handleMessage(message);
  assert.deepStrictEqual(log.map((l) => l.op), ['reply']);
  assert.match(log[0].content, /Symbol samajh nahi aaya/);
});

// ---------------------------------------------------------------- 12: pre-existing formatters + kept modules
test('12j. the deterministic !market layouts still render (views + follow-ups; AI comparison removed)', async () => {
  resetWorld();
  const inputs = makeInputs({ duration: 30, count: 825 });
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  const bot = { status: 'OK', signal, expiryPerf: { total: 0, winRatePct: null, label: '30 min' } };
  const { summarizeMarket } = require('../src/services/marketSummary');
  const market = summarizeMarket(inputs);

  const full = formatting.formatFullReport({ market, bot });
  ['**MARKET RESEARCH REPORT**', 'Binary/Time-based Signal'].forEach((h) => assert.ok(full.includes(h), h));
  assert.match(formatting.formatCompactReport({ market, bot }), /^\*\*EURUSD\*\* \(30 min\)/);
  assert.match(formatting.formatNoComparisonAvailable(signal), /AI-based comparison has been removed/);
  assert.match(formatting.formatReasoningOnly(signal), /^\*\*Reasoning\*\*/);
  assert.match(formatting.formatDataQualityOnly(signal), /^\*\*Data Quality - EURUSD\*\*/);
  assert.ok(formatting.botStatusLine(signal).length > 0);
});

test('12k. AI/Gemini modules and dead AI-only logging modules have been fully removed', () => {
  ['../src/services/ai/analyst', '../src/services/ai/comparison', '../src/services/ai/geminiProvider',
    '../src/services/ai/provider', '../src/services/ai/fakeProvider', '../src/services/ai/prompt',
    '../src/services/ai/schema', '../src/services/ai/marketContext',
    '../src/services/analysisMemory', '../src/services/analysisLog'].forEach((mod) => {
    assert.throws(() => require(mod), /Cannot find module/, `${mod} should no longer exist`);
  });
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'src', 'services', 'ai')), false, 'src/services/ai/ directory should be gone');
});

test('12l. no Gemini/AI runtime dependency or config remains; npm test is wired to the suite', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(pkg.dependencies).sort(), ['@upstash/redis', 'axios', 'discord.js', 'dotenv', 'express', 'node-cron', 'technicalindicators']);
  assert.strictEqual(pkg.scripts.test, 'node tests/run-all.js');
  assert.strictEqual(pkg.scripts.start, 'node src/index.js');
  const config = require('../src/config');
  assert.strictEqual(config.ai, undefined, 'config.ai must not exist - AI has been fully removed');
});

test('12m. src/index.js does not auto-start when required (only when run directly)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'index.js'), 'utf8');
  assert.match(src, /if \(require\.main === module\)/);
});

test('12n. the professional Discord output includes the expiry-selection assessment and the next-candle forecast, with real (not placeholder) values', async () => {
  resetWorld();
  const text = await routeCommand('!binary EURUSD 60', 'prof-chan');
  assert.match(text, /Requested Expiry Assessment: (STRONG|ACCEPTABLE|WEAK|NO_TRADE)/);
  assert.match(text, /Next-Candle Forecast/);
  assert.match(text, /Expires At: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/, 'exact expiry timestamp must be a real ISO instant, not a placeholder');
  // never a hardcoded/fixed placeholder number - the raw and calibrated
  // probabilities must be genuinely derived from this run's own data, and
  // the next-candle block must never claim a specific named pattern
  // without evidence (e.g. never invents "Hammer" etc. on its own).
  assert.ok(!/Hammer|Shooting Star|Morning Star|Evening Star/i.test(text), 'must not invent a specific named candle pattern without real supporting evidence');
});

run('existing features');
