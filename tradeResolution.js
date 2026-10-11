// ---- First-touch resolution + MAE/MFE for open-ended trades ----
// Shared by spotTracker.js and futuresTracker.js. Pure, except
// resolveOpenSignal which writes through the store it is handed.
//
// RESOLUTION RULES (documented, deterministic):
//   LONG : SL below entry, TP1/TP2 above.  SHORT: mirrored.
//   Candles are walked chronologically using each candle's real high/low.
//   FIRST valid touch decides: SL -> LOSS, TP2 -> WIN_TP2, TP1 -> WIN_TP1
//   (trade closes at TP1; a bar that jumps straight to TP2 is WIN_TP2).
//   If a single candle spans the SL and a TP, intrabar order is UNKNOWABLE
//   from OHLC: the outcome is the conservative LOSS, flagged ambiguous:true,
//   never an invented ordering.
//   tp2 may be null (no real level existed) - then only SL/TP1 are checked.
//   Neither touched -> stays OPEN; after the grace period it is closed as
//   EXPIRED_UNRESOLVED - an honest "stopped waiting", never WIN/LOSS.
//
// NO LOOKAHEAD: only candles that are CLOSED at tracking time and open at or
// after the signal time are used; MAE/MFE only accumulate over candles up to
// and including the resolving candle (nothing after the outcome leaks in).
//
// DATA INTEGRITY: a persisted checkpoint (lastCandleTime) means every cycle
// continues exactly where the previous one stopped. If candles are missing
// between checkpoint and the first candle received (outage longer than the
// provider window), the record is flagged integrity:'GAP' - a touch may have
// been missed, so it is excluded from win-rate statistics.

const { P } = require('./cryptoParams');

function firstTouch(candles, direction, sl, tp1, tp2) {
  const has2 = Number.isFinite(tp2);
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    let hitSl; let hitTp1; let hitTp2;
    if (direction === 'LONG') {
      hitSl = c.low <= sl;
      hitTp1 = c.high >= tp1;
      hitTp2 = has2 && c.high >= tp2;
    } else {
      hitSl = c.high >= sl;
      hitTp1 = c.low <= tp1;
      hitTp2 = has2 && c.low <= tp2;
    }
    if (hitSl && (hitTp1 || hitTp2)) {
      return {
        result: 'LOSS', atTime: c.time, index: i, ambiguous: true, note: 'same-bar SL+TP ambiguity - resolved conservatively as LOSS',
      };
    }
    if (hitSl) return { result: 'LOSS', atTime: c.time, index: i };
    if (hitTp2) return { result: 'WIN_TP2', atTime: c.time, index: i };
    if (hitTp1) return { result: 'WIN_TP1', atTime: c.time, index: i };
  }
  return null;
}

// MAE = worst move AGAINST the trade, MFE = best move IN FAVOR, both from
// entry, in price units (>= 0). `prev` lets the tracker carry running
// values across cycles.
function accumulateExcursions(prev, candles, direction, entry) {
  let mae = prev?.maeAbs || 0;
  let mfe = prev?.mfeAbs || 0;
  for (const c of candles) {
    if (direction === 'LONG') {
      mae = Math.max(mae, entry - c.low);
      mfe = Math.max(mfe, c.high - entry);
    } else {
      mae = Math.max(mae, c.high - entry);
      mfe = Math.max(mfe, entry - c.low);
    }
  }
  return { maeAbs: Math.max(0, mae), mfeAbs: Math.max(0, mfe) };
}

function excursionFields(signal, exc) {
  const entry = signal.entryPrice;
  const risk = Number.isFinite(signal.riskAmount) && signal.riskAmount > 0
    ? signal.riskAmount : Math.abs(entry - signal.stopLoss);
  return {
    maeAbs: Number(exc.maeAbs.toPrecision(8)),
    mfeAbs: Number(exc.mfeAbs.toPrecision(8)),
    maePct: Number(((exc.maeAbs / entry) * 100).toFixed(4)),
    mfePct: Number(((exc.mfeAbs / entry) * 100).toFixed(4)),
    maeR: risk > 0 ? Number((exc.maeAbs / risk).toFixed(3)) : null,
    mfeR: risk > 0 ? Number((exc.mfeAbs / risk).toFixed(3)) : null,
  };
}

function signedMovePct(direction, entry, price) {
  const raw = ((price - entry) / entry) * 100;
  return Number((direction === 'LONG' ? raw : -raw).toFixed(4));
}

function missingBars(times, expectedFirst, intervalMs) {
  let missing = Math.max(0, Math.round((times[0] - expectedFirst) / intervalMs));
  for (let i = 1; i < times.length; i++) missing += Math.max(0, Math.round((times[i] - times[i - 1]) / intervalMs) - 1);
  return missing;
}

// cfg: { intervalMs, expireAfterMs, store, logTag, logger }
async function resolveOpenSignal(signal, candlesRaw, now, cfg) {
  const { intervalMs, expireAfterMs, store } = cfg;
  const seen = new Set();
  const closedCandles = candlesRaw
    .filter((c) => c.time + intervalMs <= now) // forming candle is never used
    .filter((c) => c.time >= signal.signalTime) // nothing from before the signal
    .filter((c) => (signal.lastCandleTime == null || c.time > signal.lastCandleTime))
    .filter((c) => (seen.has(c.time) ? false : (seen.add(c.time), true)))
    .sort((a, b) => a.time - b.time);

  const expectedFirst = signal.lastCandleTime != null
    ? signal.lastCandleTime + intervalMs
    : Math.ceil(signal.signalTime / intervalMs) * intervalMs;
  const gapNow = closedCandles.length ? missingBars(closedCandles.map((c) => c.time), expectedFirst, intervalMs) : 0;
  const gapFlag = gapNow > P.GAP_TOLERANCE_BARS;
  const gapBars = (signal.gapBars || 0) + (gapFlag ? gapNow : 0);
  const integrity = signal.dataGap || gapFlag ? 'GAP' : 'OK';

  const touch = closedCandles.length
    ? firstTouch(closedCandles, signal.direction, signal.stopLoss, signal.takeProfit1, signal.takeProfit2)
    : null;

  if (touch) {
    const upto = closedCandles.slice(0, touch.index + 1);
    const exc = accumulateExcursions(signal, upto, signal.direction, signal.entryPrice);
    const level = { LOSS: signal.stopLoss, WIN_TP1: signal.takeProfit1, WIN_TP2: signal.takeProfit2 }[touch.result];
    const notes = [touch.note, integrity === 'GAP' ? `data gap while tracking (~${gapBars} missing bars) - first touch not verifiable` : null].filter(Boolean);
    await store.close(signal.id, {
      status: 'CLOSED',
      result: touch.result,
      resolvedAtMs: touch.atTime,
      resolvedAtIso: new Date(touch.atTime).toISOString(),
      note: notes.length ? notes.join('; ') : null,
      ambiguous: !!touch.ambiguous,
      integrity,
      gapBars,
      timeToResultMs: touch.atTime - signal.signalTime,
      resolvedPrice: level,
      actualMovePct: signedMovePct(signal.direction, signal.entryPrice, level),
      ...excursionFields(signal, exc),
    });
    return touch.result;
  }

  const exc = closedCandles.length
    ? accumulateExcursions(signal, closedCandles, signal.direction, signal.entryPrice)
    : { maeAbs: signal.maeAbs || 0, mfeAbs: signal.mfeAbs || 0 };
  const lastClose = closedCandles.length ? closedCandles[closedCandles.length - 1].close : null;

  if (now - signal.signalTime >= expireAfterMs) {
    await store.close(signal.id, {
      status: 'CLOSED',
      result: 'EXPIRED_UNRESOLVED',
      resolvedAtMs: now,
      resolvedAtIso: new Date(now).toISOString(),
      note: integrity === 'GAP' ? `data gap while tracking (~${gapBars} missing bars)` : null,
      ambiguous: false,
      integrity,
      gapBars,
      timeToResultMs: now - signal.signalTime,
      resolvedPrice: lastClose,
      actualMovePct: lastClose != null ? signedMovePct(signal.direction, signal.entryPrice, lastClose) : null,
      ...excursionFields(signal, exc),
    });
    return 'EXPIRED_UNRESOLVED';
  }

  if (closedCandles.length) {
    await store.update(signal.id, {
      lastCandleTime: closedCandles[closedCandles.length - 1].time,
      maeAbs: exc.maeAbs,
      mfeAbs: exc.mfeAbs,
      dataGap: integrity === 'GAP',
      gapBars,
    });
  }
  return null;
}

module.exports = { firstTouch, accumulateExcursions, excursionFields, resolveOpenSignal, signedMovePct };
