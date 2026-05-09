#!/usr/bin/env node
// Canonical Interwheel study runner.
//
// A study is a reproducible corpus run over the trusted pure simulator. It can
// sweep policy weights and metric parameters, while keeping difficulty and
// pastille spawn fixed by default for apples-to-apples comparisons.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GAME_FPS = 40;
const DEFAULT_POLICY = { climb: 1, wall: 0.5 };
const CLIMB_ONLY = { climb: 1, wall: 0 };
const DEFAULT_METRIC_PARAMS = { wallLandingBonus: 300, wallTickBonus: 5 };

const PRESETS = {
  smoke: {
    description: 'wiring check only',
    trials: 1,
    maxSeconds: 0.1,
    concurrency: 1,
    valueSet: 'smoke',
    paramPoints: 2,
    parityTrials: 1,
    paritySeconds: 5,
  },
  quick: {
    description: 'fast directional read',
    trials: 4,
    maxSeconds: 30,
    concurrency: 4,
    valueSet: 'quick',
    paramPoints: 4,
    parityTrials: 2,
    paritySeconds: 30,
  },
  standard: {
    description: 'default comparison run',
    trials: 16,
    maxSeconds: 120,
    concurrency: 12,
    valueSet: 'standard',
    paramPoints: 7,
    parityTrials: 3,
    paritySeconds: 30,
  },
  overnight: {
    description: 'larger corpus for final tuning',
    trials: 40,
    maxSeconds: 180,
    concurrency: 12,
    valueSet: 'standard',
    paramPoints: 9,
    parityTrials: 5,
    paritySeconds: 30,
  },
};

const METRICS = {
  wall: {
    label: 'Wall',
    policyKey: 'wall',
    mixPolicyWeight: 1,
    coefficientValues: {
      smoke: [0, 0.5, 1],
      quick: [0, 0.5, 0.9, 1.3, 2],
      standard: [0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.1, 1.3, 1.6, 2.0],
    },
    params: [
      {
        key: 'wallLandingBonus',
        range: [0, 600],
      },
      {
        key: 'wallTickBonus',
        range: [0, 12],
      },
    ],
  },
};

// Response curves are intentionally shared across metric studies. A wall study
// should focus on wallJ/min, wall%, and wall steer, but side effects such as
// climb speed or capture rate stay visible in the same report. The metric
// registry decides how to sweep; people decide which analytics matter.
// Derived analytics use generic formulas (`perMinute`, `percentTicks`,
// `ratio`) from raw trial facts, but the useful output list stays explicit so
// the report does not invent meaningless fields like seed/minute.
const RESPONSE_ANALYTICS = [
  { key: 'wallJumpsPerMin', label: 'wallJ/min', noiseFloor: 0.5 },
  { key: 'wallPercent', label: 'wall%', noiseFloor: 0.25 },
  { key: 'spreadRangeWall', label: 'wall steer', noiseFloor: 5 },
  { key: 'height', label: 'height', noiseFloor: 10 },
  { key: 'heightPerMin', label: 'h/min', noiseFloor: 10 },
  { key: 'scorePerMin', label: 'score/min', noiseFloor: 10 },
  { key: 'died', label: 'died%', noiseFloor: 1, scale: 100 },
  { key: 'captureRate', label: 'capture%', noiseFloor: 2, scale: 100 },
  { key: 'pastillesPerMin', label: 'past/min', noiseFloor: 1 },
  { key: 'uniquePerceivedPastilles', label: 'perceived', noiseFloor: 1 },
];

const SUMMARY_FIELDS = [
  'score',
  'durationSeconds',
  'heightPerSec',
  'runClimbMetersPerSec',
  'jumpsPerMin',
  'wheelJumpsPerMin',
  'sparksPerMin',
  'bonusScorePerMin',
  'pastilles',
  'sparks',
  'bonusScore',
  'flightPercent',
  'wheelPercent',
  'classifiedPercent',
  'wheelRevMedian',
  'wallDrifts',
  'planMs',
  'edges',
  'scoreClimb',
  'scoreWall',
  'scoreTotal',
  'spreadRangeClimb',
  ...RESPONSE_ANALYTICS.map((analytics) => analytics.key),
];

function parseArgs(argv) {
  const args = {
    preset: 'standard',
    suite: 'all',
    metric: 'all',
    trials: null,
    seedBase: 4200,
    maxSeconds: null,
    concurrency: null,
    budgetMs: 5,
    outDir: null,
    parity: false,
    parityTrials: null,
    paritySeconds: null,
    paramPoints: null,
    pastilleSpawnChance: 1.0,
    difficulty: 0.3,
    help: false,
  };

  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--parity') args.parity = true;
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length);
    else if (raw.startsWith('--suite=')) args.suite = raw.slice('--suite='.length);
    else if (raw.startsWith('--metric=')) args.metric = raw.slice('--metric='.length);
    else if (raw.startsWith('--trials=')) args.trials = Number(raw.slice('--trials='.length));
    else if (raw.startsWith('--seed=')) args.seedBase = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--seconds=')) args.maxSeconds = Number(raw.slice('--seconds='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--max-ticks=')) args.maxSeconds = Number(raw.slice('--max-ticks='.length)) / GAME_FPS;
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw.startsWith('--budget-ms=')) args.budgetMs = Number(raw.slice('--budget-ms='.length));
    else if (raw.startsWith('--out=')) args.outDir = raw.slice('--out='.length);
    else if (raw.startsWith('--param-points=')) args.paramPoints = Number(raw.slice('--param-points='.length));
    else if (raw.startsWith('--parity-trials=')) args.parityTrials = Number(raw.slice('--parity-trials='.length));
    else if (raw.startsWith('--parity-seconds=')) args.paritySeconds = Number(raw.slice('--parity-seconds='.length));
    else if (raw === '--pastille-spawn=natural') args.pastilleSpawnChance = null;
    else if (raw.startsWith('--pastille-spawn=')) args.pastilleSpawnChance = Number(raw.slice('--pastille-spawn='.length));
    else if (raw === '--difficulty=natural') args.difficulty = null;
    else if (raw.startsWith('--difficulty=')) args.difficulty = Number(raw.slice('--difficulty='.length));
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }

  if (!PRESETS[args.preset]) args.help = true;
  if (!['all', 'responsiveness', 'params'].includes(args.suite)) args.help = true;
  if (args.metric !== 'all' && !METRICS[args.metric]) args.help = true;

  const preset = PRESETS[args.preset] ?? PRESETS.standard;
  args.trials ??= preset.trials;
  args.maxSeconds ??= preset.maxSeconds;
  args.concurrency ??= preset.concurrency;
  args.paramPoints ??= preset.paramPoints;
  args.parityTrials ??= preset.parityTrials;
  args.paritySeconds ??= preset.paritySeconds;
  args.paramPoints = Math.max(2, Math.round(args.paramPoints));
  args.maxTicks = Math.max(1, Math.ceil(args.maxSeconds * GAME_FPS));
  args.parityTicks = Math.max(1, Math.ceil(args.paritySeconds * GAME_FPS));
  args.valueSet = preset.valueSet;
  return args;
}

function help() {
  const presets = Object.entries(PRESETS)
    .map(([name, p]) => `  ${name.padEnd(9)} ${p.trials} trials, ${p.maxSeconds}s, ${p.description}`)
    .join('\n');
  const metrics = Object.keys(METRICS).join(', ');
  console.log(`Interwheel study

USAGE:
  npm run analyze:interwheel:study -- --preset=quick
  npm run analyze:interwheel:study -- --suite=responsiveness --metric=wall
  npm run analyze:interwheel:study -- --suite=params --metric=wall --preset=standard
  npm run analyze:interwheel:study -- --preset=quick --parity
  npm run analyze:interwheel:study -- --suite=params --metric=wall --param-points=9

Presets:
${presets}

Suites:
  responsiveness  sweep policy weights, always mixed with climb
  params          sweep constants inside a metric with the policy mix fixed
  all             both suites

Metrics:
  ${metrics}

Defaults fix pastille spawn to 1.0 and generation difficulty to 0.3.
Use --pastille-spawn=natural or --difficulty=natural to disable an override.
Parity is opt-in with --parity.

Outputs raw.json, summary.json, and report.md under .tmp/interwheel-studies/<timestamp>/.
`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function selectedMetrics(args) {
  if (args.metric === 'all') return Object.entries(METRICS);
  return [[args.metric, METRICS[args.metric]]];
}

function valuesFor(valueSets, args) {
  return valueSets[args.valueSet] ?? valueSets.standard;
}

function linspace(min, max, points) {
  if (points <= 1) return [min];
  const step = (max - min) / (points - 1);
  return Array.from({ length: points }, (_, i) => {
    const value = min + step * i;
    return Math.abs(value) < 1e-9 ? 0 : Number(value.toFixed(6));
  });
}

function paramValuesFor(param, args) {
  return linspace(param.range[0], param.range[1], args.paramPoints);
}

function makeConditions(args) {
  const includeResponsiveness = args.suite === 'all' || args.suite === 'responsiveness';
  const includeParams = args.suite === 'all' || args.suite === 'params';
  const conditions = [
    {
      group: 'reference',
      suite: 'reference',
      metric: null,
      name: 'climb-only',
      axis: 'reference',
      value: 0,
      policy: { ...CLIMB_ONLY },
      metricParams: { ...DEFAULT_METRIC_PARAMS },
    },
    {
      group: 'reference',
      suite: 'reference',
      metric: null,
      name: 'default-current',
      axis: 'reference',
      value: 0.5,
      policy: { ...DEFAULT_POLICY },
      metricParams: { ...DEFAULT_METRIC_PARAMS },
    },
  ];

  for (const [metricName, metric] of selectedMetrics(args)) {
    if (includeResponsiveness) {
      for (const value of valuesFor(metric.coefficientValues, args)) {
        conditions.push({
          group: `mix:${metricName}`,
          suite: 'responsiveness',
          metric: metricName,
          name: `${metric.policyKey}=${value}`,
          axis: metric.policyKey,
          value,
          policy: { ...CLIMB_ONLY, [metric.policyKey]: value },
          metricParams: { ...DEFAULT_METRIC_PARAMS },
        });
      }
    }

    if (includeParams) {
      for (const param of metric.params) {
        for (const value of paramValuesFor(param, args)) {
          conditions.push({
            group: `param:${metricName}:${param.key}`,
            suite: 'params',
            metric: metricName,
            name: `${param.key}=${value}`,
            axis: param.key,
            value,
            policy: { ...CLIMB_ONLY, [metric.policyKey]: metric.mixPolicyWeight },
            metricParams: { ...DEFAULT_METRIC_PARAMS, [param.key]: value },
          });
        }
      }
    }
  }

  return conditions;
}

function makeChunks(trials, seedBase, workers) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < workers; i += 1) {
    const count = Math.floor(trials / workers) + (i < trials % workers ? 1 : 0);
    if (count > 0) {
      chunks.push({ trials: count, seedBase: seedBase + offset });
      offset += count;
    }
  }
  return chunks;
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => { throw err; });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('page console error:', msg.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__interwheelAnalytics__), null, { timeout: 30_000 });
  return page;
}

async function runParity(browser, url, args) {
  const page = await openPage(browser, url);
  try {
    const result = await page.evaluate(async ({ trials, seedBase, maxTicks, policy, pastilleSpawnChance, difficulty }) => {
      if (pastilleSpawnChance !== null) {
        window.__interwheelAnalytics__.setPastilleSpawnChanceOverride(pastilleSpawnChance);
      }
      if (difficulty !== null) {
        window.__interwheelAnalytics__.setGenerationDifficultyOverride(difficulty);
      }
      return await window.__interwheelAnalytics__.comparePurePlannerCorpus({
        trials,
        seedBase,
        maxTicks,
        policy,
      });
    }, {
      trials: args.parityTrials,
      seedBase: args.seedBase,
      maxTicks: args.parityTicks,
      policy: DEFAULT_POLICY,
      pastilleSpawnChance: args.pastilleSpawnChance,
      difficulty: args.difficulty,
    });
    return {
      enabled: true,
      kind: 'pure-planner-corpus',
      trials: args.parityTrials,
      maxTicks: args.parityTicks,
      seedBase: args.seedBase,
      equal: Boolean(result.equal),
      firstFailure: result.firstFailure ?? null,
    };
  } finally {
    await page.close();
  }
}

async function runCondition(browser, url, condition, args) {
  const chunks = makeChunks(args.trials, args.seedBase, Math.min(args.concurrency, args.trials));
  const started = performance.now();
  const partials = await Promise.all(chunks.map(async (chunk) => {
    const page = await openPage(browser, url);
    try {
      return await page.evaluate(async ({ chunk, condition, maxTicks, budgetMs, pastilleSpawnChance, difficulty }) => {
        if (pastilleSpawnChance !== null) {
          window.__interwheelAnalytics__.setPastilleSpawnChanceOverride(pastilleSpawnChance);
        }
        if (difficulty !== null) {
          window.__interwheelAnalytics__.setGenerationDifficultyOverride(difficulty);
        }
        const plannerConfig = {
          budgetMs,
          maxEdgeRollouts: 360,
          maxStableDepth: 4,
          revealScreensAbove: 0.5,
          collectSegments: false,
          policy: condition.policy,
          metricParams: condition.metricParams,
        };
        const trials = [];
        for (let i = 0; i < chunk.trials; i += 1) {
          trials.push(await window.__interwheelAnalytics__.runPureTrial(chunk.seedBase + i, maxTicks, plannerConfig));
        }
        return trials.map((trial) => compactTrial(trial, maxTicks));

        function compactTrial(trial, maxTicksLocal) {
          const summary = trial.analytics.summary;
          const planner = summary.planner;
          const ticks = trial.ticks;
          const durationSeconds = ticks / 40;
          const durationMinutes = durationSeconds / 60;
          const died = ticks < maxTicksLocal ? 1 : 0;
          const range = planner.leafScoreSpreadRange ?? {};
          const facts = {
            seed: trial.seed,
            height: trial.heightMeters,
            score: trial.score,
            ticks,
            durationSeconds,
            cpuMs: trial.cpuMs,
            died,
            deathCause: summary.deathCause,
            jumps: summary.jumps,
            wheelJumps: summary.wheelJumps,
            wallJumps: summary.wallJumps,
            pastilles: summary.pastilles,
            sparks: summary.sparks,
            bonusScore: summary.bonusScore,
            uniquePerceivedPastilles: trial.uniquePerceivedPastilles,
            flightTicks: summary.phaseTime.flightTicks,
            wheelTicks: summary.phaseTime.wheelTicks,
            wallTicks: summary.phaseTime.wallTicks,
            classifiedTicks: summary.phaseTime.classifiedTicks,
            wheelRevMedian: summary.wheelStayRevolutions.median,
            wallDrifts: summary.wallDrifts,
            planMs: trial.planner.avgPlanMs,
            edges: trial.planner.avgEdges,
            scoreClimb: planner.bestScoreBreakdown.climb?.mean ?? 0,
            scoreWall: planner.bestScoreBreakdown.wall?.mean ?? 0,
            scoreTotal: planner.bestScoreBreakdown.total?.mean ?? 0,
            spreadRangeClimb: range.climb?.mean ?? 0,
            spreadRangeWall: range.wall?.mean ?? 0,
          };
          const perMinute = (value) => (durationMinutes > 0 ? value / durationMinutes : 0);
          const perSecond = (value) => (durationSeconds > 0 ? value / durationSeconds : 0);
          const percentTicks = (value) => (ticks > 0 ? (100 * value) / ticks : 0);
          const ratio = (num, den) => (den > 0 ? num / den : 0);
          return {
            ...facts,
            heightPerSec: perSecond(facts.height),
            runClimbMetersPerSec: perSecond(facts.height),
            heightPerMin: perMinute(facts.height),
            scorePerMin: perMinute(facts.score),
            jumpsPerMin: perMinute(facts.jumps),
            wheelJumpsPerMin: perMinute(facts.wheelJumps),
            wallJumpsPerMin: perMinute(facts.wallJumps),
            pastillesPerMin: perMinute(facts.pastilles),
            sparksPerMin: perMinute(facts.sparks),
            bonusScorePerMin: perMinute(facts.bonusScore),
            flightPercent: percentTicks(facts.flightTicks),
            wheelPercent: percentTicks(facts.wheelTicks),
            wallPercent: percentTicks(facts.wallTicks),
            classifiedPercent: percentTicks(facts.classifiedTicks),
            captureRate: ratio(facts.pastilles, facts.uniquePerceivedPastilles),
          };
        }
      }, {
        chunk,
        condition,
        maxTicks: args.maxTicks,
        budgetMs: args.budgetMs,
        pastilleSpawnChance: args.pastilleSpawnChance,
        difficulty: args.difficulty,
      });
    } finally {
      await page.close();
    }
  }));
  return { ...condition, wallMs: performance.now() - started, trials: partials.flat() };
}

function stats(values) {
  if (values.length === 0) return { count: 0, mean: 0, median: 0, p10: 0, p90: 0, min: 0, max: 0, stdev: 0 };
  const sorted = values.slice().sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, sorted.length - 1);
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))];
  return {
    count: sorted.length,
    mean,
    median: at(0.5),
    p10: at(0.1),
    p90: at(0.9),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdev: Math.sqrt(variance),
  };
}

function summarizeCondition(condition) {
  const metrics = {};
  for (const field of [...new Set(SUMMARY_FIELDS)]) {
    metrics[field] = stats(condition.trials.map((trial) => trial[field] ?? 0));
  }
  return {
    group: condition.group,
    suite: condition.suite,
    metric: condition.metric,
    name: condition.name,
    axis: condition.axis,
    value: condition.value,
    policy: condition.policy,
    metricParams: condition.metricParams,
    trials: condition.trials.length,
    wallMs: condition.wallMs,
    metrics,
  };
}

function linearFit(points, noiseFloor = 0) {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length < 2) return { slope: 0, intercept: 0, r2: 0, maxStep: 0, range: 0, shape: 'insufficient' };
  const xMean = clean.reduce((sum, point) => sum + point.x, 0) / clean.length;
  const yMean = clean.reduce((sum, point) => sum + point.y, 0) / clean.length;
  const denom = clean.reduce((sum, point) => sum + (point.x - xMean) ** 2, 0);
  const slope = denom === 0 ? 0 : clean.reduce((sum, point) => sum + (point.x - xMean) * (point.y - yMean), 0) / denom;
  const intercept = yMean - slope * xMean;
  const ssTot = clean.reduce((sum, point) => sum + (point.y - yMean) ** 2, 0);
  const ssErr = clean.reduce((sum, point) => sum + (point.y - (slope * point.x + intercept)) ** 2, 0);
  const r2 = ssTot === 0 ? 1 : Math.max(0, 1 - ssErr / ssTot);
  const sorted = clean.slice().sort((a, b) => a.x - b.x);
  let maxStep = 0;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of sorted) {
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  for (let i = 1; i < sorted.length; i += 1) {
    maxStep = Math.max(maxStep, Math.abs(sorted[i].y - sorted[i - 1].y));
  }
  const range = maxY - minY;
  const tolerance = Math.max(Math.abs(range) * 0.05, 1e-9);
  let leadingFlatSteps = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    if (Math.abs(sorted[i].y - sorted[0].y) <= tolerance) leadingFlatSteps += 1;
    else break;
  }
  const maxStepRatio = range > 0 ? maxStep / range : 0;
  let shape = 'near-linear';
  if (range <= Math.max(noiseFloor, 1e-9)) shape = 'flat';
  else if (leadingFlatSteps >= 2) shape = 'dead-zone';
  else if (maxStepRatio >= 0.5) shape = 'jumpy';
  else if (r2 < 0.85) shape = 'nonlinear';
  return { slope, intercept, r2, maxStep, range, leadingFlatSteps, shape };
}

function responseCurves(summaries) {
  const out = {};
  const groups = [...new Set(summaries.map((summary) => summary.group).filter((group) => group.includes(':')))];
  for (const group of groups) {
    const rows = summaries.filter((summary) => summary.group === group).sort((a, b) => a.value - b.value);
    out[group] = {};
    for (const analytics of RESPONSE_ANALYTICS) {
      const scale = analytics.scale ?? 1;
      out[group][analytics.key] = {
        label: analytics.label,
        ...linearFit(rows.map((row) => ({
          x: row.value,
          y: row.metrics[analytics.key].mean * scale,
        })), analytics.noiseFloor),
      };
    }
  }
  return out;
}

function summarize(raw, meta) {
  const summaries = raw.map(summarizeCondition);
  return { meta, summaries, responseCurves: responseCurves(summaries) };
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function reportMarkdown(summary) {
  const lines = [
    '# Interwheel Study',
    '',
    `- preset: ${summary.meta.preset}`,
    `- suite: ${summary.meta.suite}`,
    `- metrics: ${summary.meta.metrics.join(', ')}`,
    `- trials per condition: ${summary.meta.trials}`,
    `- max seconds: ${fmt(summary.meta.maxTicks / GAME_FPS, 1)}`,
    `- seed base: ${summary.meta.seedBase}`,
    `- parameter points: ${summary.meta.paramPoints}`,
    `- pastille spawn: ${summary.meta.pastilleSpawnChance ?? 'natural'}`,
    `- difficulty: ${summary.meta.difficulty ?? 'natural'}`,
    `- parity: ${summary.meta.parity.enabled ? (summary.meta.parity.equal ? 'passed' : 'failed') : 'not run'}`,
    `- wall seconds: ${fmt(summary.meta.wallSeconds, 1)}`,
    '',
    '## Headline',
    '',
    '| condition | policy | metric params | h(m) | h/min | score/min | wallJ/min | wall% | died | capture% | perceived | past/min | wall steer |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const s of summary.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${policyLabel(s.policy)} | ${metricLabel(s.metricParams)} | ` +
      `${fmt(m.height.mean, 0)} | ${fmt(m.heightPerMin.mean, 1)} | ${fmt(m.scorePerMin.mean, 1)} | ` +
      `${fmt(m.wallJumpsPerMin.mean, 1)} | ${fmt(m.wallPercent.mean, 1)} | ` +
      `${fmt(m.died.mean * 100, 0)}% | ${fmt(m.captureRate.mean * 100, 1)}% | ` +
      `${fmt(m.uniquePerceivedPastilles.mean, 1)} | ${fmt(m.pastillesPerMin.mean, 1)} | ` +
      `${fmt(m.spreadRangeWall.mean, 0)} |`,
    );
  }

  lines.push('', '## Response Curves', '');
  lines.push('Each row is one tracked analytic plotted against the swept value. Not every row is the target behavior of the metric; some rows are tradeoffs or side effects.', '');
  lines.push('Shape is a compact warning label for the response curve: flat, dead-zone, jumpy, nonlinear, or near-linear.', '');

  for (const [group, metrics] of Object.entries(summary.responseCurves)) {
    lines.push(`### ${group}`, '');
    lines.push('| analytic | shape | slope | r2 | maxStep | range |');
    lines.push('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const [metric, fit] of Object.entries(metrics)) {
      lines.push(`| ${fit.label ?? metric} | ${fit.shape} | ${fmt(fit.slope, 3)} | ${fmt(fit.r2, 3)} | ${fmt(fit.maxStep, 2)} | ${fmt(fit.range, 2)} |`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}

function policyLabel(policy) {
  return Object.entries(policy).map(([key, value]) => `${key}=${value}`).join(',');
}

function metricLabel(metricParams) {
  return Object.entries(metricParams).map(([key, value]) => `${key}=${value}`).join(',');
}

function printConditionSummary(result) {
  const m = summarizeCondition(result).metrics;
  console.log(
    `  h=${m.height.mean.toFixed(1)}m h/min=${m.heightPerMin.mean.toFixed(1)} score/min=${m.scorePerMin.mean.toFixed(1)} ` +
    `wallJ=${m.wallJumpsPerMin.mean.toFixed(1)}/min wall=${m.wallPercent.mean.toFixed(1)}% ` +
    `capture=${(m.captureRate.mean * 100).toFixed(1)}% died=${(m.died.mean * 100).toFixed(0)}%`,
  );
}

function printResponseCurves(summary) {
  for (const [group, metrics] of Object.entries(summary.responseCurves)) {
    const compact = Object.entries(metrics)
      .map(([metric, fit]) => `${fit.label ?? metric}:${fit.shape},r2=${fit.r2.toFixed(2)},step=${fit.maxStep.toFixed(1)}`)
      .join('  ');
    console.log(`${group}  ${compact}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }
  const conditions = makeConditions(args);
  const outDir = args.outDir ?? join('.tmp', 'interwheel-studies', timestamp());
  await mkdir(outDir, { recursive: true });

  const server = await createServer({
    server: { host: '127.0.0.1', port: 0 },
    logLevel: 'error',
    clearScreen: false,
    appType: 'spa',
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing Vite server address');
  const browser = await chromium.launch();
  const url = `http://127.0.0.1:${address.port}/analyze-interwheel.html`;
  const started = performance.now();

  try {
    let parity = { enabled: false };
    if (args.parity) {
      console.log(`parity: ${args.parityTrials} trials, ${args.paritySeconds}s`);
      parity = await runParity(browser, url, args);
      console.log(`  ${parity.equal ? 'passed' : 'failed'}`);
      if (!parity.equal) {
        throw new Error('pure planner parity failed; rerun without --parity only if you intentionally want to ignore it');
      }
    }

    const raw = [];
    for (let i = 0; i < conditions.length; i += 1) {
      const condition = conditions[i];
      console.log(`[${i + 1}/${conditions.length}] ${condition.group} ${condition.name}`);
      const result = await runCondition(browser, url, condition, args);
      raw.push(result);
      printConditionSummary(result);
    }

    const meta = {
      preset: args.preset,
      suite: args.suite,
      metrics: selectedMetrics(args).map(([name]) => name),
      trials: args.trials,
      seedBase: args.seedBase,
      maxTicks: args.maxTicks,
      concurrency: args.concurrency,
      paramPoints: args.paramPoints,
      budgetMs: args.budgetMs,
      pastilleSpawnChance: args.pastilleSpawnChance,
      difficulty: args.difficulty,
      conditions: conditions.length,
      parity,
      wallSeconds: (performance.now() - started) / 1000,
    };
    const summary = summarize(raw, meta);
    await writeFile(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(outDir, 'report.md'), reportMarkdown(summary));
    printResponseCurves(summary);
    console.log(JSON.stringify({ outDir, ...meta }, null, 2));
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
