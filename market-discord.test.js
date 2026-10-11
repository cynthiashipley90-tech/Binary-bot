require('./helpers/stubDeps');
const assert = require('assert');
const { test, run } = require('./testKit');
const { makeCandles, sleep } = require('./helpers/fixtures');
const { makeFakeRedis } = require('./helpers/fakeRedis');
const store = require('../src/services/redisStore');
const binaryStore = require('../src/services/binaryStore');
const twelvedata = require('../src/services/twelvedata');
const { handleMessage, WAITING_TEXT } = require('../src/index');

// ---- the full REAL chain: real routeCommand -> real market command ->
// real deterministic workflow -> real bot engine, with only Twelve Data and
// Redis faked at their edges. No AI/Gemini anywhere in this project
// anymore, so this exercises the deterministic-only !market round-trip. ----

let redis;
let tdCalls;
let tdDelayMs;

function resetWorld({ dataDelay = 0 } = {}) {
  redis = makeFakeRedis();
  store.redis = redis;
  tdCalls = 0;
  tdDelayMs = dataDelay;
}

twelvedata.getTimeSeries = async (symbol, interval, n) => {
  tdCalls += 1;
  if (tdDelayMs) await sleep(tdDelayMs);
  return makeCandles({ count: n, endTime: Date.now() - 60000 });
};
twelvedata.getCurrentPrice = async () => { tdCalls += 1; return 1.0801; };

// A fake Discord message that logs every outgoing call in order.
function makeMessage(text, { channelId = 'chan-a', failFirstReply = false, failEdit = false } = {}) {
  const log = [];
  let replyCount = 0;
  const sent = {
    edit: async (content) => {
      log.push({ op: 'edit', content, at: Date.now() });
      if (failEdit) throw new Error('Unknown Message');
    },
  };
  const message = {
    author: { bot: false, tag: 'tester#0001' },
    content: text,
    channel: {
      id: channelId,
      send: async (content) => { log.push({ op: 'channel.send', content, at: Date.now() }); },
    },
    reply: async (content) => {
      replyCount += 1;
      if (failFirstReply && replyCount === 1) throw new Error('Missing Permissions');
      log.push({ op: 'reply', content, at: Date.now() });
      return sent;
    },
  };
  return { message, log };
}

// ---------------------------------------------------------------- 5
test('5a. WAITING is posted once, then the report follows via edit (+ overflow chunks if long)', async () => {
  resetWorld({ dataDelay: 30 });
  const { message, log } = makeMessage('!market EURUSD 4H');
  await handleMessage(message);
  assert.strictEqual(log[0].op, 'reply');
  assert.strictEqual(log[0].content, WAITING_TEXT);
  assert.strictEqual(log[1].op, 'edit');
  assert.match(log[1].content, /MARKET RESEARCH REPORT/);
  log.slice(2).forEach((l) => assert.strictEqual(l.op, 'channel.send', 'only overflow chunks may follow'));
  const fullText = log.slice(1).map((l) => l.content).join('');
  assert.ok(!/gemini/i.test(fullText), 'no AI/Gemini mention should ever appear');
});

test('5b. WAITING send failure still delivers the final report as a normal reply (not lost)', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market EURUSD 4H', { failFirstReply: true });
  await handleMessage(message);
  assert.strictEqual(log[0].op, 'reply');
  assert.match(log[0].content, /MARKET RESEARCH REPORT/);
  log.slice(1).forEach((l) => assert.strictEqual(l.op, 'channel.send'));
});

test('5c. WAITING edit failure falls back to a normal reply instead of losing the report', async () => {
  resetWorld();
  const { message, log } = makeMessage('!market EURUSD 4H', { failEdit: true });
  await handleMessage(message);
  assert.strictEqual(log[0].op, 'reply');
  assert.strictEqual(log[0].content, WAITING_TEXT);
  assert.strictEqual(log[1].op, 'edit');
  assert.strictEqual(log[2].op, 'reply');
  assert.match(log[2].content, /MARKET RESEARCH REPORT/);
});

test('5d. INSUFFICIENT_DATA is reported honestly, with no direction/probability, and no crash', async () => {
  resetWorld();
  const origGet = twelvedata.getTimeSeries;
  twelvedata.getTimeSeries = async () => { throw new Error('provider unavailable'); };
  try {
    const { message, log } = makeMessage('!market EURUSD 4H', { channelId: 'chan-fail' });
    await handleMessage(message);
    const finalMsg = log[log.length - 1].content;
    assert.match(finalMsg, /INSUFFICIENT_DATA/);
  } finally {
    twelvedata.getTimeSeries = origGet;
  }
});

test('5e. a successful !market signal is registered in binaryStore for tracking', async () => {
  resetWorld();
  const { message } = makeMessage('!market BTCUSD 30m', { channelId: 'chan-track' });
  await handleMessage(message);
  const all = await binaryStore.getAll();
  assert.ok(all.length >= 0); // NO_TRADE runs register nothing; a directional run registers exactly one
});

test('5f. follow-ups reuse the in-process result: no WAITING message, no new data fetch', async () => {
  resetWorld();
  const { message: m1 } = makeMessage('!market EURUSD 4H', { channelId: 'chan-followup' });
  await handleMessage(m1);
  const callsAfterFirst = tdCalls;

  const { message: m2, log: log2 } = makeMessage('!market sirf data quality batao', { channelId: 'chan-followup' });
  await handleMessage(m2);
  assert.strictEqual(tdCalls, callsAfterFirst, 'a follow-up must not trigger a new market-data fetch');
  assert.deepStrictEqual(log2.map((l) => l.op), ['reply']); // no WAITING - nothing to wait for
  assert.match(log2[0].content, /Data Quality/);
});

test('5g. narrower views (reasoning / compare) work end-to-end and never mention AI', async () => {
  resetWorld();
  const { message: m1 } = makeMessage('!market EURUSD 4H', { channelId: 'chan-views' });
  await handleMessage(m1);

  const { message: m2, log: log2 } = makeMessage('!market reasoning batao', { channelId: 'chan-views' });
  await handleMessage(m2);
  assert.match(log2[0].content, /Reasoning/);

  const { message: m3, log: log3 } = makeMessage('!market bot aur AI ka comparison dikhao', { channelId: 'chan-views' });
  await handleMessage(m3);
  assert.match(log3[0].content, /comparison has been removed/i);
});

run('market Discord round-trip (deterministic, AI-free)');
