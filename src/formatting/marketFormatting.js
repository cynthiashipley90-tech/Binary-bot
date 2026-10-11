// ---- Discord formatting for the !market research workflow ----
// AI-comparison/synthesis formatting has been removed along with the AI
// stage itself (see services/marketWorkflow.js) - !market now renders the
// exact same deterministic signal !binary does (reusing
// formatBinarySignalMessage), wrapped with a bit of extra market-summary
// context and a few alternate views (compact / reasoning-only /
// data-quality-only) for the natural-language front end.
// Numbers that matter (bot probabilities, prices, data-quality flags) are
// always printed from the computed data here in code.

const { formatBinarySignalMessage } = require('./formatting');

function fmtNum(n, decimals = null) {
  if (n === null || n === undefined) return '-';
  if (decimals !== null) return Number(n).toFixed(decimals);
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n).toFixed(d);
}

function botStatusLine(signal) {
  if (signal.direction === 'NO_TRADE') {
    return `NO_TRADE (${signal.noTradeReasons[0] || 'insufficient evidence'}${signal.noTradeReasons.length > 1 ? ` + ${signal.noTradeReasons.length - 1} more` : ''})`;
  }
  return `${signal.direction} - raw ${signal.rawProbability}%, calibrated ${signal.calibratedProbability}% (${signal.qualityLabel})`;
}

function formatReasoningOnly(signal) {
  const lines = ['**Reasoning**', '', 'Bot factors (grouped confluence, strongest first):'];
  lines.push(...(signal.confluenceBreakdown || []).slice(0, 8).map((f) => `- [${f.group}] ${f.factor}: ${f.score > 0 ? '+' : ''}${f.score}`));
  if (signal.direction === 'NO_TRADE') {
    lines.push('', 'NO_TRADE reasons:', ...signal.noTradeReasons.map((r) => `- ${r}`));
  }
  return lines.join('\n');
}

function formatDataQualityOnly(signal) {
  const lines = [
    `**Data Quality - ${signal.symbol}**`,
    `Issues: ${signal.dataQualityIssues?.length ? signal.dataQualityIssues.join('; ') : 'none - clean candle series'}`,
    `Volume data: ${signal.volume?.available ? 'available' : `unavailable${signal.volume?.reason ? ` (${signal.volume.reason})` : ''}`}`,
  ];
  return lines.join('\n');
}

// The old "compare"/"differences-only" views compared the bot against an
// independent AI analyst. That AI stage no longer exists - there is
// nothing left to compare against, so this states that plainly instead of
// silently pretending the comparison still runs.
function formatNoComparisonAvailable(signal) {
  return [
    'AI-based comparison has been removed from this bot - it is now a single deterministic engine, so there is no second analysis to compare against.',
    `Deterministic read: ${botStatusLine(signal)}`,
    '',
    'Use `!market <symbol> <duration>` (or `!binary <symbol> <duration>`) for the full signal.',
  ].join('\n');
}

// ---------------------------------------------------------------------
// Unified-workflow output
// ---------------------------------------------------------------------

// Discord rejects message content over 2000 characters. Use exactly that as
// the limit so anything that already fit in one message (every existing
// reply) is still sent as one message - only text that would previously have
// been rejected gets split.
const DISCORD_MESSAGE_LIMIT = 2000;

// Splits text into Discord-sized chunks, preferring paragraph, then line,
// then word boundaries. A short text comes back as a single chunk, so
// callers can use this unconditionally.
function splitForDiscord(text, limit = DISCORD_MESSAGE_LIMIT) {
  const str = String(text == null ? '' : text);
  if (str.length <= limit) return [str];
  const chunks = [];
  let rest = str;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.4) cut = rest.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function clip(text, max) {
  const t = String(text);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function utcLabel(isoMinute) {
  return `${isoMinute.replace('T', ' ').replace('Z', '')} UTC`;
}

function dataLine(market) {
  const bits = [
    `ref price ${fmtNum(market.referencePrice)} (${market.priceSource})`,
    `last candle ${utcLabel(market.lastCandleUtc)}${market.lastCandleAgeMinutes != null ? ` (${market.lastCandleAgeMinutes} min ago)` : ''}`,
    `data quality: ${market.dataQualityIssues.length ? market.dataQualityIssues.join('; ') : 'clean'}`,
  ];
  if (market.stale) bits.push('⚠️ STALE - market may be closed, treat as a historical read');
  return `Data: ${bits.join(' | ')}`;
}

function historyLineFor(bot) {
  const perf = bot && bot.expiryPerf;
  if (!perf) return null;
  return `Historical accuracy (${perf.label} horizon bucket): ${perf.total ? `${perf.winRatePct}% over ${perf.total} closed trades` : 'no closed trades yet'} - small samples are noisy`;
}

// Full/compact deterministic report - reuses !binary's own message
// formatter (utils/formatting.js) so the two commands never drift apart,
// with a short market-summary header on top.
function formatFullReport(result) {
  const { market, bot } = result;
  const header = [
    `**MARKET RESEARCH REPORT** - ${market.symbol} | horizon ${market.horizonLabel}`,
    dataLine(market),
  ];
  return `${header.join('\n')}\n\n${formatBinarySignalMessage(bot.signal, { expiryPerf: bot.expiryPerf, priceAccuracy: bot.priceAccuracy })}`;
}

function formatCompactReport(result) {
  const { market, bot } = result;
  const signal = bot.signal;
  const lines = [`**${signal.symbol}** (${market.horizonLabel}) - ${botStatusLine(signal)}`];
  if (market.stale) lines.push('⚠️ Data is stale - market may be closed.');
  const history = historyLineFor(bot);
  if (history) lines.push(history);
  if (signal.direction !== 'NO_TRADE') {
    const finalCp = signal.checkpoints[signal.checkpoints.length - 1];
    lines.push(`Expected at expiry: ~${fmtNum(finalCp.predictedPrice)} (${signal.expectedMovePct >= 0 ? '+' : ''}${signal.expectedMovePct}%), expires ${signal.expiresAtIso}`);
  }
  return lines.join('\n');
}

const DATA_FAILURE_HINT = {
  DATA_FETCH_FAILED: 'the market-data request failed',
  TOO_FEW_CANDLES: 'the data provider returned too few recent candles',
  INVALID_DATA: 'the returned candles failed validation',
  DATA_TIMEOUT: 'the market-data request timed out',
};

function formatInsufficientData(result) {
  const { request } = result;
  return [
    `**INSUFFICIENT_DATA** - ${request.symbol}`,
    `Not enough valid market data to run a research analysis: ${DATA_FAILURE_HINT[result.reasonCode] || 'data unavailable'} (${result.reason}).`,
    'No direction, probability or confidence was generated - nothing is estimated when the data is not there. Check the symbol or try again shortly.',
  ].join('\n');
}

function formatTimeout(result) {
  const { request } = result;
  return `⏱️ **TIMEOUT** - the ${request.symbol} analysis did not finish in time (${Math.round(result.totalMs / 1000)}s). ${result.reason ? `Detail: ${clip(result.reason, 300)}. ` : ''}Please try again.`;
}

function formatWorkflowError(result) {
  const { request } = result;
  return `❌ **ANALYSIS FAILED** - ${request.symbol}: ${clip(result.reason || 'unknown error', 400)}`;
}

// The narrower views (explicit user request or follow-up). Only meaningful
// on a REPORT outcome (bot ran successfully) - callers check that first.
function formatAnalysesView(result, intent) {
  const { bot } = result;
  const botOK = bot && bot.status === 'OK';
  if (!botOK) return null;
  switch (intent) {
    case 'compare':
    case 'differences-only':
      return formatNoComparisonAvailable(bot.signal);
    case 'reasoning':
      return formatReasoningOnly(bot.signal);
    case 'dataquality':
      return formatDataQualityOnly(bot.signal);
    default:
      return null;
  }
}

// One entry point: workflow result -> the text the user sees.
function renderWorkflowResult(result, opts = {}) {
  const { intent = 'analyze', compact = false } = opts;
  switch (result.outcome) {
    case 'REPORT': {
      const narrow = formatAnalysesView(result, intent);
      if (narrow) return narrow;
      return compact ? formatCompactReport(result) : formatFullReport(result);
    }
    case 'INSUFFICIENT_DATA':
      return formatInsufficientData(result);
    case 'TIMEOUT':
      return formatTimeout(result);
    default:
      return formatWorkflowError(result);
  }
}

module.exports = {
  renderWorkflowResult,
  formatFullReport,
  formatCompactReport,
  formatInsufficientData,
  formatTimeout,
  formatWorkflowError,
  formatAnalysesView,
  splitForDiscord,
  formatReasoningOnly,
  formatDataQualityOnly,
  formatNoComparisonAvailable,
  botStatusLine,
};
