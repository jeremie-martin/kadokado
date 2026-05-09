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
import { availableParallelism } from 'node:os';

const GAME_FPS = 40;
const CLIMB_ONLY = { climb: 1, wall: 0 };
const CLIMB_METRIC_MODES = ['legacy', 'time-cost', 'wait-cost'];

const PRESETS = {
  smoke: {
    description: 'wiring check only',
    trials: 1,
    maxSeconds: 30,
    revealScreensAbove: 0.5,
    maxStableDepth: 4,
    maxEdgeRollouts: 240,
    budgetMs: 2,
    valueSet: 'smoke',
    paramPoints: 2,
  },
  quick: {
    description: 'fast directional read',
    trials: 4,
    maxSeconds: 60,
    revealScreensAbove: 0.5,
    maxStableDepth: 4,
    maxEdgeRollouts: 360,
    budgetMs: 5,
    valueSet: 'quick',
    paramPoints: 4,
  },
  standard: {
    description: 'default comparison run',
    trials: 16,
    maxSeconds: 120,
    revealScreensAbove: 0.5,
    maxStableDepth: 4,
    maxEdgeRollouts: 360,
    budgetMs: 5,
    valueSet: 'standard',
    paramPoints: 7,
  },
  overnight: {
    description: 'larger corpus for final tuning',
    trials: 40,
    maxSeconds: 180,
    revealScreensAbove: 0.5,
    maxStableDepth: 4,
    maxEdgeRollouts: 360,
    budgetMs: 5,
    valueSet: 'standard',
    paramPoints: 9,
  },
};

const METRICS = {
  climb: {
    label: 'Climb',
    policyKey: 'climb',
    mixPolicyWeight: 1,
    coefficientValues: {
      smoke: [0.5, 1, 1.5],
      quick: [0.5, 0.8, 1, 1.2, 1.6],
      standard: [0.25, 0.5, 0.8, 1, 1.2, 1.6, 2.0, 2.5, 3.0],
    },
    params: [
      {
        key: 'climbTickCost',
        range: [0, 4],
        metricParams: { climbMode: 'time-cost' },
      },
      {
        key: 'climbWaitCost',
        range: [0, 8],
        metricParams: { climbMode: 'wait-cost' },
      },
    ],
  },
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

const POLICY_KEYS = [...new Set(['climb', ...Object.values(METRICS).map((metric) => metric.policyKey)])];
const SWEEP_METRIC_PARAM_KEYS = [
  ...new Set(Object.values(METRICS).flatMap((metric) => metric.params.map((param) => param.key))),
];
const METRIC_PARAM_KEYS = [...new Set([
  'climbMode',
  ...SWEEP_METRIC_PARAM_KEYS,
])];

// Response curves are intentionally shared across metric studies. A metric
// study should focus on its target behavior, but side effects such as climb
// speed, capture rate, wall use, and deaths stay visible in the same report.
// The metric registry decides how to sweep; people decide which analytics matter.
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
    param: 'all',
    references: 'both',
    trials: null,
    seedBase: 4200,
    maxSeconds: null,
    concurrency: null,
    revealScreensAbove: null,
    maxStableDepth: null,
    maxEdgeRollouts: null,
    budgetMs: null,
    policy: {},
    metricParams: {},
    paramRanges: {},
    configs: [],
    configName: null,
    outDir: null,
    paramPoints: null,
    pastilleSpawnChance: 1.0,
    difficulty: 0.3,
    help: false,
  };

  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length);
    else if (raw.startsWith('--suite=')) args.suite = raw.slice('--suite='.length);
    else if (raw.startsWith('--metric=')) args.metric = raw.slice('--metric='.length);
    else if (raw.startsWith('--param=')) args.param = raw.slice('--param='.length);
    else if (raw.startsWith('--references=')) args.references = raw.slice('--references='.length);
    else if (raw.startsWith('--trials=')) args.trials = Number(raw.slice('--trials='.length));
    else if (raw.startsWith('--seed=')) args.seedBase = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--seconds=')) args.maxSeconds = Number(raw.slice('--seconds='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--max-ticks=')) args.maxSeconds = Number(raw.slice('--max-ticks='.length)) / GAME_FPS;
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw.startsWith('--lookahead-screens=')) args.revealScreensAbove = Number(raw.slice('--lookahead-screens='.length));
    else if (raw.startsWith('--search-jumps=')) args.maxStableDepth = Number(raw.slice('--search-jumps='.length));
    else if (raw.startsWith('--edge-budget=')) args.maxEdgeRollouts = Number(raw.slice('--edge-budget='.length));
    else if (raw.startsWith('--budget-ms=')) args.budgetMs = Number(raw.slice('--budget-ms='.length));
    else if (raw.startsWith('--policy.')) {
      const eq = raw.indexOf('=');
      const key = raw.slice('--policy.'.length, eq);
      const value = Number(raw.slice(eq + 1));
      if (eq < 0 || !POLICY_KEYS.includes(key) || !Number.isFinite(value)) {
        console.error(`Invalid policy override: ${raw}`);
        args.help = true;
      } else {
        args.policy[key] = value;
      }
    }
    else if (raw.startsWith('--metric-param.')) {
      const eq = raw.indexOf('=');
      const key = raw.slice('--metric-param.'.length, eq);
      const value = eq >= 0 ? parseMetricParamValue(key, raw.slice(eq + 1)) : undefined;
      if (eq < 0 || !METRIC_PARAM_KEYS.includes(key) || value === undefined) {
        console.error(`Invalid metric parameter override: ${raw}`);
        args.help = true;
      } else {
        args.metricParams[key] = value;
      }
    }
    else if (raw.startsWith('--param-range.')) {
      const eq = raw.indexOf('=');
      const key = raw.slice('--param-range.'.length, eq);
      const range = eq >= 0 ? parseParamRange(raw.slice(eq + 1)) : null;
      if (eq < 0 || !SWEEP_METRIC_PARAM_KEYS.includes(key) || range === null) {
        console.error(`Invalid parameter range override: ${raw}`);
        args.help = true;
      } else {
        args.paramRanges[key] = range;
      }
    }
    else if (raw.startsWith('--config=')) {
      try {
        args.configs.push(parseConfigSpec(raw.slice('--config='.length)));
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        args.help = true;
      }
    }
    else if (raw.startsWith('--name=')) args.configName = raw.slice('--name='.length);
    else if (raw.startsWith('--out=')) args.outDir = raw.slice('--out='.length);
    else if (raw.startsWith('--param-points=')) args.paramPoints = Number(raw.slice('--param-points='.length));
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
  if (!['all', 'responsiveness', 'params', 'config'].includes(args.suite)) args.help = true;
  if (args.metric !== 'all' && !METRICS[args.metric]) args.help = true;
  if (args.param !== 'all' && !SWEEP_METRIC_PARAM_KEYS.includes(args.param)) args.help = true;
  if (!['both', 'climb-only', 'none'].includes(args.references)) args.help = true;
  if (args.suite !== 'config' && (
    Object.keys(args.policy).length > 0 ||
    Object.keys(args.metricParams).length > 0 ||
    args.configName !== null ||
    args.configs.length > 0
  )) {
    console.error('--policy.*, --metric-param.*, --config, and --name are only valid with --suite=config');
    args.help = true;
  }
  if (args.configs.length > 0 && (
    Object.keys(args.policy).length > 0 ||
    Object.keys(args.metricParams).length > 0 ||
    Object.keys(args.paramRanges).length > 0 ||
    args.configName !== null
  )) {
    console.error('--config cannot be combined with --policy.*, --metric-param.*, --param-range.*, or --name');
    args.help = true;
  }
  if (args.suite === 'config' && Object.keys(args.paramRanges).length > 0) {
    console.error('--param-range.* is only valid with sweep suites');
    args.help = true;
  }

  const preset = PRESETS[args.preset] ?? PRESETS.standard;
  args.trials ??= preset.trials;
  args.maxSeconds ??= preset.maxSeconds;
  args.revealScreensAbove ??= preset.revealScreensAbove;
  args.maxStableDepth ??= preset.maxStableDepth;
  args.maxEdgeRollouts ??= preset.maxEdgeRollouts;
  args.budgetMs ??= preset.budgetMs;
  args.concurrency ??= defaultConcurrency();
  args.paramPoints ??= preset.paramPoints;
  args.concurrency = Math.max(1, Math.round(args.concurrency));
  args.maxStableDepth = Math.max(1, Math.round(args.maxStableDepth));
  args.maxEdgeRollouts = Math.max(16, Math.round(args.maxEdgeRollouts));
  args.budgetMs = Math.max(1, args.budgetMs);
  args.paramPoints = Math.max(2, Math.round(args.paramPoints));
  args.maxTicks = Math.max(1, Math.ceil(args.maxSeconds * GAME_FPS));
  args.valueSet = preset.valueSet;
  return args;
}

function parseMetricParamValue(key, rawValue) {
  if (key === 'climbMode') {
    return CLIMB_METRIC_MODES.includes(rawValue) ? rawValue : undefined;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : undefined;
}

function parseParamRange(rawValue) {
  const separator = rawValue.includes(':') ? ':' : ',';
  const parts = rawValue.split(separator);
  if (parts.length !== 2) return null;
  const min = Number(parts[0]);
  const max = Number(parts[1]);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) return null;
  return [Math.min(min, max), Math.max(min, max)];
}

function parseConfigValue(rawValue) {
  const numeric = Number(rawValue);
  if (rawValue.trim() !== '' && Number.isFinite(numeric)) return numeric;
  return rawValue;
}

function parseConfigSpec(spec) {
  const out = { name: null, policy: {}, metricParams: {} };
  for (const part of spec.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) throw new Error(`Invalid --config segment: ${part}`);
    const key = part.slice(0, eq).trim();
    const rawValue = part.slice(eq + 1).trim();
    if (key === 'name') {
      out.name = rawValue;
    } else if (key.startsWith('policy.')) {
      const policyKey = key.slice('policy.'.length);
      const value = Number(rawValue);
      if (!POLICY_KEYS.includes(policyKey) || !Number.isFinite(value)) {
        throw new Error(`Invalid --config policy segment: ${part}`);
      }
      out.policy[policyKey] = value;
    } else if (key.startsWith('metric.')) {
      const metricKey = key.slice('metric.'.length);
      const value = parseConfigValue(rawValue);
      if (!METRIC_PARAM_KEYS.includes(metricKey)) {
        throw new Error(`Invalid --config metric segment: ${part}`);
      }
      if (metricKey === 'climbMode' && !CLIMB_METRIC_MODES.includes(value)) {
        throw new Error(`Invalid climbMode in --config: ${rawValue}`);
      }
      if (metricKey !== 'climbMode' && typeof value !== 'number') {
        throw new Error(`Invalid numeric metric parameter in --config: ${part}`);
      }
      out.metricParams[metricKey] = value;
    } else {
      throw new Error(`Invalid --config key: ${key}`);
    }
  }
  if (!out.name) {
    const policyText = policyLabel(out.policy);
    const metricText = metricLabel(out.metricParams);
    out.name = metricText === 'planner defaults' ? policyText : `${policyText}; ${metricText}`;
  }
  return out;
}

function defaultConcurrency() {
  return Math.max(1, Math.floor(availableParallelism() * 2 / 3));
}

function help() {
  const presets = Object.entries(PRESETS)
    .map(([name, p]) => (
      `  ${name.padEnd(9)} ${p.trials} trials, ${p.maxSeconds}s, ` +
      `lookahead=${p.revealScreensAbove}, jumps=${p.maxStableDepth}, ` +
      `edges=${p.maxEdgeRollouts}, cpu=${p.budgetMs}ms, params=${p.paramPoints} (${p.description})`
    ))
    .join('\n');
  const metrics = Object.keys(METRICS).join(', ');
  console.log(`Interwheel study

USAGE:
  npm run analyze:interwheel:study -- --preset=quick
  npm run analyze:interwheel:study -- --suite=config --policy.climb=1 --policy.wall=0
  npm run analyze:interwheel:study -- --suite=config --config=name=legacy,policy.climb=1,policy.wall=0,metric.climbMode=legacy --config=name=wait4,policy.climb=1,policy.wall=0,metric.climbMode=wait-cost,metric.climbWaitCost=4
  npm run analyze:interwheel:study -- --suite=responsiveness --metric=wall
  npm run analyze:interwheel:study -- --suite=params --metric=wall --preset=standard
  npm run analyze:interwheel:study -- --suite=params --metric=wall --param-points=9

Presets:
${presets}

Suites:
  config          run fixed planner configuration(s), no sweep
  responsiveness  sweep policy weights, always mixed with climb
  params          sweep constants inside a metric with the policy mix fixed
  all             both suites

Metrics:
  ${metrics}

Useful overrides:
  --policy.KEY=N          fixed-config policy knob (${POLICY_KEYS.join(', ')})
  --metric-param.KEY=V    fixed-config metric parameter (${METRIC_PARAM_KEYS.join(', ')})
  --param-range.KEY=A:B   sweep range override for a metric parameter
  --param=KEY             sweep only one metric parameter
  --references=MODE       both, climb-only, or none
  --config=SPEC           repeated fixed configs: name=LABEL,policy.KEY=N,metric.KEY=V
  --name=LABEL            fixed-config condition label
  --concurrency=N         browser pages; default is roughly 2/3 of CPU cores
  --lookahead-screens=N   planner reveal lookahead
  --search-jumps=N        max stable jump depth
  --edge-budget=N         max edge rollouts per plan
  --budget-ms=N           per-plan CPU budget
  --param-points=N        shared linspace density for parameter sweeps

Defaults fix pastille spawn to 1.0 and generation difficulty to 0.3.
Use --pastille-spawn=natural or --difficulty=natural to disable an override.
Concurrency defaults to roughly two thirds of available CPU cores.

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

function selectedParams(metric, args) {
  if (args.param === 'all') return metric.params;
  return metric.params.filter((param) => param.key === args.param);
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
  const range = args.paramRanges[param.key] ?? param.range;
  return linspace(range[0], range[1], args.paramPoints);
}

function makeConditions(args) {
  if (args.suite === 'config') {
    if (args.configs.length > 0) {
      return args.configs.map((config, index) => ({
        group: 'config',
        suite: 'config',
        metric: null,
        name: config.name,
        axis: 'config',
        value: index,
        policy: { ...config.policy },
        metricParams: { ...config.metricParams },
      }));
    }
    const policyText = policyLabel(args.policy);
    const metricText = metricLabel(args.metricParams);
    const defaultName = metricText === 'planner defaults' ? policyText : `${policyText}; ${metricText}`;
    return [{
      group: 'config',
      suite: 'config',
      metric: null,
      name: args.configName ?? defaultName,
      axis: 'config',
      value: 0,
      policy: { ...args.policy },
      metricParams: { ...args.metricParams },
    }];
  }

  const includeResponsiveness = args.suite === 'all' || args.suite === 'responsiveness';
  const includeParams = args.suite === 'all' || args.suite === 'params';
  const conditions = [];
  if (args.references === 'both' || args.references === 'climb-only') {
    conditions.push({
      group: 'reference',
      suite: 'reference',
      metric: null,
      name: 'climb-only',
      axis: 'reference',
      value: 0,
      policy: { ...CLIMB_ONLY },
      metricParams: {},
    });
  }
  if (args.references === 'both') {
    conditions.push({
      group: 'reference',
      suite: 'reference',
      metric: null,
      name: 'default-current',
      axis: 'reference',
      value: 0.5,
      policy: {},
      metricParams: {},
    });
  }

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
          metricParams: {},
        });
      }
    }

    if (includeParams) {
      for (const param of selectedParams(metric, args)) {
        for (const value of paramValuesFor(param, args)) {
          conditions.push({
            group: `param:${metricName}:${param.key}`,
            suite: 'params',
            metric: metricName,
            name: `${param.key}=${value}`,
            axis: param.key,
            value,
            policy: { ...CLIMB_ONLY, [metric.policyKey]: metric.mixPolicyWeight },
            metricParams: { ...(param.metricParams ?? {}), [param.key]: value },
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

async function runCondition(browser, url, condition, args) {
  const chunks = makeChunks(args.trials, args.seedBase, Math.min(args.concurrency, args.trials));
  const started = performance.now();
  const partials = await Promise.all(chunks.map(async (chunk) => {
    const page = await openPage(browser, url);
    try {
      return await page.evaluate(async ({ chunk, condition, maxTicks, plannerSearch, pastilleSpawnChance, difficulty }) => {
        if (pastilleSpawnChance !== null) {
          window.__interwheelAnalytics__.setPastilleSpawnChanceOverride(pastilleSpawnChance);
        }
        if (difficulty !== null) {
          window.__interwheelAnalytics__.setGenerationDifficultyOverride(difficulty);
        }
        const plannerConfig = {
          budgetMs: plannerSearch.budgetMs,
          maxEdgeRollouts: plannerSearch.maxEdgeRollouts,
          maxStableDepth: plannerSearch.maxStableDepth,
          revealScreensAbove: plannerSearch.revealScreensAbove,
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
        plannerSearch: {
          budgetMs: args.budgetMs,
          maxEdgeRollouts: args.maxEdgeRollouts,
          maxStableDepth: args.maxStableDepth,
          revealScreensAbove: args.revealScreensAbove,
        },
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
    `- metrics: ${summary.meta.metrics.join(', ') || 'none'}`,
    `- trials per condition: ${summary.meta.trials}`,
    `- max seconds: ${fmt(summary.meta.maxTicks / GAME_FPS, 1)}`,
    `- seed base: ${summary.meta.seedBase}`,
    `- concurrency: ${summary.meta.concurrency}`,
    `- planner search: lookahead=${summary.meta.plannerSearch.revealScreensAbove}, jumps=${summary.meta.plannerSearch.maxStableDepth}, edges=${summary.meta.plannerSearch.maxEdgeRollouts}, cpu=${summary.meta.plannerSearch.budgetMs}ms`,
    `- pastille spawn: ${summary.meta.pastilleSpawnChance ?? 'natural'}`,
    `- difficulty: ${summary.meta.difficulty ?? 'natural'}`,
    `- wall seconds: ${fmt(summary.meta.wallSeconds, 1)}`,
    '',
    '## Headline',
    '',
    '| condition | policy | metric params | h(m) | h/min | score/min | wallJ/min | wall% | died | capture% | perceived | past/min | wall steer |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  if (summary.meta.suite !== 'config') {
    lines.splice(8, 0, `- parameter points: ${summary.meta.paramPoints}`);
  }

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

  const responseEntries = Object.entries(summary.responseCurves);
  if (responseEntries.length > 0) {
    lines.push('', '## Response Curves', '');
    lines.push('Each row is one tracked analytic plotted against the swept value. Not every row is the target behavior of the metric; some rows are tradeoffs or side effects.', '');
    lines.push('Shape is a compact warning label for the response curve: flat, dead-zone, jumpy, nonlinear, or near-linear.', '');
  }

  for (const [group, metrics] of responseEntries) {
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
  const entries = Object.entries(policy);
  return entries.length > 0 ? entries.map(([key, value]) => `${key}=${value}`).join(',') : 'planner defaults';
}

function metricLabel(metricParams) {
  const entries = Object.entries(metricParams);
  return entries.length > 0 ? entries.map(([key, value]) => `${key}=${value}`).join(',') : 'planner defaults';
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
      metrics: args.suite === 'config' ? [] : selectedMetrics(args).map(([name]) => name),
      trials: args.trials,
      seedBase: args.seedBase,
      maxTicks: args.maxTicks,
      concurrency: args.concurrency,
      paramPoints: args.paramPoints,
      plannerSearch: {
        revealScreensAbove: args.revealScreensAbove,
        maxStableDepth: args.maxStableDepth,
        maxEdgeRollouts: args.maxEdgeRollouts,
        budgetMs: args.budgetMs,
      },
      pastilleSpawnChance: args.pastilleSpawnChance,
      difficulty: args.difficulty,
      conditions: conditions.length,
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
