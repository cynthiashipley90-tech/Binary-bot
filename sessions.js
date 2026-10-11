// ---- Trading session / time-of-day classification ----
// Pure function of a UTC timestamp - takes the CANDLE's own time (not
// wall-clock "now"), so this behaves identically live and inside the
// walk-forward backtester, exactly like regime.js and structure.js.
//
// Session hours are the conventional approximate forex-market windows
// (UTC, ignoring DST shifts for simplicity - a known, documented
// simplification, not a hidden one):
//   Asian:    00:00-08:00 UTC (Tokyo/Sydney)
//   London:   08:00-16:00 UTC
//   New York: 13:00-21:00 UTC
//   Overlap:  13:00-16:00 UTC (London+NY together - historically the
//             highest-liquidity window)
// Anything outside all three is OFF_HOURS (thin liquidity, e.g. late US /
// early Asian gap).

function classifySession(timestampMs) {
  const d = new Date(timestampMs);
  const hourUTC = d.getUTCHours();
  const weekday = d.getUTCDay(); // 0=Sunday..6=Saturday

  const inAsian = hourUTC >= 0 && hourUTC < 8;
  const inLondon = hourUTC >= 8 && hourUTC < 16;
  const inNewYork = hourUTC >= 13 && hourUTC < 21;
  const overlap = inLondon && inNewYork;

  let session;
  if (overlap) session = 'LONDON_NY_OVERLAP';
  else if (inLondon) session = 'LONDON';
  else if (inNewYork) session = 'NEW_YORK';
  else if (inAsian) session = 'ASIAN';
  else session = 'OFF_HOURS';

  const weekdayLabel = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'][weekday];
  const isWeekend = weekday === 0 || weekday === 6;

  return { session, hourUTC, weekday, weekdayLabel, isWeekend };
}

module.exports = { classifySession };
