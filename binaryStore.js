const store = require('./redisStore'); // reuse the same Redis connection

const KEYS = {
  signal: (id) => `binary:signal:${id}`,
  allZset: 'binary:signals:all',
  openSet: 'binary:signals:open',
  checkpointPerf: (fracLabel) => `binary:checkpointperf:${fracLabel}`,
};

function newId(symbol) {
  return `${symbol.replace('/', '')}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function saveNew(signal) {
  await store.redis.set(KEYS.signal(signal.id), JSON.stringify(signal));
  await store.redis.zadd(KEYS.allZset, { score: signal.signalTime, member: signal.id });
  await store.redis.sadd(KEYS.openSet, signal.id);
  return signal;
}

async function get(id) {
  const raw = await store.redis.get(KEYS.signal(id));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function update(id, patch) {
  const existing = await get(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await store.redis.set(KEYS.signal(id), JSON.stringify(updated));
  return updated;
}

async function close(id, patch) {
  const updated = await update(id, patch);
  await store.redis.srem(KEYS.openSet, id);
  return updated;
}

async function getOpenIds() {
  return store.redis.smembers(KEYS.openSet);
}

async function getOpen() {
  const ids = await getOpenIds();
  if (!ids.length) return [];
  const signals = await Promise.all(ids.map(get));
  return signals.filter(Boolean);
}

async function getRecent(limit = 20) {
  const ids = await store.redis.zrange(KEYS.allZset, 0, limit - 1, { rev: true });
  if (!ids.length) return [];
  const signals = await Promise.all(ids.map(get));
  return signals.filter(Boolean);
}

async function getAll() {
  const ids = await store.redis.zrange(KEYS.allZset, 0, -1);
  if (!ids.length) return [];
  const signals = await Promise.all(ids.map(get));
  return signals.filter(Boolean);
}

async function recordCheckpointOutcome(fracLabel, correct) {
  const key = KEYS.checkpointPerf(fracLabel);
  const raw = await store.redis.get(key);
  const perf = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { correct: 0, total: 0 };
  perf.total += 1;
  if (correct) perf.correct += 1;
  await store.redis.set(key, JSON.stringify(perf));
  return perf;
}

async function getCheckpointPerf(fracLabel) {
  const raw = await store.redis.get(KEYS.checkpointPerf(fracLabel));
  return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { correct: 0, total: 0 };
}

module.exports = {
  newId,
  saveNew,
  get,
  update,
  close,
  getOpenIds,
  getOpen,
  getRecent,
  getAll,
  recordCheckpointOutcome,
  getCheckpointPerf,
};
  
