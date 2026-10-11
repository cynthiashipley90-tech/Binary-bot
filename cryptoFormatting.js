// ---- Shared Discord formatting helpers for spot + futures signals ----
// Never uses guaranteed-win / profit language. Every number printed comes
// from the signal/report objects; nothing is invented here.

function fmtNum(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return '-';
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n).toFixed(d);
}

function mtfLines(mtf) {
  if (!mtf || !mtf.timeframes || !mtf.timeframes.length) return ['MTF Evidence: not available (no higher-timeframe data) - quality capped at LOW'];
  const parts = mtf.timeframes.map((a) => (a.status === 'OK'
    ? `${a.tf}: ${a.bias} (${a.structure})`
    : `${a.tf}: unavailable (${a.reason})`));
  return [`MTF Evidence: ${mtf.verdict.replace(/_/g, ' ').toLowerCase()} - ${parts.join(' | ')}`];
}

function expectedMoveLine(em) {
  if (!em) return 'Expected Move: unavailable (not enough historical windows) - no estimate is invented';
  return `Expected Move: ~${fmtNum(em.amount)} (${em.pct}%) within ~${em.horizonMinutes} min, typical range ${fmtNum(em.rangeLow)}-${fmtNum(em.rangeHigh)} - model expectation from ${em.samples} historical windows, NOT a target`;
}

function historyLine(h) {
  if (!h) return 'Historical Evidence: not available';
  if (!h.settled) return 'Historical Evidence: no settled signals yet for this symbol/timeframe/direction on the current model - nothing to cite';
  const ci = h.winRateCI95 ? `, 95% CI ${h.winRateCI95.low}-${h.winRateCI95.high}%` : '';
  const tail = h.sufficient ? '' : ' - small sample, noisy, not evidence';
  return `Historical Evidence: ${h.winRatePct}% of ${h.settled} settled (same symbol/timeframe/direction/model${ci})${tail}`;
}

function qualityLine(signal) {
  const caps = (signal.qualityCaps || []).length ? ` [${signal.qualityCaps.join('; ')}]` : '';
  return `Quality: ${signal.qualityLabel} (structural-evidence label, not a probability - no calibrated probability exists yet)${caps}`;
}

function accuracyBlock(title, report) {
  const o = report.overall;
  const lines = [
    `**${title}**`,
    `Total Resolved: ${o.total}`,
    `TP1 Wins: ${o.winTp1} | TP2 Wins: ${o.winTp2} | Losses: ${o.loss} | Unresolved/Expired: ${o.expired}`,
  ];
  if (o.gap) lines.push(`Excluded (data gap while tracking, not verifiable): ${o.gap}`);
  if (o.open) lines.push(`Still open: ${o.open}`);
  if (o.settled > 0) {
    const ci = o.winRateCI95 ? `, 95% CI ${o.winRateCI95.low}-${o.winRateCI95.high}%` : '';
    lines.push(`Win Rate (TP1+TP2 vs Loss, excludes expired): ${o.winRatePct}% (n=${o.settled}${ci})`);
    if (!o.sufficient) lines.push('_Small sample - treat this win rate as noisy, not settled._');
    if (o.expectancyR != null) lines.push(`Avg result: ${o.expectancyR}R over ${o.expectancyN} trades (fees/funding/slippage NOT included)`);
    if (o.avgMaeR != null || o.avgMfeR != null) lines.push(`Avg MAE: ${o.avgMaeR ?? '-'}R | Avg MFE: ${o.avgMfeR ?? '-'}R | Median time-to-result: ${o.medianTimeToResultMin ?? '-'} min`);
    if (o.medianMfeToExpectedMove) lines.push(`Median (actual MFE / expected move): ${o.medianMfeToExpectedMove.value} (n=${o.medianMfeToExpectedMove.n})`);
    if (o.ambiguous) lines.push(`Same-candle SL+TP (resolved conservatively as LOSS): ${o.ambiguous}`);
  } else if (!o.total) {
    lines.push('No resolved signals yet.');
  } else {
    lines.push('No settled WIN/LOSS yet.');
  }
  return lines;
}

function groupLines(label, groups, minShow = 1) {
  const entries = Object.entries(groups || {}).filter(([, s]) => s.settled >= minShow).sort((a, b) => b[1].settled - a[1].settled);
  if (!entries.length) return [];
  return ['', `${label}:`, ...entries.slice(0, 12).map(([k, s]) => `- ${k}: ${s.winRatePct}% (n=${s.settled}${s.sufficient ? '' : ', small sample'}${s.expired ? `, ${s.expired} unresolved` : ''})`)];
}

function walkForwardLines(wf) {
  if (!wf) return [];
  if (wf.status !== 'OK') return ['', `Stability check: INSUFFICIENT_DATA - ${wf.message}`];
  return ['', `Stability check (fixed parameters, chronological folds): ${wf.folds.map((f) => `${f.winRatePct}% (n=${f.n})`).join(' -> ')}; spread ${wf.spreadPct} pts`];
}

module.exports = {
  fmtNum, mtfLines, expectedMoveLine, historyLine, qualityLine, accuracyBlock, groupLines, walkForwardLines,
};
