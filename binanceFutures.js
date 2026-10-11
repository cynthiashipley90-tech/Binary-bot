// ---- Binance USD-M Futures PUBLIC market-data client (read-only) ----
// Why this exists: Twelve Data (the bot's only other data source) provides
// NO funding rate, NO mark price, NO index price for perpetual futures, so a
// futures engine cannot be built on it without fabricating those fields.
// Binance's public, unauthenticated fapi endpoints provide them for real:
//   /fapi/v1/klines        - OHLCV (last-price) candles, real volume
//   /fapi/v1/premiumIndex  - markPrice, indexPrice, lastFundingRate, nextFundingTime
//   /fapi/v1/fundingRate   - funding history
//   /fapi/v1/ticker/price  - last traded price
// NOT available publicly (and therefore reported unsupported, never
// invented): maintenance-margin tiers (needs a signed account endpoint),
// the account's fee tier, cross-margin liquidation (needs account state).
// READ-ONLY: this module has no order, account or signed endpoint at all.
// Some hosting regions are geo-blocked by Binance (HTTP 451/403): that
// surfaces as INSUFFICIENT_DATA, never a guess.

const axios = require('axios');

const http = axios.create({ baseURL: process.env.BINANCE_FAPI_BASE_URL || 'https://fapi.binance.com', timeout: 10000 });

const INTERVALS = {
  '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1h': 3600000, '4h': 14400000, '1d': 86400000,
};

function insufficient(msg) {
  const err = new Error(msg);
  err.code = 'INSUFFICIENT_DATA';
  return err;
}

async function get(path, params) {
  try {
    const { data } = await http.get(path, { params });
    return data;
  } catch (e) {
    const status = e.response?.status;
    const apiMsg = e.response?.data?.msg;
    throw insufficient(`Binance futures data request failed (${path}${status ? `, HTTP ${status}` : ''}${apiMsg ? `: ${apiMsg}` : `: ${e.message}`})`);
  }
}

function numOrNull(x) {
  const n = Number(x);
  return x !== undefined && x !== null && x !== '' && Number.isFinite(n) ? n : null;
}

async function getKlines(symbol, interval, limit = 300) {
  if (!INTERVALS[interval]) throw insufficient(`unsupported futures interval ${interval}`);
  const rows = await get('/fapi/v1/klines', { symbol, interval, limit });
  if (!Array.isArray(rows) || !rows.length) throw insufficient(`no kline data returned for ${symbol} ${interval}`);
  return rows.map((r) => ({
    time: Number(r[0]),
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: numOrNull(r[5]),
    closeTime: Number(r[6]),
  }));
}

async function getPremiumIndex(symbol) {
  const d = await get('/fapi/v1/premiumIndex', { symbol });
  const markPrice = numOrNull(d.markPrice);
  const indexPrice = numOrNull(d.indexPrice);
  if (!(markPrice > 0)) throw insufficient(`no mark price returned for ${symbol}`);
  return {
    markPrice,
    indexPrice: indexPrice > 0 ? indexPrice : null,
    lastFundingRate: numOrNull(d.lastFundingRate),
    nextFundingTime: numOrNull(d.nextFundingTime),
    time: numOrNull(d.time),
  };
}

async function getFundingHistory(symbol, limit = 30) {
  const rows = await get('/fapi/v1/fundingRate', { symbol, limit });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({ time: Number(r.fundingTime), rate: numOrNull(r.fundingRate) })).filter((r) => r.rate !== null);
}

async function getLastPrice(symbol) {
  const d = await get('/fapi/v1/ticker/price', { symbol });
  const p = numOrNull(d.price);
  if (!(p > 0)) throw insufficient(`no last price returned for ${symbol}`);
  return p;
}

module.exports = {
  INTERVALS, getKlines, getPremiumIndex, getFundingHistory, getLastPrice,
};
