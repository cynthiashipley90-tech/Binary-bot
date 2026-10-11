require('dotenv').config();

function num(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) ? n : fallback;
}

module.exports = {
  redis: {
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  },
  discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
  },
  // Kept even though the Discord !health command was removed - this is a
  // separate plain HTTP endpoint (src/index.js) that hosting platforms
  // like Railway use for their own uptime/health checks on the process.
  server: {
    port: num(process.env.PORT, 3000),
  },

  // ---- Twelve Data (used for binary/time-based signals; Quotex's own OTC
  // feed isn't publicly accessible at all - see binaryEngine.js header for
  // the full honesty note). ----
  twelvedata: {
    apiKey: process.env.TWELVEDATA_API_KEY || '',
    baseUrl: 'https://api.twelvedata.com',
  },

  binary: {
    // Fixed checkpoint fractions of the chosen duration - e.g. a 20-minute
    // trade gets checked at 5, 10, 15 and 20 minutes in.
    checkpointFractions: [0.25, 0.5, 0.75, 1.0],
    // 5 seconds to 48 hours. Below ~1 minute the model is extrapolating
    // below the resolution of the underlying 1-minute candle data (see the
    // honesty note in binaryEngine.js) - it still computes a number, but
    // treat sub-minute confidence as a rougher estimate than 1min+.
    minDurationMinutes: num(process.env.BINARY_MIN_DURATION_MIN, 5 / 60),
    maxDurationMinutes: num(process.env.BINARY_MAX_DURATION_MIN, 48 * 60),
    // Confidence at/above this is called out as a high-trust setup in the
    // reply - it's just a label threshold, the confidence number itself is
    // always computed fresh from live volatility + drift, never hardcoded.
    highTrustThreshold: num(process.env.BINARY_HIGH_TRUST_THRESHOLD, 90),
    lookbackMinutesForStats: num(process.env.BINARY_LOOKBACK_MIN, 120),

    // ---- NO_TRADE gates (see decideFinalSignal in binaryEngine.js) ----
    // Calibrated probability must be at least 50 + this many points before
    // a direction is actually issued instead of NO_TRADE. E.g. 5 means the
    // calibrated edge must be >=55%.
    noTradeEdgeThresholdPct: num(process.env.BINARY_NO_TRADE_EDGE_PCT, 5),
    // Minimum number of usable (non-null) confluence indicators before the
    // read is trusted at all.
    minConfluenceFactors: num(process.env.BINARY_MIN_CONFLUENCE_FACTORS, 3),
    // Fraction of the calibrated edge stripped away when the higher-
    // timeframe confluence disagrees with the native-timeframe one (only
    // applied for expiries >=10 minutes, where a higher timeframe is
    // actually computed). 0.4 = lose 40% of the distance from 50%.
    mtfDisagreementPenalty: num(process.env.BINARY_MTF_DISAGREEMENT_PENALTY, 0.4),
  },

  // Model-version tag stamped onto every newly generated signal
  // (signal.modelVersion, see binaryEngine.generateBinarySignal) and
  // therefore persisted with it in Redis. Bump this whenever the engine's
  // scoring/gating/probability logic changes in a way that would make old
  // and new results not directly comparable. Purely additive: previously
  // stored records are never rewritten or deleted - a stored record with NO
  // modelVersion field simply predates this tagging (v3 or earlier), which
  // is itself how old and new results are told apart.
  //   v4: next-candle forecast layer, evidence-based expiry selection,
  //       Student's-t probability reads, confluence-tilt reliability
  //       shrinkage, nearest-real-endpoint expiry resolution + NO_RESULT.
  analyticsVersion: 'binary-engine-v4',

  // Separate version tags for the NON-binary engines. analyticsVersion above
  // is stamped on BINARY signals only (binary logic is unchanged since v4,
  // so its tag stays truthful and old/new binary records stay comparable;
  // tests/audit-v4.test.js pins it). Before v7 the spot engine wrongly
  // re-used that binary tag - spot records stored with
  // modelVersion 'binary-engine-v4' therefore predate crypto-signal-v7.
  //   crypto-signal-v7: multi-timeframe evidence, UTC-safe closed-candle data,
  //     ATR-scaled S/R levels, structure SL with noise floor, level-only TPs
  //     (no forced R-multiple targets), evidence-based expected move, MAE/MFE
  //     + context fields on every record, sample-protected quality label.
  spotAnalyticsVersion: 'crypto-signal-v7',
  futuresAnalyticsVersion: 'futures-signal-v1',

  // ---- Unified !market research workflow (services/marketWorkflow.js) ----
  // AI (Gemini) has been fully removed from this project - !market is a
  // deterministic-only workflow now (fetch data once, run the same
  // binaryEngine the !binary command uses). No AI provider, API key, or
  // model configuration exists anywhere in this codebase.
  market: {
    // Hard ceiling for one whole !market run (data fetch + deterministic
    // bot analysis). When it is hit, the run is reported as a timeout
    // rather than left hanging.
    workflowTimeoutMs: num(process.env.MARKET_WORKFLOW_TIMEOUT_MS, 120000),
  },
};
