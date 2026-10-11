// ---- In-memory Redis fake that RECORDS every command ----
// Replaces `require('../src/services/redisStore').redis` in tests. Reads
// behave like Upstash's REST client for the handful of commands the bot
// uses (get/set/zadd/zrange/sadd/smembers/srem). Every call is appended to
// `fake.calls` as { cmd, args } so tests can assert "no write commands
// happened" - that is how the "intermediate results are never persisted to
// Redis" requirement is verified.

const WRITE_COMMANDS = new Set(['set', 'zadd', 'sadd', 'srem', 'del', 'incr', 'incrby', 'expire', 'hset', 'lpush', 'rpush', 'setex', 'mset']);

function makeFakeRedis(seed = {}) {
  const kv = new Map(Object.entries(seed));
  const sets = new Map();
  const zsets = new Map();
  const calls = [];

  function record(cmd, args) {
    calls.push({ cmd, args });
  }

  const fake = {
    calls,
    async get(key) { record('get', [key]); return kv.has(key) ? kv.get(key) : null; },
    async set(key, value, opts) { record('set', [key, value, opts]); kv.set(key, value); return 'OK'; },
    async sadd(key, ...members) {
      record('sadd', [key, ...members]);
      if (!sets.has(key)) sets.set(key, new Set());
      members.forEach((m) => sets.get(key).add(m));
      return members.length;
    },
    async smembers(key) { record('smembers', [key]); return [...(sets.get(key) || [])]; },
    async srem(key, ...members) {
      record('srem', [key, ...members]);
      members.forEach((m) => sets.get(key)?.delete(m));
      return members.length;
    },
    async zadd(key, entry) {
      record('zadd', [key, entry]);
      if (!zsets.has(key)) zsets.set(key, []);
      zsets.get(key).push(entry);
      return 1;
    },
    async zrange(key, start, stop) {
      record('zrange', [key, start, stop]);
      const arr = (zsets.get(key) || []).slice().sort((a, b) => a.score - b.score).map((e) => e.member);
      const end = stop === -1 ? undefined : stop + 1;
      return arr.slice(start < 0 ? Math.max(0, arr.length + start) : start, end);
    },
    writeCalls() { return calls.filter((c) => WRITE_COMMANDS.has(c.cmd)); },
    readCalls() { return calls.filter((c) => !WRITE_COMMANDS.has(c.cmd)); },
    reset() { calls.length = 0; },
  };
  return fake;
}

module.exports = { makeFakeRedis, WRITE_COMMANDS };
