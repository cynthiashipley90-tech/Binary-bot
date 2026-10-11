// ---- Walk-forward evaluator for confluence-group evidence ----
// Pure functions (no network, no Redis, no CLI) so the same logic can be
// unit-tested and reused by the CLI backtester. For every point i it hands
// binaryEngine.computeSignalCore ONLY candles[0..i]; the outcome is read
// from candles[i + duration], which the engine under test never sees.
//
// This module only MEASURES (per-group standalone directional accuracy,
// out-of-sample, point by point). It never changes GROUP_WEIGHTS and is not
// wired into live decisions: weightsChangeAllowed() below is the explicit
// gate that says whether a measured sample is even large enough to justify
// considering a change - and with the sample sizes available today the
// honest answer is normally "no", which is the point.

const binaryEngine = require('../services/binaryEngine');

function evaluateGroupsWalkForward(candles, durationMinutes, opts = {}) {
  const step = Math.max(1, opts.step || 1);
  const collect = !!opts.collect;
  const statsLookback = binaryEngine.computeStatsLookback(durationMinutes);
  const start = binaryEngine.requiredFetchSize(durationMinutes, statsLookback);
  const horizon = Math.max(1, Math.round(durationMinutes));
  const groups = {};
  const points = [];
  let evaluated = 0;

  for (let i = start; i + horizon < candles.length; i += step) {
    const visible = candles.slice(0, i + 1); // everything up to and including "now" - nothing later
    const entry = visible[visible.length - 1].close;
    let core;
    try {
      core = binaryEngine.computeSignalCore(visible, entry, durationMinutes, statsLookback);
    } catch (err) {
      continue; // insufficient/invalid data at this point - skip, never fake a result
    }
    const outcomePrice = candles[i + horizon].close; // future data: read by the evaluator only
    const actual = outcomePrice >= entry ? 'UP' : 'DOWN';
    const scores = core.nativeConfluence.groupScores || {};
    evaluated += 1;
    Object.entries(scores).forEach(([g, s]) => {
      if (typeof s !== 'number' || s === 0) return;
      if (!groups[g]) groups[g] = { n: 0, agreed: 0 };
      groups[g].n += 1;
      if ((s > 0 ? 'UP' : 'DOWN') === actual) groups[g].agreed += 1;
    });
    if (collect) points.push({ index: i, groupScores: { ...scores }, actual });
  }

  const summary = {};
  Object.entries(groups).forEach(([g, v]) => {
    summary[g] = { n: v.n, agreed: v.agreed, accuracyPct: Number(((v.agreed / v.n) * 100).toFixed(1)) };
  });
  return { evaluatedPoints: evaluated, groups: summary, points };
}

// Explicit small-sample gate. Returns { allowed, reason }. A change to any
// fixed weight is only even *considered* when EVERY group has at least
// `minSamplePerGroup` graded, out-of-sample observations; otherwise the
// priors stand unchanged. The threshold is a caller-supplied statistical
// requirement (default: calibration.js's own confidence bar), not a tuned
// optimum, and passing it does NOT by itself prove a weight is better.
function weightsChangeAllowed(groupSummary, minSamplePerGroup) {
  const names = Object.keys(groupSummary || {});
  if (!names.length) return { allowed: false, reason: 'no graded observations' };
  const short = names.filter((g) => groupSummary[g].n < minSamplePerGroup);
  if (short.length) {
    return { allowed: false, reason: `insufficient sample for: ${short.join(', ')} (need >= ${minSamplePerGroup} each)` };
  }
  return { allowed: true, reason: 'sample bar met - still requires separate out-of-sample confirmation before any change' };
}

module.exports = { evaluateGroupsWalkForward, weightsChangeAllowed };
