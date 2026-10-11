// ---- Test-only stand-ins for third-party packages ----
// `require('./helpers/stubDeps')` MUST be the first line of every test
// file. For each runtime dependency it checks whether the REAL package can
// be resolved from the project (i.e. `npm install` has been run) and, only
// if it can't, installs a minimal stand-in so the suite can still run in an
// offline / dependency-less sandbox. On a normal dev machine or CI after
// `npm install`, every real package is used and none of this code runs.
//
// The `technicalindicators` stand-in is a compact re-implementation of the
// seven indicators the engine uses (EMA/RSI/MACD/ATR/Stochastic/Bollinger/
// ADX). It exists ONLY so the engine's control flow can be exercised
// offline - it is not a substitute for the real library's numerics, and no
// test asserts specific indicator values.

const Module = require('module');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

function canResolveReal(name) {
  try {
    require.resolve(name, { paths: [PROJECT_ROOT] });
    return true;
  } catch (_) {
    return false;
  }
}

// ---------- technicalindicators stand-in ----------
function sma(values, period) {
  const out = [];
  for (let i = period - 1; i < values.length; i++) {
    let s = 0;
    for (let j = i - period + 1; j <= i; j++) s += values[j];
    out.push(s / period);
  }
  return out;
}

function emaCalc(values, period) {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function wilder(values, period) {
  if (values.length < period) return [];
  const out = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out.push(prev);
  }
  return out;
}

function makeTechnicalIndicatorsStub() {
  const EMA = { calculate: ({ period, values }) => emaCalc(values, period) };

  const RSI = {
    calculate: ({ period, values }) => {
      if (values.length <= period) return [];
      const gains = [];
      const losses = [];
      for (let i = 1; i < values.length; i++) {
        const d = values[i] - values[i - 1];
        gains.push(Math.max(0, d));
        losses.push(Math.max(0, -d));
      }
      const ag = wilder(gains, period);
      const al = wilder(losses, period);
      return ag.map((g, i) => (al[i] === 0 ? 100 : 100 - 100 / (1 + g / al[i])));
    },
  };

  const MACD = {
    calculate: ({ values, fastPeriod, slowPeriod, signalPeriod }) => {
      const fast = emaCalc(values, fastPeriod);
      const slow = emaCalc(values, slowPeriod);
      const offset = slow.length ? fast.length - slow.length : 0;
      const line = slow.map((s, i) => fast[i + offset] - s);
      const sig = emaCalc(line, signalPeriod);
      const sigOffset = line.length - sig.length;
      return line.map((m, i) => {
        const sv = i >= sigOffset ? sig[i - sigOffset] : undefined;
        return { MACD: m, signal: sv, histogram: sv === undefined ? undefined : m - sv };
      });
    },
  };

  function trueRanges(high, low, close) {
    const tr = [];
    for (let i = 1; i < high.length; i++) {
      tr.push(Math.max(high[i] - low[i], Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1])));
    }
    return tr;
  }

  const ATR = {
    calculate: ({ period, high, low, close }) => wilder(trueRanges(high, low, close), period),
  };

  const Stochastic = {
    calculate: ({ high, low, close, period, signalPeriod }) => {
      const k = [];
      for (let i = period - 1; i < close.length; i++) {
        const hh = Math.max(...high.slice(i - period + 1, i + 1));
        const ll = Math.min(...low.slice(i - period + 1, i + 1));
        k.push(hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100);
      }
      const d = sma(k, signalPeriod);
      const off = k.length - d.length;
      return d.map((dv, i) => ({ k: k[i + off], d: dv }));
    },
  };

  const BollingerBands = {
    calculate: ({ period, values, stdDev }) => {
      const out = [];
      for (let i = period - 1; i < values.length; i++) {
        const win = values.slice(i - period + 1, i + 1);
        const mean = win.reduce((a, b) => a + b, 0) / period;
        const sd = Math.sqrt(win.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
        const upper = mean + stdDev * sd;
        const lower = mean - stdDev * sd;
        out.push({ middle: mean, upper, lower, pb: upper === lower ? 0.5 : (values[i] - lower) / (upper - lower) });
      }
      return out;
    },
  };

  const ADX = {
    calculate: ({ close, high, low, period }) => {
      const n = close.length;
      if (n <= period * 2) return [];
      const plusDM = [];
      const minusDM = [];
      for (let i = 1; i < n; i++) {
        const up = high[i] - high[i - 1];
        const down = low[i - 1] - low[i];
        plusDM.push(up > down && up > 0 ? up : 0);
        minusDM.push(down > up && down > 0 ? down : 0);
      }
      const tr = trueRanges(high, low, close);
      const sTR = wilder(tr, period);
      const sPlus = wilder(plusDM, period);
      const sMinus = wilder(minusDM, period);
      const dx = sTR.map((t, i) => {
        const pdi = t === 0 ? 0 : (100 * sPlus[i]) / t;
        const mdi = t === 0 ? 0 : (100 * sMinus[i]) / t;
        return pdi + mdi === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
      });
      return wilder(dx, period).map((a) => ({ adx: a, pdi: 0, mdi: 0 }));
    },
  };

  return { EMA, RSI, MACD, ATR, Stochastic, BollingerBands, ADX };
}

// ---------- other stand-ins ----------
function makeExpressStub() {
  const express = () => ({ get() {}, listen() {} });
  return express;
}

function makeDiscordStub() {
  class Client {
    constructor() { this.user = { tag: 'stub#0000' }; }
    once() {}
    on() {}
    login() {}
    isReady() { return false; }
  }
  return {
    Client,
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, MessageContent: 4, DirectMessages: 8 },
    Partials: { Channel: 1 },
  };
}

const STUBS = {
  dotenv: () => ({ config() { return {}; } }),
  axios: () => ({
    create() {
      return { get: async () => { throw new Error('axios stub: network is disabled in tests'); } };
    },
  }),
  '@upstash/redis': () => ({ Redis: class Redis { constructor() {} } }),
  technicalindicators: makeTechnicalIndicatorsStub,
  express: makeExpressStub,
  'node-cron': () => ({ schedule() {} }),
  'discord.js': makeDiscordStub,
};

const stubbed = [];
const instances = {};
for (const name of Object.keys(STUBS)) {
  if (!canResolveReal(name)) stubbed.push(name);
}

if (stubbed.length) {
  const origLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (stubbed.includes(request)) {
      if (!instances[request]) instances[request] = STUBS[request]();
      return instances[request];
    }
    return origLoad.apply(this, arguments);
  };
}

// Harmless placeholder credentials so config.js never sees "undefined" and
// nothing can accidentally reach a real service: no test performs network
// I/O (fetch/axios/redis are all replaced or injected per test).
process.env.DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN || 'test-token';
process.env.TWELVEDATA_API_KEY = process.env.TWELVEDATA_API_KEY || 'test-td-key';
process.env.UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || 'https://redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'test-redis-token';

// Keep test output readable: the app logger is silent unless TEST_VERBOSE=1.
if (!process.env.TEST_VERBOSE) {
  const logger = require(path.join(PROJECT_ROOT, 'src', 'utils', 'logger'));
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
}

module.exports = { stubbedPackages: stubbed };
