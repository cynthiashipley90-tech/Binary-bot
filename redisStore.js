const { Redis } = require('@upstash/redis');
const config = require('../config');

const redis = new Redis({
  url: config.redis.url,
  token: config.redis.token,
});

const KEYS = {
  signal: (id) => `signal:${id}`,
  allSignalsZset: 'signals:all', // sorted set, score = signalTime (ms)
  openSignalsSet: 'signals:open',
  filterPerf: (category) => `filterperf:${category}`,
  // Extended-invalidation ("structural SL") post-mortem tracking.
  postmortem: (id) => `postmortem:${id}`,
  postmortemPendingSet: 'postmortem:pending',
  invalidationStats: (pair, direction, checkpointLabel) =>
    `invalidation:${pair}:${direction}:${checkpointLabel}`,
};

function newSignalId(pair) {
  return `${pair}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

async function saveNewSignal(signal) {
  await redis.set(KEYS.signal(signal.id), JSON.stringify(signal));
  await redis.zadd(KEYS.allSignalsZset, { score: signal.signalTime, member: signal.id });
  await redis.sadd(KEYS.openSignalsSet, signal.id);
  return signal;
}

async function getSignal(id) {
  const raw = await redis.get(KEYS.signal(id));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function updateSignal(id, patch) {
  const existing = await getSignal(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await redis.set(KEYS.signal(id), JSON.stringify(updated));
  return updated;
}

async function closeSignal(id, patch) {
  const updated = await updateSignal(id, patch);
  await redis.srem(KEYS.openSignalsSet, id);
  return updated;
}

async function getOpenSignalIds() {
  return redis.smembers(KEYS.openSignalsSet);
}

async function getOpenSignals() {
  const ids = await getOpenSignalIds();
  if (!ids.length) return [];
  const signals = await Promise.all(ids.map(getSignal));
  return signals.filter(Boolean);
}

// Duplicate-signal protection: is there already an OPEN signal for this
// exact pair + direction that hasn't completed, expired, or been
// invalidated yet? Used to block re-issuing the same call while one is
// still live.
async function getActiveSignal(pair, direction) {
  const open = await getOpenSignals();
  return open.find((s) => s.pair === pair && s.direction === direction) || null;
}

async function getRecentSignalIds(limit = 20) {
  // highest score (most recent) first
  return redis.zrange(KEYS.allSignalsZset, 0, limit - 1, { rev: true });
}

async function getRecentSignals(limit = 20) {
  const ids = await getRecentSignalIds(limit);
  if (!ids.length) return [];
  const signals = await Promise.all(ids.map(getSignal));
  return signals.filter(Boolean);
}

async function getAllSignalIds() {
  return redis.zrange(KEYS.allSignalsZset, 0, -1);
}

async function getAllSignals() {
  const ids = await getAllSignalIds();
  if (!ids.length) return [];
  const signals = await Promise.all(ids.map(getSignal));
  return signals.filter(Boolean);
}

// ---- Adaptive filter performance ----
// Tracks, per scoring category, how often it was on the winning side of a
// closed trade. Used to nudge that category's weight up/down over time -
// bounded so no single category can dominate or be zeroed out entirely.
async function recordFilterOutcome(category, won) {
  const key = KEYS.filterPerf(category);
  const raw = await redis.get(key);
  const perf = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { samples: 0, wins: 0 };
  perf.samples += 1;
  if (won) perf.wins += 1;
  await redis.set(key, JSON.stringify(perf));
  return perf;
}

async function getFilterPerformance(category) {
  const raw = await redis.get(KEYS.filterPerf(category));
  const perf = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { samples: 0, wins: 0 };
  const winRate = perf.samples > 0 ? perf.wins / perf.samples : 0.5;
  // Multiplier bounded to [0.6, 1.4] around neutral 1.0 - a filter that wins
  // more than baseline gets amplified slightly, one that underperforms gets
  // dampened, but nothing is ever fully switched off.
  const multiplier = Math.min(1.4, Math.max(0.6, 0.6 + winRate * 0.8));
  return { ...perf, winRate, multiplier };
}

async function getAllFilterPerformance(categories) {
  const entries = await Promise.all(
    categories.map(async (c) => [c, await getFilterPerformance(c)])
  );
  return Object.fromEntries(entries);
}

// ---- Extended invalidation ("structural SL") post-mortem tracking ----
// Created whenever a signal closes via SL_HIT with a structural extended
// level attached. Tracks, per fixed checkpoint, whether price came back to
// the reference (pre-SL) price - purely observational, never influences a
// live signal's direction, only builds up real historical odds over time.
async function createPostmortem(record) {
  await redis.set(KEYS.postmortem(record.id), JSON.stringify(record));
  await redis.sadd(KEYS.postmortemPendingSet, record.id);
  return record;
}

async function getPostmortem(id) {
  const raw = await redis.get(KEYS.postmortem(id));
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function updatePostmortem(id, patch) {
  const existing = await getPostmortem(id);
  if (!existing) return null;
  const updated = { ...existing, ...patch };
  await redis.set(KEYS.postmortem(id), JSON.stringify(updated));
  return updated;
}

async function removePostmortemFromPending(id) {
  await redis.srem(KEYS.postmortemPendingSet, id);
}

async function getPendingPostmortemIds() {
  return redis.smembers(KEYS.postmortemPendingSet);
}

async function recordInvalidationCheckpoint(pair, direction, checkpointLabel, recovered) {
  const key = KEYS.invalidationStats(pair, direction, checkpointLabel);
  const raw = await redis.get(key);
  const stats = raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { recovered: 0, total: 0 };
  stats.total += 1;
  if (recovered) stats.recovered += 1;
  await redis.set(key, JSON.stringify(stats));
  return stats;
}

async function getInvalidationStats(pair, direction, checkpointLabel) {
  const raw = await redis.get(KEYS.invalidationStats(pair, direction, checkpointLabel));
  return raw ? (typeof raw === 'string' ? JSON.parse(raw) : raw) : { recovered: 0, total: 0 };
}

module.exports = {
  redis,
  newSignalId,
  saveNewSignal,
  getSignal,
  updateSignal,
  closeSignal,
  getOpenSignalIds,
  getOpenSignals,
  getActiveSignal,
  getRecentSignals,
  getAllSignals,
  recordFilterOutcome,
  getFilterPerformance,
  getAllFilterPerformance,
  createPostmortem,
  getPostmortem,
  updatePostmortem,
  removePostmortemFromPending,
  getPendingPostmortemIds,
  recordInvalidationCheckpoint,
  getInvalidationStats,
};
