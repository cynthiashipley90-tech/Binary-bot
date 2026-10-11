// ---- Historical statistics for open-ended (spot / futures) signals ----
// Pure functions over stored signal records. Shared by !signalaccuracy and
// !futuresaccuracy; never reads or writes storage itself, and never touches
// binary records.
//
// Definitions (identical everywhere):
//   settled   = status CLOSED, result in WIN_TP1 | WIN_TP2 | LOSS, and
//               integrity !== 'GAP' (a result found after missing candles
//               cannot be trusted as a true first touch)
//   unresolved = EXPIRED_UNRESOLVED (NEVER counted as win or loss)
//   win rate  = (WIN_TP1 + WIN_TP2) / settled, always shown with n and a
//               Wilson 95% interval, flagged noisy below MIN_SETTLED_FOR_STATS
//   R         = result in multiples of the initial risk (loss = -1, TP1 win
//               = +TP1 R:R, TP2 win = +TP2 R:R; fees/funding/slippage NOT
//               included)

const { P } = require('./cryptoParams');

const WINS = new Set(['WIN_TP1', 'WIN_TP2']);
const SETTLED_RESULTS = new Set(['WIN_TP1', 'WIN_TP2', 'LOSS']);

function isSettled(r) {
  return r && r.status === 'CLOSED' && SETTLED_RESULTS.has(r.result) && r.integrity !== 'GAP';
}

function wilson(wins, n, z = 1.96) {
  if (!n) return null;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { low: Number(Math.max(0, (centre - half) * 100).toFixed(1)), high: Number(Math.min(100, (centre + half) * 100).toFixed(1)) };
}

function mean(xs) {
  const v = xs.filter(Number.isFinite);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function median(xs) {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const r2 = (x) => (x == null ? null : Number(x.toFixed(2)));

function realizedR(rec) {
  if (rec.result === 'LOSS') return -1;
  if (rec.result === 'WIN_TP1' && Number.isFinite(rec.takeProfit1RR)) return rec.takeProfit1RR;
  if (rec.result === 'WIN_TP2' && Number.isFinite(rec.takeProfit2RR)) return rec.takeProfit2RR;
  return null; // legacy record without R:R fields - excluded from R stats, never guessed
}

function summarize(records) {
  const closed = records.filter((r) => r.status === 'CLOSED');
  const settled = closed.filter(isSettled);
  const winTp1 = settled.filter((r) => r.result === 'WIN_TP1').length;
  const winTp2 = settled.filter((r) => r.result === 'WIN_TP2').length;
  const loss = settled.filter((r) => r.result === 'LOSS').length;
  const expired = closed.filter((r) => r.result === 'EXPIRED_UNRESOLVED').length;
  const gap = closed.filter((r) => SETTLED_RESULTS.has(r.result) && r.integrity === 'GAP').length;
  const ambiguous = settled.filter((r) => r.ambiguous).length;
  const n = settled.length;
  const wins = winTp1 + winTp2;
  const rs = settled.map(realizedR).filter(Number.isFinite);
  return {
    total: closed.length,
    open: records.filter((r) => r.status === 'OPEN').length,
    settled: n,
    winTp1,
    winTp2,
    loss,
    expired,
    gap,
    ambiguous,
    winRatePct: n ? Number(((wins / n) * 100).toFixed(1)) : null,
    winRateCI95: wilson(wins, n),
    sufficient: n >= P.MIN_SETTLED_FOR_STATS,
    expectancyR: rs.length ? r2(mean(rs)) : null,
    expectancyN: rs.length,
    avgMaeR: r2(mean(settled.map((r) => r.maeR))),
    avgMfeR: r2(mean(settled.map((r) => r.mfeR))),
    medianTimeToResultMin: (() => {
      const m = median(settled.map((r) => (Number.isFinite(r.timeToResultMs) ? r.timeToResultMs / 60000 : NaN)));
      return m == null ? null : Number(m.toFixed(1));
    })(),
    // Did the model's own expected-move estimate match what the market did?
    // Ratio of actual favorable excursion (MFE) to the expected move, median
    // over settled records that carry both (legacy records excluded).
    medianMfeToExpectedMove: (() => {
      const xs = settled
        .filter((r) => r.expectedMove && r.expectedMove.amount > 0 && Number.isFinite(r.mfeAbs))
        .map((r) => r.mfeAbs / r.expectedMove.amount);
      const m = median(xs);
      return m == null ? null : { value: Number(m.toFixed(2)), n: xs.length };
    })(),
  };
}

function groupBy(records, keyFn) {
  const buckets = {};
  for (const rec of records) {
    const k = keyFn(rec);
    if (k == null) continue;
    (buckets[k] = buckets[k] || []).push(rec);
  }
  const out = {};
  for (const [k, recs] of Object.entries(buckets)) out[k] = summarize(recs);
  return out;
}

const keyOf = {
  symbol: (r) => r.symbol || 'UNKNOWN',
  direction: (r) => r.direction || 'UNKNOWN',
  timeframe: (r) => r.timeframe || 'legacy-1min',
  // symbol + timeframe + direction: the only grouping that is never mixed
  // across instruments, timeframes or sides.
  symbolTfDirection: (r) => `${r.symbol || 'UNKNOWN'} | ${r.timeframe || 'legacy-1min'} | ${r.direction || 'UNKNOWN'}`,
  regime: (r) => r.regime?.primary || r.regime?.regime || r.regimePrimary || 'unknown',
  volatility: (r) => r.regime?.volatility || 'unknown',
  quality: (r) => r.qualityLabel || 'unknown',
  session: (r) => r.session?.session || r.session || 'unknown',
  modelVersion: (r) => r.modelVersion || 'legacy (pre-versioning)',
  leverage: (r) => (r.leverage != null ? `${r.leverage}x` : null),
};

function buildReport(records) {
  const overall = summarize(records);
  const dims = {};
  for (const [name, fn] of Object.entries(keyOf)) dims[name] = groupBy(records, fn);
  return { overall, ...dims };
}

// Historical evidence shown next to a NEW signal: ONLY the same model
// version, same symbol, same timeframe, same direction - and only when
// enough settled results exist; otherwise explicitly insufficient.
function historyEvidence(records, { symbol, timeframe, direction, modelVersion }) {
  const subset = records.filter((r) => r.symbol === symbol
    && (r.timeframe || 'legacy-1min') === timeframe
    && r.direction === direction
    && r.modelVersion === modelVersion);
  const s = summarize(subset);
  return {
    scope: { symbol, timeframe, direction, modelVersion },
    settled: s.settled,
    winRatePct: s.winRatePct,
    winRateCI95: s.winRateCI95,
    expectancyR: s.expectancyR,
    sufficient: s.sufficient,
  };
}

// Chronological stability check of the (FIXED, never-fitted) parameters.
// Because nothing is fitted, every fold is out-of-sample by construction;
// this is NOT an optimizer and does not recommend parameter changes - it
// only shows whether the realized hit rate is stable over time.
function walkForwardReport(records, folds = 3) {
  const settled = records.filter(isSettled).sort((a, b) => a.signalTime - b.signalTime);
  if (settled.length < P.MIN_SETTLED_FOR_WALKFORWARD) {
    return {
      status: 'INSUFFICIENT_DATA',
      settled: settled.length,
      required: P.MIN_SETTLED_FOR_WALKFORWARD,
      message: `need ${P.MIN_SETTLED_FOR_WALKFORWARD} settled signals for a stability report, have ${settled.length}; no optimization or "proven" claim is possible`,
    };
  }
  const size = Math.floor(settled.length / folds);
  const out = [];
  for (let i = 0; i < folds; i++) {
    const slice = settled.slice(i * size, i === folds - 1 ? undefined : (i + 1) * size);
    const wins = slice.filter((r) => WINS.has(r.result)).length;
    out.push({ fold: i + 1, n: slice.length, winRatePct: Number(((wins / slice.length) * 100).toFixed(1)), fromTime: slice[0].signalTime, toTime: slice[slice.length - 1].signalTime });
  }
  const rates = out.map((f) => f.winRatePct);
  return { status: 'OK', folds: out, spreadPct: Number((Math.max(...rates) - Math.min(...rates)).toFixed(1)), note: 'parameters are fixed (not fitted); folds are chronological' };
}

module.exports = {
  isSettled, wilson, summarize, groupBy, buildReport, historyEvidence, walkForwardReport, realizedR, keyOf,
};
