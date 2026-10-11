const binaryStore = require('../services/binaryStore');
const calibrationSvc = require('../services/calibration');
const config = require('../config');
const { formatBinaryStatsMessage, formatBinarySignalJourney } = require('../utils/formatting');
const logger = require('../utils/logger');

async function handleBinaryAccuracyCommand() {
  try {
    const all = await binaryStore.getAll();
    const closed = all.filter((s) => s.status === 'CLOSED' && (s.result === 'WIN' || s.result === 'LOSS'));
    const noResultCount = all.filter((s) => s.status === 'CLOSED' && s.result === 'NO_RESULT').length;
    const totalSignals = closed.length;
    const wins = closed.filter((s) => s.result === 'WIN').length;
    const losses = closed.filter((s) => s.result === 'LOSS').length;
    const winRate = totalSignals ? Number(((wins / totalSignals) * 100).toFixed(1)) : 0;

    const checkpointAccuracy = await Promise.all(
      config.binary.checkpointFractions.map(async (frac) => {
        const perf = await binaryStore.getCheckpointPerf(frac);
        return {
          label: frac === 1 ? 'Expiry' : `${Math.round(frac * 100)}% mark`,
          total: perf.total,
          accuracyPct: perf.total ? Number(((perf.correct / perf.total) * 100).toFixed(1)) : 0,
        };
      })
    );

    // Requirement: performance reported separately by expiry length AND by
    // market regime - this is the ACTUAL win rate (wins/completed x 100),
    // never the model's own probability number.
    const expiryPerf = (await calibrationSvc.getAllExpiryPerf()).filter((r) => r.total > 0);
    const regimePerf = await calibrationSvc.getAllRegimePerf();
    const sessionPerf = await calibrationSvc.getAllSessionPerf();
    const featurePerf = await calibrationSvc.getAllFeaturePerf();
    const groupPerf = await calibrationSvc.getAllGroupPerf();
    const expiryPriceAccuracy = await calibrationSvc.getAllExpiryPriceAccuracy();

    const parts = [
      formatBinaryStatsMessage({
        totalSignals, wins, losses, winRate, checkpointAccuracy, expiryPerf, regimePerf, sessionPerf, featurePerf, groupPerf, expiryPriceAccuracy, noResultCount,
      }),
    ];

    const recent = await binaryStore.getRecent(5);
    const recentClosed = recent.filter((s) => s.status === 'CLOSED');
    if (recentClosed.length) {
      parts.push('\n*Recent Binary Signals*');
      recentClosed.forEach((s) => parts.push('\n' + formatBinarySignalJourney(s)));
    }

    return parts.join('\n');
  } catch (err) {
    logger.error('binaryaccuracy command failed:', err.message);
    return `Could not load binary accuracy stats: ${err.message}`;
  }
}

module.exports = { handleBinaryAccuracyCommand };
