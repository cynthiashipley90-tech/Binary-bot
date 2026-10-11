const axios = require('axios');
const config = require('../config');
const logger = require('../utils/logger');

const http = axios.create({ baseURL: config.twelvedata.baseUrl, timeout: 10000 });

function normalizeSymbol(raw) {
  // Accepts "EURUSD", "EUR/USD", "BTCUSD", "BTC/USD" etc.
  const clean = raw.trim().toUpperCase().replace(/\s+/g, '');
  if (clean.includes('/')) return clean;
  if (clean.length === 6) return `${clean.slice(0, 3)}/${clean.slice(3)}`;
  // Common crypto quote currencies
  const quotes = ['USDT', 'USD', 'EUR', 'BTC'];
  for (const q of quotes) {
    if (clean.endsWith(q) && clean.length > q.length) {
      return `${clean.slice(0, clean.length - q.length)}/${q}`;
    }
  }
  return clean;
}

function parseUtc(dt) {
  const s = String(dt).trim();
  return new Date(s.length <= 10 ? `${s}T00:00:00Z` : `${s.replace(' ', 'T')}Z`).getTime();
}

async function getTimeSeries(symbol, interval = '1min', outputsize = 120, opts = {}) {
  if (!config.twelvedata.apiKey) {
    throw new Error('TWELVEDATA_API_KEY is not set - binary signals need it (see .env.example)');
  }
  const { data } = await http.get('/time_series', {
    params: {
      symbol: normalizeSymbol(symbol), interval, outputsize, apikey: config.twelvedata.apiKey,
      ...(opts.utc ? { timezone: 'UTC' } : {}),
    },
  });
  if (data.status === 'error' || !data.values) {
    throw new Error(`Twelve Data error for ${symbol}: ${data.message || 'no values returned'}`);
  }
  // Twelve Data returns most-recent-first; reverse to chronological (oldest -> newest).
  // Volume: Twelve Data includes a `volume` field for crypto and some
  // equities, but forex/FX pairs have no centralized volume and the field
  // is typically absent or 0 for them. We do NOT invent a number when it's
  // missing - each candle's volume is `null` unless the provider returned
  // a genuine positive value, and src/services/volume.js checks candle
  // volume presence itself before computing anything from it (see its
  // "AVAILABLE HONESTY NOTE"). A literal 0 is kept distinct from "missing"
  // where the field was present (some venues can legitimately report a
  // zero-volume bar); only an absent/non-numeric field becomes `null`.
  return data.values
    .map((v) => {
      let volume = null;
      if (v.volume !== undefined && v.volume !== null && v.volume !== '') {
        const parsedVol = Number(v.volume);
        if (Number.isFinite(parsedVol) && parsedVol >= 0) volume = parsedVol;
      }
      return {
        // opts.utc (used only by the crypto/futures engines): ask the API for
        // UTC timestamps and parse them as UTC explicitly, so the result does
        // not depend on the server's local timezone. Default (binary) path is
        // byte-for-byte unchanged.
        time: opts.utc ? parseUtc(v.datetime) : new Date(v.datetime).getTime(),
        open: parseFloat(v.open),
        high: parseFloat(v.high),
        low: parseFloat(v.low),
        close: parseFloat(v.close),
        volume,
      };
    })
    .reverse();
}

async function getCurrentPrice(symbol) {
  if (!config.twelvedata.apiKey) {
    throw new Error('TWELVEDATA_API_KEY is not set');
  }
  const { data } = await http.get('/price', {
    params: { symbol: normalizeSymbol(symbol), apikey: config.twelvedata.apiKey },
  });
  if (!data.price) throw new Error(`Twelve Data error for ${symbol}: ${data.message || 'no price returned'}`);
  return parseFloat(data.price);
}

module.exports = { normalizeSymbol, getTimeSeries, getCurrentPrice };
