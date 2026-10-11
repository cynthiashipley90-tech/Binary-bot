// ---- Binance market data adapter (public endpoints, no auth required) ----
// Note: axios would normally be required for actual HTTP calls
// For testing, this module provides stub methods

let axios;
try {
  axios = require('axios');
} catch (e) {
  // axios not available - use stubs for testing
  axios = {
    get: async () => ({ data: {} }),
  };
}

const logger = require('../utils/logger');

const baseURL = process.env.BINANCE_FAPI_BASE_URL || 'https://fapi.binance.com';

async function getExchangeInfo(symbol = null) {
  try {
    const url = symbol
      ? `${baseURL}/fapi/v1/exchangeInfo?symbol=${symbol}`
      : `${baseURL}/fapi/v1/exchangeInfo`;
    const { data } = await axios.get(url, { timeout: 10000 });
    return data;
  } catch (e) {
    logger.warn(`Exchange info fetch failed: ${e.message}`);
    return null;
  }
}

async function getLastPrice(symbol) {
  try {
    const { data } = await axios.get(`${baseURL}/fapi/v1/ticker/price?symbol=${symbol}`, { timeout: 5000 });
    return Number(data.price);
  } catch (e) {
    logger.warn(`Last price fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function getTicker(symbol) {
  try {
    const { data } = await axios.get(`${baseURL}/fapi/v1/ticker/24hr?symbol=${symbol}`, { timeout: 5000 });
    return {
      symbol: data.symbol,
      price: Number(data.lastPrice),
      priceChange: Number(data.priceChange),
      priceChangePercent: Number(data.priceChangePercent),
      highPrice: Number(data.highPrice),
      lowPrice: Number(data.lowPrice),
      volume: Number(data.volume),
      quoteAssetVolume: Number(data.quoteAssetVolume),
      openInterest: Number(data.openInterest) || 0,
    };
  } catch (e) {
    logger.warn(`Ticker fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function getMarkPrice(symbol) {
  try {
    const { data } = await axios.get(`${baseURL}/fapi/v1/premiumIndex?symbol=${symbol}`, { timeout: 5000 });
    return {
      symbol: data.symbol,
      markPrice: Number(data.markPrice),
      indexPrice: Number(data.indexPrice),
      estimatedSettlePrice: Number(data.estimatedSettlePrice),
      lastFundingRate: Number(data.lastFundingRate),
      fundingTime: Number(data.fundingTime),
    };
  } catch (e) {
    logger.warn(`Mark price fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function getFundingRate(symbol) {
  try {
    const { data } = await axios.get(
      `${baseURL}/fapi/v1/fundingRate?symbol=${symbol}&limit=10`,
      { timeout: 5000 },
    );
    return data; // array of funding rate records
  } catch (e) {
    logger.warn(`Funding rate fetch failed for ${symbol}: ${e.message}`);
    return [];
  }
}

async function getOpenInterest(symbol) {
  try {
    const { data } = await axios.get(
      `${baseURL}/fapi/v1/openInterest?symbol=${symbol}`,
      { timeout: 5000 },
    );
    return {
      symbol: data.symbol,
      openInterest: Number(data.openInterest),
    };
  } catch (e) {
    logger.warn(`Open interest fetch failed for ${symbol}: ${e.message}`);
    return null;
  }
}

async function getKlines(symbol, interval = '1m', limit = 500) {
  try {
    const { data } = await axios.get(
      `${baseURL}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
      { timeout: 10000 },
    );
    return data.map((k) => ({
      openTime: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
      closeTime: Number(k[6]),
      quoteAssetVolume: Number(k[7]),
      trades: Number(k[8]),
      baseAssetVolume: Number(k[9]),
    }));
  } catch (e) {
    logger.warn(`Klines fetch failed for ${symbol}: ${e.message}`);
    return [];
  }
}

module.exports = {
  getExchangeInfo,
  getLastPrice,
  getTicker,
  getMarkPrice,
  getFundingRate,
  getOpenInterest,
  getKlines,
};
