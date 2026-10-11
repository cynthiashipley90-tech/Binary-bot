// ---- Binance Futures TESTNET Integration ----
// Real verification against Testnet using HMAC-SHA256 signed requests.
// Requires valid Testnet credentials: BINANCE_TESTNET_API_KEY, BINANCE_TESTNET_SECRET
// DO NOT return simulated responses while claiming Testnet verification succeeded.

const crypto = require('crypto');
const logger = require('../utils/logger');

let axios;
try {
  axios = require('axios');
} catch (err) {
  // axios not available - testnet calls will fail gracefully
  axios = null;
}

const TESTNET_BASE_URL = 'https://testnet.binancefuture.com';

class TestnetIntegration {
  constructor(config = {}) {
    this.apiKey = config.testnetApiKey || process.env.BINANCE_TESTNET_API_KEY;
    this.apiSecret = config.testnetApiSecret || process.env.BINANCE_TESTNET_SECRET;
    this.baseURL = TESTNET_BASE_URL;
    this.hasCredentials = !!(this.apiKey && this.apiSecret);
    this.verificationLog = [];
  }

  log(msg, level = 'info') {
    const entry = { timestamp: new Date().toISOString(), level, msg };
    this.verificationLog.push(entry);
    logger[level](`[Testnet] ${msg}`);
  }

  // HMAC-SHA256 signature generation
  signature(queryString) {
    if (!this.apiSecret) throw new Error('API secret not configured');
    return crypto.createHmac('sha256', this.apiSecret).update(queryString).digest('hex');
  }

  // Build signed URL with proper timestamp and signature
  buildSignedUrl(path, params = {}) {
    const queryParams = {
      ...params,
      timestamp: Date.now(),
      recvWindow: 5000,
    };
    const qs = new URLSearchParams(queryParams).toString();
    const sig = this.signature(qs);
    return `${path}?${qs}&signature=${sig}`;
  }

  // Test public endpoint (no auth required)
  async testConnection() {
    if (!axios) {
      this.log('axios not available - cannot test connection', 'warn');
      return false;
    }
    try {
      const response = await axios.get(`${this.baseURL}/fapi/v1/time`, { timeout: 5000 });
      this.log('Public endpoint (time) successful', 'info');
      return !!response.data;
    } catch (err) {
      this.log(`Connection test failed: ${err.message}`, 'error');
      return false;
    }
  }

  // Get account info (requires valid Testnet API credentials)
  async getTestnetAccount() {
    if (!axios) {
      this.log('axios not available - cannot fetch account', 'warn');
      return null;
    }
    if (!this.hasCredentials) {
      this.log('Testnet credentials not configured - cannot fetch account', 'warn');
      return null;
    }

    try {
      const url = this.buildSignedUrl('/fapi/v2/account');
      const response = await axios.get(`${this.baseURL}${url}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 5000,
      });
      this.log(`Account retrieved: wallet=$${Number(response.data.totalWalletBalance).toFixed(2)}`, 'info');
      return response.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      this.log(`Account fetch failed: ${msg}`, 'error');
      return null;
    }
  }

  // Submit a real order to Testnet
  async submitTestnetOrder(orderReq) {
    if (!this.hasCredentials) {
      this.log('Testnet credentials not configured - cannot submit order', 'warn');
      return null;
    }

    const { symbol, side, type, quantity, price, stopPrice } = orderReq;

    try {
      const params = {
        symbol,
        side,
        type,
        quantity: String(quantity),
        newOrderRespType: 'RESULT',
        timeInForce: 'GTC',
      };

      if (price) params.price = String(price);
      if (stopPrice) params.stopPrice = String(stopPrice);

      const qs = new URLSearchParams({
        ...params,
        timestamp: Date.now(),
        recvWindow: 5000,
      }).toString();
      const sig = this.signature(qs);

      const response = await axios.post(
        `${this.baseURL}/fapi/v1/order?${qs}&signature=${sig}`,
        null,
        {
          headers: { 'X-MBX-APIKEY': this.apiKey },
          timeout: 10000,
        }
      );

      this.log(
        `Order submitted: ${symbol} ${side} ${quantity}@${price || 'market'} - orderId=${response.data.orderId}`,
        'info'
      );
      return response.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      const status = err.response?.status || 'unknown';
      this.log(`Order submission failed (HTTP ${status}): ${msg}`, 'error');
      return null;
    }
  }

  // Verify order fill on Testnet
  async verifyOrderFill(symbol, orderId) {
    if (!this.hasCredentials) {
      this.log('Testnet credentials not configured - cannot verify order', 'warn');
      return null;
    }

    try {
      const url = this.buildSignedUrl('/fapi/v1/openOrder', { symbol, orderId });
      const response = await axios.get(`${this.baseURL}${url}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 5000,
      });

      const order = response.data;
      this.log(`Order status: ${symbol} #${orderId} - ${order.status}`, 'info');
      return order;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      this.log(`Order verification failed: ${msg}`, 'warn');
      return null;
    }
  }

  // Get open orders for a symbol
  async getTestnetOpenOrders(symbol) {
    if (!this.hasCredentials) {
      this.log('Testnet credentials not configured - cannot fetch orders', 'warn');
      return [];
    }

    try {
      const url = this.buildSignedUrl('/fapi/v1/openOrders', { symbol });
      const response = await axios.get(`${this.baseURL}${url}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 5000,
      });

      this.log(`Open orders for ${symbol}: ${response.data.length} order(s)`, 'info');
      return response.data;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      this.log(`Fetch open orders failed: ${msg}`, 'warn');
      return [];
    }
  }

  // Get positions on Testnet
  async getTestnetPositions() {
    if (!this.hasCredentials) {
      this.log('Testnet credentials not configured - cannot fetch positions', 'warn');
      return [];
    }

    try {
      const url = this.buildSignedUrl('/fapi/v2/positionRisk');
      const response = await axios.get(`${this.baseURL}${url}`, {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 5000,
      });

      const positions = (response.data || []).filter((p) => Number(p.positionAmt) !== 0);
      this.log(`Active positions: ${positions.length}`, 'info');
      return positions;
    } catch (err) {
      const msg = err.response?.data?.msg || err.message;
      this.log(`Fetch positions failed: ${msg}`, 'warn');
      return [];
    }
  }

  // Full verification suite: tests connection, account, and order submission
  async runFullVerification() {
    this.verificationLog = [];
    this.log('=== Starting Testnet Verification Suite ===', 'info');

    const results = {
      publicConnection: false,
      authenticatedAccount: false,
      orderSubmission: false,
      orderVerification: false,
      credentialsConfigured: this.hasCredentials,
      log: [],
    };

    // Test 1: Public connection
    results.publicConnection = await this.testConnection();

    // Tests 2-4 only if credentials are configured
    if (this.hasCredentials) {
      // Test 2: Authenticated account access
      const account = await this.getTestnetAccount();
      results.authenticatedAccount = !!account;

      // Test 3: Order submission (small test order)
      const testOrder = await this.submitTestnetOrder({
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        quantity: 0.001,
        price: 20000, // Intentionally low price to avoid fills
      });
      results.orderSubmission = !!testOrder;

      // Test 4: Order verification if submission succeeded
      if (testOrder) {
        const verified = await this.verifyOrderFill('BTCUSDT', testOrder.orderId);
        results.orderVerification = !!verified;

        // Clean up: cancel the test order
        if (verified) {
          try {
            await this.cancelTestnetOrder('BTCUSDT', testOrder.orderId);
            this.log('Test order cancelled successfully', 'info');
          } catch (err) {
            this.log(`Failed to cancel test order: ${err.message}`, 'warn');
          }
        }
      }
    } else {
      this.log('Skipping authenticated tests - Testnet credentials not configured', 'warn');
    }

    this.log('=== Testnet Verification Suite Complete ===', 'info');
    results.log = this.verificationLog;
    return results;
  }

  // Cancel a Testnet order
  async cancelTestnetOrder(symbol, orderId) {
    if (!this.hasCredentials) {
      throw new Error('Testnet credentials not configured');
    }

    const params = { symbol, orderId };
    const qs = new URLSearchParams({
      ...params,
      timestamp: Date.now(),
      recvWindow: 5000,
    }).toString();
    const sig = this.signature(qs);

    const response = await axios.delete(
      `${this.baseURL}/fapi/v1/order?${qs}&signature=${sig}`,
      {
        headers: { 'X-MBX-APIKEY': this.apiKey },
        timeout: 10000,
      }
    );

    this.log(`Order cancelled: ${symbol} #${orderId}`, 'info');
    return response.data;
  }

  getVerificationLog() {
    return this.verificationLog;
  }

  reset() {
    this.verificationLog = [];
  }
}

module.exports = TestnetIntegration;
