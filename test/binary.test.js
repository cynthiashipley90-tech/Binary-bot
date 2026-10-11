const binaryEngine = require('../services/binaryEngine');
const binaryStore = require('../services/binaryStore');
const calibrationSvc = require('../services/calibration');
const { formatBinarySignalMessage } = require('../utils/formatting');
const logger = require('../utils/logger');

// Usage: !binary EURUSD 5          -> 5 minutes (bare number = minutes, unchanged default)
//        !binary EURUSD 30s        -> 30 seconds
//        !binary EURUSD 90m        -> 90 minutes
//        !binary EURUSD 2h         -> 2 hours
//        !binary EURUSD 48h        -> 48 hours (max)
function parseDurationToMinutes(raw) {
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|m|min|mins|h|hr|hrs)?$/i.exec((raw || '').trim());
  if (!match) return null;
  const value = parseFloat(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = (match[2] || 'm').toLowerCase();
  if (unit.startsWith('s')) return value / 60;
  if (unit.startsWith('h')) return value * 60;
  return value; // minutes
}

function parseArgs(argText) {
  const parts = (argText || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2) return null;
  const symbol = parts[0].toUpperCase();
  const duration = parseDurationToMinutes(parts[1]);
  if (!symbol || !Number.isFinite(duration) || duration <= 0) return null;
  return { symbol, duration };
}

async function handleBinaryCommand(argText) {
  const parsed = parseArgs(argText);
  if (!parsed) {
    return 'Usage: !binary EURUSD 5\n' +
      '(symbol, then expiry duration - plain number = minutes)\n' +
      'Duration also accepts s/m/h suffixes, e.g. !binary BTCUSD 30s, !binary BTCUSD 2h, !binary BTCUSD 48h\n' +
      'Range: 5 seconds to 48 hours.\n' +
      'Reply can be UP, DOWN, or NO TRADE - a weak/unreliable setup is reported honestly, not forced.';
  }

  try {
    const signal = await binaryEngine.generateBinarySignal(parsed.symbol, parsed.duration);

    // A NO_TRADE signal is not persisted as an open trade - there is
    // nothing to track a win/loss for, since no trade was actually called.
    // It's still shown in full so the reasoning is visible.
    if (signal.direction !== 'NO_TRADE') {
      const id = binaryStore.newId(signal.symbol);
      await binaryStore.saveNew({ ...signal, id, status: 'OPEN', result: null });
    }

    // Real historical accuracy for THIS expiry bucket, shown alongside the
    // model's own probability - separate numbers, never blended. Plus the
    // separate expected-expiry-price vs actual-expiry-price bias/error
    // validation (calibration.js) - a directionally-right bucket can still
    // have a systematically biased price target, and that would never show
    // up in win-rate alone.
    const expiryPerf = await calibrationSvc.getExpiryPerf(signal.expiryBucket.key);
    const priceAccuracy = await calibrationSvc.getExpiryPriceAccuracy(signal.expiryBucket.key);

    return formatBinarySignalMessage(signal, { expiryPerf, priceAccuracy });
  } catch (err) {
    logger.error('binary command failed:', err.message);
    return `Could not generate a binary signal for ${parsed.symbol}: ${err.message}`;
  }
}

module.exports = { handleBinaryCommand, parseDurationToMinutes };
