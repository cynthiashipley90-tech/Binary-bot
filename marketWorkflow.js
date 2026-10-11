// ---- Unified !market research workflow (deterministic-only) ----
//
// The independent Gemini AI analyst, the bot-vs-AI comparison stage, and
// the final AI synthesis stage have all been removed from this project
// (see README's "AI removed" note) - !binary and !market are now both
// thin front ends onto the exact same deterministic multi-factor
// confluence engine (services/binaryEngine.js). !market's own value over
// !binary is the natural-language front end (services/nlu.js), per-channel
// follow-up memory, and a couple of alternate display views (compact,
// reasoning-only, data-quality-only) - not AI.
//
//   COMMAND
//      |
//      v
//   fetch RAW market data once (candles + live quote; no analysis)
//      |
//      v
//   BOT ANALYSIS (deterministic engine, calibration read)
//      |
//      v
//   result object -> Discord formatting (utils/marketFormatting.js)
//
// Rules this module enforces (and tests/market-workflow.test.js checks):
//  * All intermediate state (raw candles, bot signal) lives in local
//    variables of ONE runMarketWorkflow() call and is discarded when it
//    returns. Nothing here touches Redis - the only Redis traffic in the
//    whole flow is the bot's existing READ of calibration counters inside
//    binaryEngine.generateBinarySignal.
//  * One overall deadline (config.market.workflowTimeoutMs). When it fires,
//    the run is reported as TIMEOUT rather than hanging.
//  * Bad/insufficient market data short-circuits with INSUFFICIENT_DATA and
//    no direction/probability.
//  * runMarketWorkflow never throws.
//
// Result `outcome` values:
//   'REPORT'            deterministic bot analysis produced
//   'INSUFFICIENT_DATA' market data missing/invalid/too short - no analysis
//   'TIMEOUT'           deadline hit before the analysis finished
//   'ERROR'             the bot analysis failed for a non-timeout reason

const config = require('../config');
const logger = require('../utils/logger');
const binaryEngine = require('./binaryEngine');
const calibrationSvc = require('./calibration');
const dataQualitySvc = require('./dataQuality');
const { summarizeMarket, collectLimitations } = require('./marketSummary');

async function runBotBranch(inputs) {
  const startedAt = Date.now();
  try {
    // Reuses the raw snapshot - no second market-data fetch.
    const signal = await binaryEngine.generateBinarySignal(inputs.symbol, inputs.duration, inputs);
    let expiryPerf = null;
    let priceAccuracy = null;
    try {
      expiryPerf = await calibrationSvc.getExpiryPerf(signal.expiryBucket.key); // Redis READ only
    } catch (err) {
      logger.warn(`Historical performance lookup failed (continuing without it): ${err.message}`);
    }
    try {
      priceAccuracy = await calibrationSvc.getExpiryPriceAccuracy(signal.expiryBucket.key); // Redis READ only
    } catch (err) {
      logger.warn(`Expiry-price accuracy lookup failed (continuing without it): ${err.message}`);
    }
    return {
      status: 'OK', signal, expiryPerf, priceAccuracy, reason: null, latencyMs: Date.now() - startedAt,
    };
  } catch (err) {
    logger.warn(`Bot analysis failed for ${inputs.symbol}: ${err.message}`);
    return {
      status: 'ERROR', signal: null, expiryPerf: null, priceAccuracy: null, reason: err.message, latencyMs: Date.now() - startedAt,
    };
  }
}

function defaultDeps() {
  return {
    fetchInputs: (symbol, minutes) => binaryEngine.fetchSignalInputs(symbol, minutes),
    runBot: runBotBranch,
  };
}

// Resolves with `promise`'s value, or with onDeadline() if `signal` aborts
// first, or with onFailure(err) if `promise` rejects. Never rejects itself
// and never leaves a rejection unhandled.
function raceDeadline(promise, signal, onDeadline, onFailure) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(onDeadline());
      promise.then(() => {}, () => {});
      return;
    }
    const onAbort = () => resolve(onDeadline());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        resolve(onFailure(err));
      },
    );
  });
}

function classifyDataFailure(err) {
  if (err && err.code === 'INSUFFICIENT_DATA') return 'TOO_FEW_CANDLES';
  if (err && err.code === 'INVALID_DATA') return 'INVALID_DATA';
  return 'DATA_FETCH_FAILED';
}

async function runMarketWorkflow(request, options = {}) {
  const startedAt = Date.now();
  const deps = { ...defaultDeps(), ...(options.deps || {}) };
  const timeoutMs = options.timeoutMs != null ? options.timeoutMs : config.market.workflowTimeoutMs;

  const deadline = new AbortController();
  // Deliberately NOT unref'd: the deadline must fire even if nothing else is
  // keeping the process alive. It is always cleared in the `finally` below,
  // so it never outlives the run.
  const timer = setTimeout(() => deadline.abort(), timeoutMs);

  const base = { request, startedAt };
  const finish = (fields) => {
    const finishedAt = Date.now();
    const result = {
      ...base,
      market: null, bot: null, limitations: [], reason: null, reasonCode: null,
      ...fields,
      finishedAt,
      totalMs: finishedAt - startedAt,
    };
    logger.info(`market workflow ${request.symbol} ${request.horizonMinutes}m outcome=${result.outcome}${result.reasonCode ? `(${result.reasonCode})` : ''} total=${result.totalMs}ms bot=${result.bot ? `${result.bot.status}/${result.bot.latencyMs}ms` : '-'}`);
    return result;
  };

  try {
    // ---- 1. RAW data fetch (starts immediately; no analysis in it) ----
    const inputsP = (async () => {
      try {
        const inputs = await deps.fetchInputs(request.symbol, request.horizonMinutes);
        const dq = dataQualitySvc.validateCandleSeries(inputs.candles);
        if (!dq.ok) {
          const err = new Error(`market data failed validation (${dq.issues.length ? dq.issues.join('; ') : 'too few valid candles'})`);
          err.code = 'INVALID_DATA';
          throw err;
        }
        return { ok: true, inputs };
      } catch (err) {
        return { ok: false, error: err };
      }
    })();
    const inputsRace = raceDeadline(inputsP, deadline.signal, () => ({
      ok: false, timedOut: true, error: new Error(`market data fetch did not finish within ${Math.round(timeoutMs / 1000)}s`),
    }));

    // ---- 2. bot analysis, hanging off the same data promise ----
    const botP = raceDeadline(
      inputsRace.then((r) => (r.ok ? deps.runBot(r.inputs) : null)),
      deadline.signal,
      () => ({ status: 'TIMEOUT', signal: null, expiryPerf: null, reason: `bot analysis did not finish within ${Math.round(timeoutMs / 1000)}s`, latencyMs: Date.now() - startedAt }),
      (err) => ({ status: 'ERROR', signal: null, expiryPerf: null, reason: `bot analysis crashed: ${err.message}`, latencyMs: Date.now() - startedAt }),
    );

    const inputsResult = await inputsRace;
    if (!inputsResult.ok) {
      const err = inputsResult.error;
      if (inputsResult.timedOut) {
        return finish({ outcome: 'TIMEOUT', reasonCode: 'DATA_TIMEOUT', reason: err.message });
      }
      return finish({
        outcome: 'INSUFFICIENT_DATA',
        reasonCode: classifyDataFailure(err),
        reason: err.message,
      });
    }

    // ---- 3. wait for the bot ----
    const bot = await botP;
    const botOK = !!bot && bot.status === 'OK';
    const deadlineHit = deadline.signal.aborted;
    const market = summarizeMarket(inputsResult.inputs);
    const limitations = collectLimitations({ inputs: inputsResult.inputs, bot });

    if (botOK) {
      return finish({ outcome: 'REPORT', market, bot: { ...bot }, limitations });
    }
    return finish({
      outcome: deadlineHit ? 'TIMEOUT' : 'ERROR',
      reasonCode: deadlineHit ? 'WORKFLOW_TIMEOUT' : 'BOT_FAILED',
      reason: bot ? bot.reason : 'bot analysis did not run',
      market, bot: bot ? { ...bot } : null, limitations,
    });
  } catch (err) {
    // Belt and braces - every branch above already converts its own
    // failures into results, so reaching this means a bug, not a market
    // condition. Still must not throw into the Discord handler.
    logger.error(`market workflow crashed unexpectedly: ${err.stack || err.message}`);
    return finish({ outcome: 'ERROR', reasonCode: 'INTERNAL', reason: err.message });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { runMarketWorkflow };
