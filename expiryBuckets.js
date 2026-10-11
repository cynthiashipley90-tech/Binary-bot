// Central definition of expiry "buckets". Everything that needs to treat
// different expiries independently (calibration storage, win-rate
// reporting, the NO_TRADE horizon-vs-lookback check) pulls from here so a
// "1 minute" trade and a "60 minute" trade are never silently merged into
// one statistic.
//
// Boundaries chosen to separate the durations the user explicitly listed
// (1m, 2m, 3m, 5m, 10m, 15m, 30m, 60m) into buckets that behave differently
// in practice: sub-2m is close to pure noise, 2-5m still short, 5-10m and
// 10-20m are where short-term technicals start to matter more than raw
// drift, 20-90m is where multi-timeframe confirmation matters, 90m+ is
// long-horizon and needs the most caution.
const BUCKETS = [
  { key: '0-2m', label: '≤2 min', maxMinutes: 2 },
  { key: '2-5m', label: '2-5 min', maxMinutes: 5 },
  { key: '5-10m', label: '5-10 min', maxMinutes: 10 },
  { key: '10-20m', label: '10-20 min', maxMinutes: 20 },
  { key: '20-40m', label: '20-40 min', maxMinutes: 40 },
  { key: '40-90m', label: '40-90 min', maxMinutes: 90 },
  { key: '90m+', label: '90+ min', maxMinutes: Infinity },
];

function getExpiryBucket(minutes) {
  const m = Number(minutes);
  const bucket = BUCKETS.find((b) => m <= b.maxMinutes) || BUCKETS[BUCKETS.length - 1];
  return { key: bucket.key, label: bucket.label };
}

function allBucketKeys() {
  return BUCKETS.map((b) => b.key);
}

function bucketLabel(key) {
  return BUCKETS.find((b) => b.key === key)?.label || key;
}

// A representative pool of "natural" duration candidates spanning every
// bucket above. This is NOT a preference order and is not itself the
// selection logic - it is just the pool services/expirySelection.js draws
// candidates from before filtering/scoring them on real evidence. Keeping
// it here (not duplicated in expirySelection.js) means the candidate pool
// and the bucket boundaries it's meant to span can never drift apart.
const REPRESENTATIVE_MINUTES = [1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 480, 720, 1440];
function representativeMinutes() {
  return REPRESENTATIVE_MINUTES.slice();
}

module.exports = {
  getExpiryBucket, allBucketKeys, bucketLabel, representativeMinutes, BUCKETS,
};
