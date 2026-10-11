// ---- Binance USD-M Futures AUTHENTICATED client ----
// Supports both LIVE (https://fapi.binance.com) and TESTNET (https://testnet.binancefuture.com)
// Uses real HMAC-SHA256 signing for authenticated endpoints.
// API credentials:
//   - Live: BINANCE_FUTURE_API_KEY, BINANCE_FUTURE_SECRET
//   - Testnet: BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_SECRET
// WARNING: DO NOT log, print, or expose secrets anywhere.

const crypto = require('crypto');
const logger = require('../utils/logger');

let axios;
try {
  axios = require('axios');
} catch (err) {
  // axios not available - trading will fail gracefully with clear error
  axios = null;
}

// Trading mode: 'disabled', 'test' (Testnet), 'live'
let tradingMode = 'disabled';

// Determine which endpoint and credentials to use
function getEndpointConfig() {
  if (tradingMode === 'test') {
    const testnetKey = process.env.BINANCE_TESTNET_API_KEY;
    const testnetSecret = process.env.BINANCE_TESTNET_SECRET;
    if (!testnetKey || !testnetSecret) {
      throw new Error(
        'Testnet mode selected but BINANCE_TESTNET_API_KEY / BINANCE_TESTNET_SECRET not configured'
      );
    }
    return {
      baseURL: 'https://testnet.binancefuture.com',
      apiKey: testnetKey,
      apiSecret: testnetSecret,
      isTestnet: true,
    };
  }

  if (tradingMode === 'live') {
    const liveKey = process.env.BINANCE_FUTURE_API_KEY;
    const liveSecret = process.env.BINANCE_FUTURE_SECRET;
    if (!liveKey || !liveSecret) {
      throw new Error(
        'Live mode selected but BINANCE_FUTURE_API_KEY / BINANCE_FUTURE_SECRET not configured'
      );
    }
    return {
      baseURL: 'https://fapi.binance.com',
      apiKey: liveKey,
      apiSecret: liveSecret,
      isTestnet: false,
    };
  }

  // disabled mode - no auth needed
  return { baseURL: null, apiKey: null, apiSecret: null, isTestnet: false };
}

function signature(queryString, apiSecret) {
  return crypto.createHmac('sha256', apiSecret).update(queryString).digest('hex');
}

function buildSignedUrl(path, params, apiSecret) {
  const qs = new URLSearchParams({
    ...params,
    timestamp: Date.now(),
    recvWindow: 5000,
  }).toString();
  const sig = signature(qs, apiSecret);
  return `${path}?${qs}&signature=${sig}`;
}

async function authedGet(path, params = {}) {
  if (!axios) {
    throw new Error('axios dependency not installed. Run: npm install');
  }
  if (tradingMode === 'disabled') {
    throw new Error('Cannot make authenticated request while trading is disabled');
  }

  const config = getEndpointConfig();
  const headers = { 'X-MBX-APIKEY': config.apiKey };
  const url = buildSignedUrl(path, params, config.apiSecret);

  try {
    const response = await axios.get(`${config.baseURL}${url}`, {
      headers,
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status || 'unknown';
    const msg = err.response?.data?.msg || err.message;
    const endpoint = config.isTestnet ? 'Testnet' : 'Live';
    throw new Error(`Binance ${endpoint} request failed (${path}, HTTP ${status}): ${msg}`);
  }
}

async function authedPost(path, params = {}) {
  if (!axios) {
    throw new Error('axios dependency not installed. Run: npm install');
  }
  if (tradingMode === 'disabled') {
    throw new Error('Cannot place order while trading is disabled');
  }

  const config = getEndpointConfig();
  const headers = { 'X-MBX-APIKEY': config.apiKey };

  const queryData = {
    ...params,
    timestamp: Date.now(),
    recvWindow: 5000,
  };

  const qs = new URLSearchParams(queryData).toString();
  const sig = signature(qs, config.apiSecret);
  const fullData = `${qs}&signature=${sig}`;

  try {
    const response = await axios.post(`${config.baseURL}${path}`, fullData, {
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });
    return response.data;
  } catch (err) {
    const status = err.response?.status || 'unknown';
    const msg = err.response?.data?.msg || err.message;
    const endpoint = config.isTestnet ? 'Testnet' : 'Live';
    throw new Error(`Binance ${endpoint} request failed (${path}, HTTP ${status}): ${msg}`);
  }
}

// ---- API Methods ----

async function getAccount() {
  return authedGet('/fapi/v2/account');
}

async function getBalance() {
  const acc = await getAccount();
  if (!acc || !acc.assets) return null;
  return {
    totalWalletBalance: Number(acc.totalWalletBalance),
    totalUnrealizedProfit: Number(acc.totalUnrealizedProfit),
    totalMarginOpen: Number(acc.totalMarginOpen),
    availableBalance: Number(acc.availableBalance),
    assets: acc.assets,
  };
}

async function getPositions() {
  return authedGet('/fapi/v2/positionRisk');
}

async function getOpenOrders(symbol = null) {
  const params = symbol ? { symbol } : {};
  return authedGet('/fapi/v1/openOrders', params);
}

async function getOrderStatus(symbol, orderId) {
  return authedGet('/fapi/v1/openOrder', { symbol, orderId });
}

// ---- Order Validation ----
function validateOrder(req) {
  const errors = [];

  if (!req.symbol) errors.push('symbol required');
  if (!['BUY', 'SELL'].includes(req.side)) errors.push('side must be BUY or SELL');

  const validTypes = ['LIMIT', 'MARKET', 'STOP_MARKET', 'TAKE_PROFIT_MARKET'];
  if (!validTypes.includes(req.type)) {
    errors.push(`type must be one of: ${validTypes.join(', ')}`);
  }

  if (!req.quantity || Number(req.quantity) <= 0) {
    errors.push('quantity must be > 0');
  }

  if (req.type === 'LIMIT' && (!req.price || Number(req.price) <= 0)) {
    errors.push('price required for LIMIT order');
  }

  if ((req.type === 'STOP_MARKET' || req.type === 'TAKE_PROFIT_MARKET') && !req.stopPrice) {
    errors.push(`stopPrice required for ${req.type} order`);
  }

  if (errors.length > 0) {
    throw new Error(`Order validation failed: ${errors.join('; ')}`);
  }
}

// ---- Order Execution ----
async function placeOrder(req) {
  validateOrder(req);

  const {
    symbol, side, type, quantity, price, stopPrice, clientOrderId, reduceOnly, closePosition,
    timeInForce = 'GTC', ...extra
  } = req;

  const params = {
    symbol,
    side,
    type,
    quantity: String(quantity),
    timeInForce,
    newOrderRespType: 'RESULT',
  };

  if (price) params.price = String(price);
  if (stopPrice) params.stopPrice = String(stopPrice);
  if (clientOrderId) params.newClientOrderId = clientOrderId;
  if (reduceOnly) params.reduceOnly = 'true';
  if (closePosition) params.closePosition = 'true';

  Object.assign(params, extra);

  return authedPost('/fapi/v1/order', params);
}

async function cancelOrder(symbol, orderId) {
  return authedPost('/fapi/v1/order', { symbol, orderId });
}

async function closePosition(symbol, side, quantity) {
  // Reduce-only MARKET order to close entire position
  return placeOrder({
    symbol,
    side: side === 'LONG' ? 'SELL' : 'BUY',
    type: 'MARKET',
    quantity,
    reduceOnly: true,
    closePosition: true,
  });
}

// ---- Trading Mode Management ----
function getTradingMode() {
  return tradingMode;
}

function setTradingMode(mode) {
  if (!['disabled', 'test', 'live'].includes(mode)) {
    throw new Error(`Invalid trading mode: ${mode}`);
  }
  tradingMode = mode;
  const endpoint = mode === 'test' ? 'Testnet' : mode === 'live' ? 'Live' : 'Disabled';
  logger.info(`Binance trading mode set to: ${mode} (${endpoint})`);
}

// ---- Exports ----
module.exports = {
  // Account & position queries
  getAccount,
  getBalance,
  getPositions,
  getOpenOrders,
  getOrderStatus,

  // Order execution
  placeOrder,
  cancelOrder,
  closePosition,

  // Trading mode
  getTradingMode,
  setTradingMode,

  // For testing/validation
  validateOrder,
  signature,
  getEndpointConfig,
};
