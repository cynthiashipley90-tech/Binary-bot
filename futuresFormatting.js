// ---- Discord formatting for FUTURES signals (!futures) ----
// Prints only fields the futures engine actually computed; unsupported or
// unavailable data is labelled as such, never filled in. No guaranteed-win
// language. No order is ever placed - this is analysis only.

const {
  fmtNum, mtfLines, expectedMoveLine, historyLine, qualityLine, accuracyBlock, groupLines, walkForwardLines,
} = require('./cryptoFormatting');

function fundingLine(f) {
  if (!f || f.status !== 'OK') return `Funding: unavailable (${f?.reason || 'no data'})`;
  const who = f.direction === 'LONGS_PAY_SHORTS' ? 'longs pay shorts' : f.direction === 'SHORTS_PAY_LONGS' ? 'shorts pay longs' : 'flat';
  const side = f.thisSidePays ? 'this side PAYS' : 'this side RECEIVES';
  const margin = f.costPerIntervalPctOfMargin != null ? ` (~${Math.abs(f.costPerIntervalPctOfMargin)}% of margin)` : '';
  const pctl = f.percentileOfAbs != null ? `, |rate| at ${f.percentileOfAbs}th percentile of last ${f.historyPrints} prints` : '';
  const next = f.nextFundingTime ? `, next ${new Date(f.nextFundingTime).toISOString().replace('.000Z', 'Z')}` : '';
  return `Funding: ${f.ratePct}% per interval - ${who}; ${side} ${Math.abs(f.costPerIntervalPctOfNotional)}% of notional per interval${margin}${pctl}${next}`;
}

function priceLines(fx) {
  const idx = fx.indexPrice != null ? fmtNum(fx.indexPrice) : 'unavailable';
  const spread = fx.markIndexSpreadPct != null ? ` (mark-index ${fx.markIndexSpreadPct}%)` : '';
  return `Mark: ${fmtNum(fx.markPrice)} | Index: ${idx}${spread} | Last: ${fmtNum(fx.lastPrice)}`;
}

function formatFuturesSignalMessage(signal) {
  const fx = signal.futures;
  if (signal.direction === 'NO_SIGNAL') {
    const lines = [
      `**FUTURES SIGNAL - ${signal.symbol}** (${signal.timeframe}${signal.leverage ? `, ${signal.leverage}x` : ''})`,
      'Decision: **NO_SIGNAL**',
      'Reason(s):',
      ...(signal.reasons || []).map((r) => `- ${r}`),
    ];
    if (fx) lines.push(priceLines(fx));
    if (signal.mtf) lines.push(...mtfLines(signal.mtf));
    if (signal.regime) lines.push(`Market Regime: ${signal.regime.primary || 'unknown'}${signal.regime.volatility ? ` / ${signal.regime.volatility} volatility` : ''}`);
    lines.push('', '_No forced setup. Nothing is estimated when the data or the edge is not there. No order is placed by this bot._');
    return lines.join('\n');
  }

  const liq = fx.liquidation;
  const liqLine = liq && liq.status === 'ESTIMATE_OPTIMISTIC'
    ? `Liquidation Distance: ~${liq.distancePct}% (liq price ~${fmtNum(liq.price)}, isolated) - OPTIMISTIC estimate: maintenance margin & fees unavailable, real liquidation is nearer`
    : `Liquidation Distance: unsupported - ${liq?.reason || 'no data'}`;
  const pr = fx.positionRisk || {};
  const riskMargin = pr.lossAtStopPctOfMargin != null
    ? `Position risk (per unit of margin): stop = -${pr.lossAtStopPctOfMargin}% of margin | TP1 = +${pr.gainAtTp1PctOfMargin}%${pr.gainAtTp2PctOfMargin != null ? ` | TP2 = +${pr.gainAtTp2PctOfMargin}%` : ''} (before fees & funding)`
    : 'Position risk (per unit of margin): unavailable without a leverage input';
  const tp2Line = signal.takeProfit2 != null
    ? `TP2: ${fmtNum(signal.takeProfit2)} - R:R ${signal.takeProfit2RR} (${signal.takeProfit2Method})`
    : `TP2: none (${signal.takeProfit2Method})`;

  const lines = [
    `**FUTURES SIGNAL - ${signal.symbol}** (${signal.timeframe}, isolated margin)`,
    `Direction: **${signal.direction}**`,
    `Entry (last price): ${fmtNum(signal.entryPrice)}${signal.signalTimeIso ? ` @ ${signal.signalTimeIso}` : ''}`,
    priceLines(fx),
    `Leverage: ${signal.leverage ? `${signal.leverage}x` : 'not provided (no default assumed)'}`,
    liqLine,
    `Stop Loss: ${fmtNum(signal.stopLoss)} (${signal.stopMethod}) - risk ${signal.riskPct}%`,
    `TP1: ${fmtNum(signal.takeProfit1)} - R:R ${signal.takeProfit1RR} (${signal.takeProfit1Method})`,
    tp2Line,
    expectedMoveLine(signal.expectedMove),
    `Risk/Reward: TP1 ${signal.takeProfit1RR}R${signal.takeProfit2RR != null ? ` | TP2 ${signal.takeProfit2RR}R` : ''}`,
    riskMargin,
    fundingLine(fx.funding),
    qualityLine(signal),
    `Market Regime: ${signal.regime?.primary || 'unknown'}${signal.regime?.volatility ? ` / ${signal.regime.volatility} volatility` : ''}`,
    ...mtfLines(signal.mtf),
    signal.keyEvidence && signal.keyEvidence.length ? `Key Evidence: ${signal.keyEvidence.join('; ')}` : null,
    signal.invalidation ? `Invalidation: ${signal.invalidation.basis}` : null,
    historyLine(signal.historicalEvidence),
    `Uncertainty: ${[
      'fees not included (account-tier specific)',
      'cross margin unsupported',
      signal.tp1BeyondTypicalMove ? 'TP1 sits beyond the typical historical move for this horizon' : null,
      signal.mtf && signal.mtf.available < signal.mtf.requested ? 'some higher-timeframe data missing' : null,
      'indicator-based read, no calibrated probability',
    ].filter(Boolean).join('; ')}`,
    '',
    '_Analysis only - this bot never places orders. Leveraged futures can lose more than the margin if the stop is not honoured; no guaranteed outcome, not financial advice._',
  ].filter(Boolean);
  return lines.join('\n');
}

function formatFuturesAccuracyMessage({
  report, current, currentVersion, walkForward,
}) {
  const lines = [...accuracyBlock('Futures Signal Accuracy (real settled futures signals only)', report)];
  if (current && current.overall.total) lines.push('', ...accuracyBlock(`Current model only (${currentVersion})`, current));
  lines.push(...groupLines('By symbol | timeframe | direction (never pooled across these)', report.symbolTfDirection));
  lines.push(...groupLines('By leverage', report.leverage));
  lines.push(...groupLines('By market regime', report.regime));
  lines.push(...groupLines('By quality label', report.quality));
  lines.push(...walkForwardLines(walkForward));
  lines.push('', '_Results exclude fees, funding payments and slippage. Calibrated probability: not supported. Past results do not guarantee future outcomes._');
  return lines.join('\n');
}

module.exports = { formatFuturesSignalMessage, formatFuturesAccuracyMessage };
