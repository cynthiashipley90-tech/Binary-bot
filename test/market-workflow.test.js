require('./helpers/stubDeps');
const assert = require('assert');
const { test, run } = require('./testKit');
const { makeCandles, makeInputs, deferred } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const store = require('../src/services/redisStore');
const binaryEngine = require('../src/services/binaryEngine');
const { runMarketWorkflow } = require('../src/services/marketWorkflow');
const { handleMarketCommand } = require('../src/commands/market');
const formatting = require('../src/utils/marketFormatting');

store.redis = makeFakeRedis();

const REQUEST = { symbol: 'EURUSD', horizonMinutes: 240, language: 'en' };

function runWf({ deps = {}, timeoutMs = 5000, inputs = makeInputs(), request = REQUEST } = {}) {
  return runMarketWorkflow(request, {
    timeoutMs,
    deps: { fetchInputs: async () => inputs, ...deps },
  });
}

async function realBot(inputs) {
  const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
  return {
    status: 'OK', signal, expiryPerf: null, reason: null, latencyMs: 1,
  };
}

test('1. a clean data fetch + a healthy bot produces a REPORT outcome with the real deterministic signal', async () => {
  const result = await runWf({ deps: { runBot: realBot } });
  assert.strictEqual(result.outcome, 'REPORT');
  assert.ok(result.market);
  assert.strictEqual(result.market.symbol, 'EURUSD');
  assert.strictEqual(result.bot.status, 'OK');
  assert.ok(['UP', 'DOWN', 'NO_TRADE'].includes(result.bot.signal.direction));
  assert.ok(Array.isArray(result.limitations));
});

test('2. bad/insufficient market data short-circuits to INSUFFICIENT_DATA before the bot ever runs', async () => {
  let botCalled = false;
  const err = new Error('too few candles');
  err.code = 'INSUFFICIENT_DATA';
  const result = await runWf({
    deps: {
      fetchInputs: async () => { throw err; },
      runBot: async () => { botCalled = true; },
    },
  });
  assert.strictEqual(result.outcome, 'INSUFFICIENT_DATA');
  assert.strictEqual(result.reasonCode, 'TOO_FEW_CANDLES');
  assert.strictEqual(botCalled, false);
});

test('3. candles that fail structural validation (e.g. empty/insufficient series) also yield INSUFFICIENT_DATA', async () => {
  const badInputs = { ...makeInputs(), candles: [] };
  const result = await runWf({ inputs: badInputs });
  assert.strictEqual(result.outcome, 'INSUFFICIENT_DATA');
  assert.strictEqual(result.reasonCode, 'INVALID_DATA');
});

test('4. a deadline that fires before the data fetch resolves reports TIMEOUT, not a hang', async () => {
  const { promise } = deferred(); // never resolves
  const result = await runWf({ timeoutMs: 20, deps: { fetchInputs: async () => promise } });
  assert.strictEqual(result.outcome, 'TIMEOUT');
  assert.strictEqual(result.reasonCode, 'DATA_TIMEOUT');
});

test('5. a bot branch that throws is reported as ERROR, with the market summary still attached', async () => {
  const result = await runWf({ deps: { runBot: async () => { throw new Error('boom'); } } });
  assert.strictEqual(result.outcome, 'ERROR');
  assert.strictEqual(result.reasonCode, 'BOT_FAILED');
  assert.ok(result.market, 'market summary should still be produced even though the bot failed');
});

test('6. runMarketWorkflow never throws, even on an internal bug', async () => {
  const result = await runMarketWorkflow(REQUEST, {
    deps: { fetchInputs: () => { throw new TypeError('unexpected sync throw'); } },
  });
  assert.ok(['INSUFFICIENT_DATA', 'ERROR'].includes(result.outcome));
});

test('7. renderWorkflowResult dispatches every outcome to distinct, non-empty text', async () => {
  const report = await runWf({ deps: { runBot: realBot } });
  const text = formatting.renderWorkflowResult(report, { intent: 'analyze' });
  assert.match(text, /MARKET RESEARCH REPORT/);

  const compactText = formatting.renderWorkflowResult(report, { intent: 'analyze', compact: true });
  assert.ok(compactText.length > 0 && compactText.length < text.length);

  const insufficient = { outcome: 'INSUFFICIENT_DATA', request: REQUEST, reasonCode: 'TOO_FEW_CANDLES', reason: 'x' };
  assert.match(formatting.renderWorkflowResult(insufficient), /INSUFFICIENT_DATA/);

  const timeout = { outcome: 'TIMEOUT', request: REQUEST, totalMs: 5000, reason: 'slow' };
  assert.match(formatting.renderWorkflowResult(timeout), /TIMEOUT/);

  const error = { outcome: 'ERROR', request: REQUEST, reason: 'bad' };
  assert.match(formatting.renderWorkflowResult(error), /ANALYSIS FAILED/);
});

test('8. narrower intents (reasoning/dataquality/compare) render bot-only views with no AI mention', async () => {
  const report = await runWf({ deps: { runBot: realBot } });
  const reasoning = formatting.renderWorkflowResult(report, { intent: 'reasoning' });
  assert.match(reasoning, /Reasoning/);
  const dq = formatting.renderWorkflowResult(report, { intent: 'dataquality' });
  assert.match(dq, /Data Quality/);
  const compare = formatting.renderWorkflowResult(report, { intent: 'compare' });
  assert.match(compare, /comparison has been removed/i);
  [reasoning, dq, compare].forEach((t) => assert.ok(!/gemini/i.test(t), 'no AI/Gemini mention should remain'));
});

test('9. handleMarketCommand end-to-end: fresh analysis registers a tracked signal (when a direction was issued)', async () => {
  store.redis = makeFakeRedis();
  const text = await handleMarketCommand('chan-1', 'EURUSD 240m analyse karo', {}, {
    workflowOptions: { deps: { fetchInputs: async () => makeInputs({ duration: 240 }), runBot: realBot } },
  });
  assert.match(text, /MARKET RESEARCH REPORT/);
});

test('10. handleMarketCommand with no symbol and no prior memory gives guidance, not a crash', async () => {
  const text = await handleMarketCommand('chan-empty', 'kya haal hai', {}, {});
  assert.match(text, /Symbol samajh nahi aaya/);
});

run('market workflow (deterministic, AI-free)');
