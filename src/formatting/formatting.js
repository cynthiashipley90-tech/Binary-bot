const binaryEngine = require('../services/binaryEngine');

function fmtNum(n, decimals = null) {
  if (n === null || n === undefined) return '-';
  if (decimals !== null) return Number(n).toFixed(decimals);
  // auto precision: more decimals for low-priced assets
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 4 : 6;
  return Number(n).toFixed(d);
}

function regimeLine(regime) {
  const parts = [regime.primary];
  if (regime.volatility && regime.volatility !== 'UNKNOWN') parts.push(`${regime.volatility} volatility`);
  let line = parts.join(', ');
  if (regime.volatilityPercentile != null) {
    line += ` (${regime.volatilityPercentile}th percentile vs this pair's recent range)`;
  }
  return line;
}

function formatBinarySignalMessage(signal, opts = {}) {
  const durationLabel = binaryEngine.formatMinutes(signal.durationMinutes);
  const expiryPerf = opts.expiryPerf;
  const priceAccuracy = opts.priceAccuracy;

  const lines = [
    `*${signal.symbol} - Binary/Time-based Signal*`,
    '',
    `Direction: *${signal.direction}*${signal.direction === 'NO_TRADE' ? ' (no trade taken)' : ''}`,
    `Entry Price: ${fmtNum(signal.entryPrice)}`,
    `Expiry: ${durationLabel} (bucket: ${signal.expiryBucket.label})`,
    `Expires At: ${signal.expiresAtIso} (target expiry instant - resolved at settlement from the nearest real 1-minute-bar open/close within ~30s of this instant; see README for the exact-timestamp methodology and its resolution limit)`,
    `Market Regime: ${regimeLine(signal.regime)}`,
  ];

  // ---- Requested-expiry vs alternative-expiry evaluation ----
  const sel = signal.expirySelection;
  if (sel) {
    lines.push('', `Requested Expiry Assessment: ${sel.requestedAssessment}`);
    if (sel.alternative) {
      lines.push(
        `⚠️ Alternative Expiry: ${sel.alternative.label} has materially stronger validated evidence - ${sel.alternative.reasons.join('; ')}.`
      );
    } else if (sel.note) {
      lines.push(sel.note);
    }
  }

  lines.push(
    '',
    `Model (raw) Probability: ${signal.rawProbability}% - this is what the drift/volatility math computed, NOT a claim about real-world accuracy`,
    `Calibrated Probability: ${signal.calibratedProbability}%` +
      ` (from ${signal.calibrationSampleSize} closed trade${signal.calibrationSampleSize === 1 ? '' : 's'} in this exact expiry+probability bucket` +
      `${signal.calibrationLowConfidence ? ', still building - treat as provisional' : ''})` +
      (signal.calibrationRecentSampleSize
        ? ` [recent ${signal.calibrationRecentSampleSize}: ${signal.calibrationRecentWinRatePct}%]`
        : ''),
  );

  if (expiryPerf && expiryPerf.total > 0) {
    lines.push(
      `Historical Accuracy (${signal.expiryBucket.label} expiries, all setups): ${expiryPerf.winRatePct}% (n=${expiryPerf.total})`
    );
  } else {
    lines.push(`Historical Accuracy (${signal.expiryBucket.label} expiries): no completed trades yet in this bucket`);
  }

  if (priceAccuracy && priceAccuracy.sampleSize > 0) {
    lines.push(
      `Expiry-Price Accuracy (${signal.expiryBucket.label}, real settled trades): bias ${priceAccuracy.biasPct >= 0 ? '+' : ''}${priceAccuracy.biasPct}%, avg error ${priceAccuracy.maePct}%` +
      ` (n=${priceAccuracy.sampleSize}${priceAccuracy.lowConfidence ? ', still building - provisional' : ''})`
    );
  } else {
    lines.push(`Expiry-Price Accuracy (${signal.expiryBucket.label}): no settled trades yet to compare predicted vs actual expiry price`);
  }

  lines.push(`Confidence/Quality: ${signal.qualityLabel}${signal.highTrust ? ' 🔥 HIGH-TRUST SETUP' : ''}`);

  if (signal.direction === 'NO_TRADE') {
    lines.push('', 'Why NO TRADE:', ...signal.noTradeReasons.map((r) => `- ${r}`));
    lines.push(
      '',
      `(For reference, the raw math leaned ${signal.rawDirection} - shown for transparency only, not a signal to act on.)`
    );
  } else {
    const finalCp = signal.checkpoints[signal.checkpoints.length - 1];
    lines.push(
      '',
      `Expected Expiry Price: **${fmtNum(signal.expectedExpiryPrice)}** (likely range ${fmtNum(finalCp.rangeLow)} - ${fmtNum(finalCp.rangeHigh)})`,
      `Expected Move: ${signal.expectedMoveAmount >= 0 ? '+' : ''}${fmtNum(signal.expectedMoveAmount)} (${signal.expectedMovePct >= 0 ? '+' : ''}${signal.expectedMovePct}%) from entry, direction *${signal.direction}*`
    );
  }

  lines.push('', `Structure: ${signal.structure.pattern}`);

  if (signal.supportResistance.support || signal.supportResistance.resistance) {
    const s = signal.supportResistance.support;
    const r = signal.supportResistance.resistance;
    lines.push(
      `Nearest levels: ${s ? `support ${fmtNum(s.price)} (${s.touches}x touched, strength ${s.strength ?? '-'})` : 'no clear support nearby'} | ` +
      `${r ? `resistance ${fmtNum(r.price)} (${r.touches}x touched, strength ${r.strength ?? '-'})` : 'no clear resistance nearby'}`
    );
  }
  if (signal.breakout) {
    const b = signal.breakout;
    const bits = [b.type.replace(/_/g, ' ').toLowerCase()];
    bits.push(b.retested ? 'retested' : 'not yet retested');
    if (b.quality != null) bits.push(`quality ${b.quality}`);
    if (b.volumeConfirmed === true) bits.push('volume-confirmed');
    else if (b.volumeConfirmed === false) bits.push('NOT volume-confirmed');
    if (b.falseBreakout) bits.push('⚠️ FALSE BREAKOUT (failed)');
    lines.push(`Breakout: ${bits.join(', ')}`);
  }
  if (signal.multiTimeframe) {
    const agreeLabel = signal.multiTimeframe.agreement === false
      ? 'DISAGREES with native timeframe'
      : signal.multiTimeframe.agreement === true
        ? 'agrees with native timeframe'
        : 'no strong opinion either way';
    lines.push(`Higher-timeframe (${signal.multiTimeframe.label}) tilt: ${signal.multiTimeframe.tilt} - ${agreeLabel}`);
  }

  // ---- Volume ----
  if (signal.volume && signal.volume.available) {
    const v = signal.volume;
    lines.push(
      `Volume: RVOL ${v.rvol ?? '-'}${v.spike ? ' 🔺SPIKE' : ''}, trend ${v.trend}, price/volume: ${v.priceVolumeRelationship}`
    );
  } else {
    lines.push(`Volume: unavailable${signal.volume?.reason ? ` (${signal.volume.reason})` : ' for this instrument'}`);
  }

  // ---- Candle quality ----
  if (signal.candleQuality && signal.candleQuality.available) {
    const cq = signal.candleQuality;
    lines.push(`Candle: body ${Math.round(cq.bodyRatio * 100)}% of range${cq.tags.length ? `, ${cq.tags.join(', ')}` : ''}`);
  }

  // ---- Divergences ----
  if (signal.divergences && signal.divergences.length) {
    lines.push(
      `Divergence: ${signal.divergences.map((d) => `${d.type} ${d.kind} ${d.direction}${d.confirmed ? ' (confirmed)' : ' (unconfirmed)'}`).join('; ')}`
    );
  }

  // ---- Session ----
  if (signal.session) {
    lines.push(`Session: ${signal.session.session} (${signal.session.weekdayLabel}, ${signal.session.hourUTC}:00 UTC)`);
  }

  if (signal.dataQualityIssues && signal.dataQualityIssues.length) {
    lines.push(`Data quality notes: ${signal.dataQualityIssues.join('; ')}`);
  }

  lines.push(
    '',
    'Confluence (grouped so correlated indicators don\'t get double-counted):',
    ...Object.entries(signal.confluenceGroupScores).map(([g, s]) => `- ${g}: ${s > 0 ? '+' : ''}${s}`),
    '',
    'Individual factors (strongest first):',
    ...signal.confluenceBreakdown.slice(0, 10).map((f) => `- [${f.group}] ${f.factor}: ${f.score > 0 ? '+' : ''}${f.score}`),
    ''
  );

  if (signal.nextCandleForecast) {
    const ncf = signal.nextCandleForecast;
    lines.push('', `*Next-Candle Forecast* (NEXT CANDLE TIMEFRAME: ${ncf.timeframeLabel} - a separate layer; this does NOT override the expiry decision above):`);
    if (signal.recentCandles?.length) {
      const recentStr = signal.recentCandles.map((c, i) => {
        const label = i === signal.recentCandles.length - 1 ? 'current' : 'previous';
        return `${label}: ${c.color}${c.namedPattern ? ` (${c.namedPattern})` : ''}`;
      }).join(' | ');
      lines.push(`- Recent candles at this timeframe: ${recentStr}`);
    }
    if (ncf.probabilityGreenPct == null) {
      lines.push(`- Direction: UNCERTAIN - ${ncf.expectedStructure}`);
    } else {
      lines.push(
        `- Direction: ${ncf.direction} (green ${ncf.probabilityGreenPct}% / red ${ncf.probabilityRedPct}%), confidence ${ncf.confidence}`,
        `- Expected Structure: ${ncf.expectedStructure}`,
        `- Expected Open/Close: ${fmtNum(ncf.expectedOpen)} -> ${fmtNum(ncf.expectedClose)} (${ncf.expectedMovePct >= 0 ? '+' : ''}${ncf.expectedMovePct}%)`,
        `- Expected High/Low: ${fmtNum(ncf.expectedHigh)} - ${fmtNum(ncf.expectedLow)}`,
        `- Key evidence: ${ncf.evidence.slice(0, 2).join('; ')}`
      );
    }
  }

  if (signal.direction !== 'NO_TRADE') {
    lines.push(
      'Checkpoints along the way (raw model math, NOT individually calibrated - only the Expiry checkpoint above has a calibrated probability):',
      ...signal.checkpoints.map((cp) =>
        `- ${cp.label}: ${cp.direction} ${cp.probabilityPct}% (raw) - expected ~${fmtNum(cp.predictedPrice)} (range ${fmtNum(cp.rangeLow)}-${fmtNum(cp.rangeHigh)})`
      ),
      ''
    );
  }
  if (signal.durationMinutes < 1) {
    lines.push(
      '_Sub-minute duration: extrapolated below the native 1-minute candle',
      'resolution, so treat this as a rougher estimate than 1min+ signals._'
    );
  }
  lines.push(
    '_Estimate on the real market feed (Twelve Data), not Quotex\'s own OTC',
    'price - see README for why those can differ. Calibrated probability and',
    'historical accuracy are only as good as the sample size shown next to',
    'them - small samples are noisy. Analysis only, not financial advice._'
  );
  return lines.join('\n');
}

function formatBinaryStatsMessage(stats) {
  const lines = [
    '*Binary Signal Accuracy*',
    `Total Completed Signals: ${stats.totalSignals}`,
    `Wins: ${stats.wins}`,
    `Losses: ${stats.losses}`,
    `Overall Win Rate: ${stats.winRate}% (this is the actual historical win rate, not a model probability)`,
    `No-Result (expiry price could not be reliably resolved): ${stats.noResultCount || 0}`,
  ];

  if (stats.expiryPerf?.length) {
    lines.push('', 'Win rate by expiry length (actual, not model probability):');
    stats.expiryPerf.forEach((e) => {
      lines.push(`- ${e.label}: ${e.winRatePct}% (n=${e.total})`);
    });
  } else {
    lines.push('', 'Win rate by expiry length: no completed trades yet.');
  }

  if (stats.expiryPriceAccuracy?.length) {
    const withSamples = stats.expiryPriceAccuracy.filter((p) => p.sampleSize > 0);
    if (withSamples.length) {
      lines.push('', 'Expected vs actual expiry price - bias/error by expiry length (separate from win rate above):');
      withSamples.forEach((p) => {
        const flag = p.lowConfidence ? ' (small sample)' : '';
        lines.push(`- ${p.label}: bias ${p.biasPct >= 0 ? '+' : ''}${p.biasPct}%, avg error ${p.maePct}% (n=${p.sampleSize})${flag}`);
      });
    }
  }

  if (stats.regimePerf?.length) {
    lines.push('', 'Win rate by market regime (5+ samples shown with more trust):');
    stats.regimePerf.forEach((r) => {
      const flag = r.total < 5 ? ' (small sample)' : '';
      lines.push(`- ${r.regime}: ${r.winRatePct}% (n=${r.total})${flag}`);
    });
  }

  if (stats.checkpointAccuracy?.length) {
    lines.push('', 'Raw-math accuracy by checkpoint fraction (all expiries pooled - diagnostic only):');
    stats.checkpointAccuracy.forEach((c) => {
      lines.push(`- ${c.label}: ${c.accuracyPct}% (n=${c.total})`);
    });
  }

  if (stats.sessionPerf?.length) {
    lines.push('', 'Win rate by session/time-of-day:');
    stats.sessionPerf.forEach((s) => {
      const flag = s.total < 5 ? ' (small sample)' : '';
      lines.push(`- ${s.key}: ${s.winRatePct}% (n=${s.total})${flag}`);
    });
  }

  if (stats.featurePerf?.length) {
    lines.push('', 'Feature-importance (#16 - real recorded outcomes, present vs. absent, not theory):');
    stats.featurePerf.forEach((f) => {
      const flag = f.total < 10 ? ' (small sample)' : '';
      lines.push(`- ${f.key}: ${f.winRatePct}% (n=${f.total})${flag}`);
    });
    lines.push('  (compare "<flag>:true" vs "<flag>:false" rows for the same flag to see if it actually helps)');
  }

  if (stats.groupPerf?.length) {
    lines.push('', 'Confluence-group standalone accuracy (real settled trades: how often each group\'s OWN lean matched the actual outcome - evidence for/against the fixed GROUP_WEIGHTS priors, which are NOT auto-adjusted from this):');
    stats.groupPerf.forEach((g) => {
      const flag = g.total < 30 ? ' (small sample - not enough to justify changing any weight)' : '';
      lines.push(`- ${g.key}: ${g.winRatePct}% (n=${g.total})${flag}`);
    });
  }

  lines.push(
    '',
    '_If a bucket above shows a small n, treat its win rate as noisy, not settled -',
    'this bot reports whatever the real numbers are, including when they are weak._'
  );

  return lines.join('\n');
}

function formatBinarySignalJourney(s) {
  const lines = [
    `*${s.symbol} - predicted ${s.direction}*`,
    `Entry: ${fmtNum(s.entryPrice)}`,
    `Close (${s.durationMinutes}min later): ${fmtNum(s.closePrice)}`,
    `Result: ${s.result}`,
  ];
  if (s.nearMissNote) lines.push('', s.nearMissNote);
  return lines.join('\n');
}

module.exports = {
  formatBinarySignalMessage,
  formatBinaryStatsMessage,
  formatBinarySignalJourney,
};
