export const DEFAULT_SWEEP_FIELDS = [
  'height',
  'score',
  'jumpsPerMin',
  'wallJumpsPerMin',
  'wheelJumpsPerMin',
  'pastillesPerMin',
  'sparksPerMin',
  'bonusScorePerMin',
  'flightPercent',
  'wheelPercent',
  'wallPercent',
  'wheelRevMedian',
  'planMs',
  'edges',
  'scoreHeightTerm',
  'scoreCollectTerm',
  'scoreWallTerm',
  'scorePaceCost',
  'scoreTotal',
];

export function stats(values) {
  if (values.length === 0) {
    return { count: 0, mean: 0, median: 0, p10: 0, p90: 0, stdev: 0, min: 0, max: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const mean = sorted.reduce((sum, value) => sum + value, 0) / count;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, count - 1);
  const at = (p) => sorted[Math.min(count - 1, Math.max(0, Math.floor(p * count)))];
  return {
    count,
    mean,
    median: at(0.5),
    p10: at(0.1),
    p90: at(0.9),
    stdev: Math.sqrt(variance),
    min: sorted[0],
    max: sorted[count - 1],
  };
}

export function pctDelta(value, base) {
  return base === 0 ? 0 : ((value - base) / Math.abs(base)) * 100;
}

export function cohenD(values, baselineValues) {
  const a = stats(values);
  const b = stats(baselineValues);
  const pooled = Math.sqrt(
    (((a.count - 1) * a.stdev ** 2) + ((b.count - 1) * b.stdev ** 2)) /
      Math.max(1, a.count + b.count - 2),
  );
  return pooled > 0 ? (a.mean - b.mean) / pooled : 0;
}

export function slope(points) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const xMean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const yMean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const denom = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  if (denom === 0) return 0;
  return xs.reduce((sum, x, i) => sum + (x - xMean) * (ys[i] - yMean), 0) / denom;
}

export function compactTrial(trial) {
  const summary = trial.analytics.summary;
  const planner = summary.planner;
  return {
    seed: trial.seed,
    height: trial.heightMeters,
    score: trial.score,
    ticks: trial.ticks,
    cpuMs: trial.cpuMs,
    jumpsPerMin: summary.actionsPerMinute.jumpsPerMinute,
    wallJumpsPerMin: summary.actionsPerMinute.wallJumpsPerMinute,
    wheelJumpsPerMin: summary.actionsPerMinute.wheelJumpsPerMinute,
    pastillesPerMin: summary.actionsPerMinute.pastillesPerMinute,
    sparksPerMin: summary.actionsPerMinute.sparksPerMinute,
    bonusScorePerMin: summary.actionsPerMinute.bonusScorePerMinute,
    flightPercent: summary.phaseTime.flightPercent,
    wheelPercent: summary.phaseTime.wheelPercent,
    wallPercent: summary.phaseTime.wallPercent,
    wheelRevMedian: summary.wheelStayRevolutions.median,
    wallDrifts: summary.wallDrifts,
    pastilles: summary.pastilles,
    sparks: summary.sparks,
    bonusScore: summary.bonusScore,
    planMs: trial.planner.avgPlanMs,
    edges: trial.planner.avgEdges,
    scoreHeightTerm: planner.bestScoreBreakdown.height.mean,
    scoreCollectTerm: planner.bestScoreBreakdown.collectibles.mean,
    scoreWallTerm: planner.bestScoreBreakdown.wallRoute.mean,
    scorePaceCost: planner.bestScoreBreakdown.paceCost.mean,
    scoreTotal: planner.bestScoreBreakdown.total.mean,
  };
}

export function summarizeCondition(condition, trials, baseline, fields = DEFAULT_SWEEP_FIELDS) {
  const metrics = {};
  for (const field of fields) {
    const values = trials.map((trial) => trial[field]);
    const s = stats(values);
    const baseValues = baseline?.trials.map((trial) => trial[field]) ?? values;
    const base = stats(baseValues);
    metrics[field] = {
      ...s,
      deltaMean: s.mean - base.mean,
      deltaPct: pctDelta(s.mean, base.mean),
      cohenD: baseline ? cohenD(values, baseValues) : 0,
    };
  }
  return { ...condition, trials: trials.length, metrics };
}

export function compactTable(summaries, fields) {
  return summaries.map((summary) => {
    const row = { group: summary.group, name: summary.name };
    for (const field of fields) {
      row[field] = Math.round(summary.metrics[field].mean * 100) / 100;
      row[`${field}DeltaPct`] = Math.round(summary.metrics[field].deltaPct * 10) / 10;
      row[`${field}D`] = Math.round(summary.metrics[field].cohenD * 100) / 100;
    }
    return row;
  });
}

export function pairedDeltas(condition, baseline, fields) {
  const baselineBySeed = new Map(baseline.trials.map((trial) => [trial.seed, trial]));
  const out = {};
  for (const field of fields) {
    const deltas = condition.trials
      .filter((trial) => baselineBySeed.has(trial.seed))
      .map((trial) => trial[field] - baselineBySeed.get(trial.seed)[field]);
    out[field] = {
      ...stats(deltas),
      positivePercent: deltas.length > 0
        ? (100 * deltas.filter((value) => value > 0).length) / deltas.length
        : 0,
    };
  }
  return out;
}

export function analyzeSlopes(summaries) {
  const out = {};
  const groups = [...new Set(summaries.map((summary) => summary.group).filter((group) => group.startsWith('sweep:')))];
  for (const group of groups) {
    const rows = summaries.filter((summary) => summary.group === group);
    const knob = rows[0]?.knob;
    out[knob] = {};
    for (const metric of ['height', 'wallJumpsPerMin', 'bonusScorePerMin', 'pastillesPerMin', 'jumpsPerMin', 'flightPercent']) {
      out[knob][metric] = slope(rows.map((row) => ({ x: row.value, y: row.metrics[metric].mean })));
    }
  }
  return out;
}

export function summarizeSweep(raw) {
  const baseline = raw.find((condition) => condition.name === 'default') ?? raw[0] ?? null;
  const summaries = raw.map((condition) => summarizeCondition(condition, condition.trials, baseline));
  const paired = baseline
    ? raw
      .filter((condition) => condition !== baseline)
      .map((condition) => ({
        group: condition.group,
        name: condition.name,
        deltas: pairedDeltas(condition, baseline, ['height', 'bonusScorePerMin', 'wallJumpsPerMin', 'jumpsPerMin']),
      }))
    : [];
  return {
    summaries,
    paired,
    slopes: analyzeSlopes(summaries),
    baseline: baseline?.name ?? null,
    sweepTables: Object.fromEntries(
      [...new Set(summaries.map((summary) => summary.group).filter((group) => group.startsWith('sweep:')))]
        .map((group) => [group, compactTable(summaries.filter((summary) => summary.group === group), ['height', 'bonusScorePerMin', 'wallJumpsPerMin'])]),
    ),
    interactionTable: compactTable(summaries.filter((summary) => summary.group === 'collectibles_wallRoutes'), ['height', 'bonusScorePerMin', 'wallJumpsPerMin']),
  };
}
