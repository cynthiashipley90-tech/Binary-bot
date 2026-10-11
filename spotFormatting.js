// ---- Discord formatting for spot-style crypto signals (!signal) ----
// Built around Entry/Stop-Loss/Take-Profit (open-ended), which a binary
// signal structurally does not have. NOT a futures format: no leverage,
// liquidation or funding is ever shown here.

const {
  fmtNum, mtfLines, expectedMoveLine, historyLine, qualityLine, accuracyBlock, groupLines, walkForwardLines,
} = require('./cryptoFormatting');

function formatSpotSignalMessage(signal) {
  if (signal.direction === 'NO_SIGNAL') {
    const lines = [
      `**CRYPTO SIGNAL - ${signal.symbol}**`,
      `Current Price: ${fmtNum(signal.entryPrice)}`,
      'Decision: **NO_SIGNAL**',
      'Reason(s):',
      ...(signal.reasons || []).map((r) => `- ${r}`),
    ];
    if (signal.mtf) lines.push(...mtfLines(signal.mtf));
    if (signal.regime) lines.push(`Market Regime: ${signal.regime.primary || signal.regime.regime || 'unknown'}${signal.regime.volatility ? ` / ${signal.regime.volatility} volatility` : ''}`);
    if (signal.dataQualityIssues && signal.dataQualityIssues.length) lines.push(`Data quality: ${signal.dataQualityIssues.join('; ')}`);
    lines.push('', '_No forced setup: no real, evidence-backed edge right now - no trade is safer than a forced guess._');
    return lines.join('\n');
  }

  const tp2Line = signal.takeProfit2 != null
    ? `Take Profit 2: ${fmtNum(signal.takeProfit2)} - R:R ${signal.takeProfit2RR} (${signal.takeProfit2Method})`
    : `Take Profit 2: none (${signal.takeProfit2Method || 'no real level'})`;
  const lines = [
    `**CRYPTO SIGNAL - ${signal.symbol}**`,
    `Direction: **${signal.direction}**`,
    `Entry (current price): ${fmtNum(signal.entryPrice)}${signal.signalTimeIso ? ` @ ${signal.signalTimeIso}` : ''}`,
    expectedMoveLine(signal.expectedMove),
    `Stop Loss: ${fmtNum(signal.stopLoss)} (${signal.stopMethod}) - risk ${fmtNum(signal.riskAmount)} (${signal.riskPct}%)`,
    `Take Profit 1: ${fmtNum(signal.takeProfit1)} - R:R ${signal.takeProfit1RR} (${signal.takeProfit1Method})`,
    tp2Line,
    `Risk/Reward: TP1 ${signal.takeProfit1RR}R${signal.takeProfit2RR != null ? ` | TP2 ${signal.takeProfit2RR}R` : ''}`,
    qualityLine(signal),
    `Market Regime: ${signal.regime?.primary || signal.regime?.regime || 'unknown'}${signal.regime?.volatility ? ` / ${signal.regime.volatility} volatility` : ''}`,
    ...mtfLines(signal.mtf),
    signal.keyEvidence && signal.keyEvidence.length ? `Key Evidence: ${signal.keyEvidence.join('; ')}` : null,
    signal.invalidation ? `Invalidation: ${signal.invalidation.basis}` : null,
    historyLine(signal.historicalEvidence),
    `ATR (14): ${fmtNum(signal.atr)}${signal.nearestSupport != null ? ` | Nearest Support: ${fmtNum(signal.nearestSupport)}` : ''}${signal.nearestResistance != null ? ` | Nearest Resistance: ${fmtNum(signal.nearestResistance)}` : ''}`,
    `Uncertainty: ${[
      signal.tp1BeyondTypicalMove ? 'TP1 sits beyond the typical historical move for this horizon' : null,
      signal.expectedMove ? null : 'no expected-move estimate',
      signal.mtf && signal.mtf.available < signal.mtf.requested ? 'some higher-timeframe data missing' : null,
      signal.dataQualityIssues && signal.dataQualityIssues.length ? `data: ${signal.dataQualityIssues.join('; ')}` : null,
      'indicator-based read, no calibrated probability',
    ].filter(Boolean).join('; ')}`,
    '',
    '_Open-ended trade: resolves whenever price touches SL or a TP - tracked automatically, no fixed expiry. Same-candle SL/TP touches are counted conservatively as a loss._',
    '_Not a binary option, not a futures signal, and not financial advice - no guaranteed outcome. This is technical-analysis evidence only._',
  ].filter(Boolean);
  return lines.join('\n');
}

function formatSpotAccuracyMessage({
  report, current, currentVersion, walkForward,
}) {
  const lines = [...accuracyBlock('Crypto Signal Accuracy (real settled signals, all model versions)', report)];
  if (current && current.overall.total) {
    lines.push('', ...accuracyBlock(`Current model only (${currentVersion})`, current));
  }
  lines.push(...groupLines('By symbol | timeframe | direction (never pooled across these)', report.symbolTfDirection));
  lines.push(...groupLines('By market regime', current && current.overall.total ? current.regime : report.regime));
  lines.push(...groupLines('By volatility', current && current.overall.total ? current.volatility : report.volatility));
  lines.push(...groupLines('By quality label', current && current.overall.total ? current.quality : report.quality));
  lines.push(...groupLines('By session (UTC window)', current && current.overall.total ? current.session : report.session));
  lines.push(...groupLines('By model version', report.modelVersion));
  lines.push(...walkForwardLines(walkForward));
  lines.push('', '_Calibrated probability: not supported (needs far more settled history). Past results do not guarantee future outcomes._');
  return lines.join('\n');
}

module.exports = { formatSpotSignalMessage, formatSpotAccuracyMessage };
