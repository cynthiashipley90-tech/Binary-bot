// ---- !market command: unified research workflow entry point ----
// Orchestration only - every real piece of logic lives in its own module:
//   services/nlu.js            deterministic parsing of the free-text request
//   services/marketWorkflow.js fetches data once, runs the deterministic bot
//                              (one temporary in-memory state per run) - no
//                              AI stage; see marketWorkflow.js header
//   utils/marketFormatting.js  turns the workflow result into Discord text
//
// UX contract (the Discord side lives in src/index.js):
//   1. When a fresh analysis is needed, `hooks.onWorkflowStart` is invoked
//      (index.js uses it to post ONE "WAITING" message). It runs alongside
//      the analysis - it never delays it.
//   2. Nothing else is sent while the workflow runs: no progress messages,
//      no intermediate Bot or AI results.
//   3. This function returns the final text; index.js edits the WAITING
//      message into it.
//
// Storage: the only Redis write here is registering a successful bot signal
// for tracking (see registerTrackedSignal below) - everything else stays as
// before: a small in-process, time-limited copy of the last finished result
// per channel, so a follow-up like "explain in Roman Urdu" or "sirf
// differences batao" can re-format it without a new fetch or AI call. That
// part is lost on restart, which is fine for a 15-minute conversational
// convenience. (The older Redis-backed services/analysisMemory.js and
// services/analysisLog.js are no longer used by this command.)

const { runMarketWorkflow } = require('../services/marketWorkflow');
const { parseMarketRequest } = require('../services/nlu');
const marketFormatting = require('../utils/marketFormatting');
const binaryStore = require('../services/binaryStore');
const logger = require('../utils/logger');

const DEFAULT_HORIZON_MINUTES = 5;
const FOLLOWUP_TTL_MS = 15 * 60 * 1000;
const FOLLOWUP_MAX_ENTRIES = 200;

// scopeId (Discord channel id) -> { result, language, savedAt }
const followUpMemory = new Map();

const REMEMBERED_OUTCOMES = new Set(['REPORT']);

function remember(scopeId, result, parsed) {
  // A failed run (no data / timeout / error) must not clobber the last good
  // analysis a follow-up might still want.
  if (!REMEMBERED_OUTCOMES.has(result.outcome)) return;
  const now = Date.now();
  for (const [key, rec] of followUpMemory) {
    if (now - rec.savedAt > FOLLOWUP_TTL_MS) followUpMemory.delete(key);
  }
  while (followUpMemory.size >= FOLLOWUP_MAX_ENTRIES) {
    followUpMemory.delete(followUpMemory.keys().next().value);
  }
  followUpMemory.set(scopeId, { result, language: parsed.language, savedAt: now });
}

function recall(scopeId) {
  const rec = followUpMemory.get(scopeId);
  if (!rec) return null;
  if (Date.now() - rec.savedAt > FOLLOWUP_TTL_MS) {
    followUpMemory.delete(scopeId);
    return null;
  }
  return rec;
}

function formatFromMemory(record, parsed) {
  const view = marketFormatting.formatAnalysesView(record.result, parsed.intent);
  if (view) return view;
  let note = '';
  if (parsed.language !== record.language) {
    note = "\n\n_(Note: yeh pichli analysis usi language mein hai jo pehli dafa generate hui thi - naya language ke liye symbol ke saath dubara pucho, e.g. '!market EURUSD analyse karo Roman Urdu mein'.)_";
  }
  return marketFormatting.renderWorkflowResult(record.result, { intent: 'analyze', compact: parsed.compact }) + note;
}

function startHook(fn) {
  if (typeof fn !== 'function') return Promise.resolve();
  return Promise.resolve()
    .then(fn)
    .catch((err) => logger.warn(`Waiting-message hook failed (analysis continues): ${err.message}`));
}

// ---- Tracker registration (fixes: !market signals never entered the
// completed-trades lifecycle) ----
// A successful bot analysis IS a real deterministic binary-style signal -
// same shape, same checkpoints/expiry/entryPrice, produced by the exact
// same binaryEngine.generateBinarySignal() call that !binary already
// registers for tracking (see commands/binary.js). !market computed and
// displayed that same signal but never called binaryStore.saveNew() on it,
// so it never entered services/binaryTracker.js's OPEN set, never got
// checkpointed against real price data, never closed as WIN/LOSS, and never
// contributed a single row to its own expiry bucket's history - which is
// exactly why a !market report's "completed trades in this expiry bucket"
// permanently read 0 no matter how many times it had been run.
//
// This reuses the EXACT SAME binaryStore.newId()/saveNew() every other
// command uses - no parallel storage, no new schema, and nothing here
// touches or resets any existing historical data; it only adds new rows for
// runs from this point forward. Registration is best-effort: a store/Redis
// failure is logged and never affects the analysis text already about to be
// returned to Discord.
async function registerTrackedSignal(result) {
  if (!result || !result.bot || result.bot.status !== 'OK' || !result.bot.signal) return;
  try {
    const { signal } = result.bot;
    const id = binaryStore.newId(signal.symbol);
    await binaryStore.saveNew({ ...signal, id, status: 'OPEN', result: null });
  } catch (err) {
    logger.error(`!market: could not register signal for tracking (analysis result is unaffected): ${err.message}`);
  }
}

// `deps` exists for tests: { runMarketWorkflow, workflowOptions }.
async function handleMarketCommand(scopeId, text, hooks = {}, deps = {}) {
  const parsed = parseMarketRequest(text);

  // No symbol found -> a follow-up on the previous analysis (or an invalid
  // request with nothing to go on). Never invent a symbol; memory only
  // re-formats what was already computed, it never feeds a calculation.
  // Nothing to wait for here, so no WAITING message either.
  if (!parsed.symbol) {
    const last = recall(scopeId);
    if (!last) {
      return "Symbol samajh nahi aaya aur is channel ke liye koi pichli analysis bhi nahi mili.\nExample: `!market EURUSD analyse karo` ya `!market BTCUSD 15m analysis`.";
    }
    return formatFromMemory(last, parsed);
  }

  const request = {
    symbol: parsed.symbol,
    horizonMinutes: parsed.horizonMinutes || DEFAULT_HORIZON_MINUTES,
    language: parsed.language,
  };

  // Post the WAITING message concurrently with the analysis - sending it
  // must not add latency to the research itself.
  const waiting = startHook(hooks.onWorkflowStart);

  let result;
  try {
    result = await (deps.runMarketWorkflow || runMarketWorkflow)(request, { ...(deps.workflowOptions || {}) });
  } catch (err) {
    // runMarketWorkflow never throws; this only guards an unexpected bug.
    logger.error(`!market workflow threw unexpectedly: ${err.stack || err.message}`);
    result = { outcome: 'ERROR', reasonCode: 'INTERNAL', reason: err.message, request, totalMs: 0 };
  }

  // The final edit must never race ahead of the WAITING message existing.
  await waiting;

  await registerTrackedSignal(result);
  remember(scopeId, result, parsed);
  return marketFormatting.renderWorkflowResult(result, { intent: parsed.intent, compact: parsed.compact });
}

module.exports = {
  handleMarketCommand, followUpMemory, FOLLOWUP_TTL_MS, registerTrackedSignal,
};
