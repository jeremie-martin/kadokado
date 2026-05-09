#!/usr/bin/env node
// Systematic Interwheel policy study.
//
// This replaces ad hoc "sweep" scripts as the current entrypoint. A study can
// include policy-mix responsiveness (how a non-climb metric combines with
// climb) and metric-parameter responsiveness (how constants inside a metric
// shape behavior). The report treats response curves as first-class output.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GAME_FPS = 40;
const DEFAULT_POLICY = { climb: 1, wall: 0.5 };
const CLIMB_ONLY = { climb: 1, wall: 0 };
const DEFAULT_METRIC_PARAMS = { wallLandingBonus: 300, wallTickBonus: 5 };

function parseArgs(argv) {
  const args = {
    trials: null,
    seedBase: 4200,
    maxTicks: 4800,
    concurrency: 12,
    budgetMs: 5,
    outDir: null,
    quick: false,
    smoke: false,
    help: false,
    study: 'all',
    pastilleSpawnChance: 1.0,
    difficulty: 0.3,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--quick') args.quick = true;
    else if (raw === '--smoke') args.smoke = true;
    else if (raw.startsWith('--study=')) args.study = raw.slice('--study='.length);
    else if (raw.startsWith('--trials=')) args.trials = Number(raw.slice('--trials='.length));
    else if (raw.startsWith('--seed=')) args.seedBase = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--max-ticks=')) args.maxTicks = Number(raw.slice('--max-ticks='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxTicks = Math.ceil(Number(raw.slice('--max-seconds='.length)) * GAME_FPS);
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw.startsWith('--budget-ms=')) args.budgetMs = Number(raw.slice('--budget-ms='.length));
    else if (raw.startsWith('--out=')) args.outDir = raw.slice('--out='.length);
    else if (raw === '--pastille-spawn=natural') args.pastilleSpawnChance = null;
    else if (raw.startsWith('--pastille-spawn=')) args.pastilleSpawnChance = Number(raw.slice('--pastille-spawn='.length));
    else if (raw === '--difficulty=natural') args.difficulty = null;
    else if (raw.startsWith('--difficulty=')) args.difficulty = Number(raw.slice('--difficulty='.length));
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  if (!['all', 'responsiveness', 'metric-params'].includes(args.study)) args.help = true;
  if (args.trials === null) args.trials = args.smoke ? 2 : (args.quick ? 4 : 16);
  return args;
}

function help() {
  console.log(`Interwheel policy study

USAGE:
  npm run analyze:interwheel:policies -- --trials=16 --max-seconds=120
  node scripts/interwheel/study-policy.mjs --study=responsiveness --quick
  node scripts/interwheel/study-policy.mjs --study=metric-params --trials=8

Studies:
  responsiveness  policy coefficient response, always mixed with climb
  metric-params   constants inside a metric, with policy mix held fixed
  all             both studies

Outputs raw.json, summary.json, and report.md under .tmp/interwheel-policy-studies/<timestamp>/.
`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function wallDoses(smoke) {
  return smoke
    ? [0, 0.5, 1]
    : [0, 0.1, 0.2, 0.35, 0.5, 0.7, 0.9, 1.1, 1.3, 1.6, 2.0];
}

function makeConditions(args) {
  const includeResponsiveness = args.study === 'all' || args.study === 'responsiveness';
  const includeMetricParams = args.study === 'all' || args.study === 'metric-params';
  const conditions = [
    {
      group: 'reference',
      name: 'climb-only',
      axis: 'reference',
      value: 0,
      policy: { ...CLIMB_ONLY },
      metricParams: { ...DEFAULT_METRIC_PARAMS },
    },
    {
      group: 'reference',
      name: 'default-current',
      axis: 'reference',
      value: 0.5,
      policy: { ...DEFAULT_POLICY },
      metricParams: { ...DEFAULT_METRIC_PARAMS },
    },
  ];

  if (includeResponsiveness) {
    for (const value of wallDoses(args.smoke)) {
      conditions.push({
        group: 'mix:wall',
        name: `wall=${value}`,
        axis: 'wall',
        value,
        policy: { ...CLIMB_ONLY, wall: value },
        metricParams: { ...DEFAULT_METRIC_PARAMS },
      });
    }
  }

  if (includeMetricParams) {
    const landingValues = args.smoke ? [0, 300] : [0, 75, 150, 225, 300, 450, 600];
    const tickValues = args.smoke ? [0, 5] : [0, 1, 2, 3.5, 5, 8, 12];
    for (const value of landingValues) {
      conditions.push({
        group: 'param:wallLandingBonus',
        name: `wallLandingBonus=${value}`,
        axis: 'wallLandingBonus',
        value,
        policy: { ...CLIMB_ONLY, wall: 1 },
        metricParams: { ...DEFAULT_METRIC_PARAMS, wallLandingBonus: value },
      });
    }
    for (const value of tickValues) {
      conditions.push({
        group: 'param:wallTickBonus',
        name: `wallTickBonus=${value}`,
        axis: 'wallTickBonus',
        value,
        policy: { ...CLIMB_ONLY, wall: 1 },
        metricParams: { ...DEFAULT_METRIC_PARAMS, wallTickBonus: value },
      });
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
          const died = trial.ticks < maxTicksLocal ? 1 : 0;
          const range = planner.leafScoreSpreadRange ?? {};
          return {
            seed: trial.seed,
            height: trial.heightMeters,
            score: trial.score,
            ticks: trial.ticks,
            runClimbMetersPerSec: trial.ticks > 0 ? trial.heightMeters / (trial.ticks / 40) : 0,
            cpuMs: trial.cpuMs,
            died,
            deathCause: summary.deathCause,
            jumpsPerMin: summary.actionsPerMinute.jumpsPerMinute,
            wheelJumpsPerMin: summary.actionsPerMinute.wheelJumpsPerMinute,
            wallJumpsPerMin: summary.actionsPerMinute.wallJumpsPerMinute,
            pastillesPerMin: summary.actionsPerMinute.pastillesPerMinute,
            pastilles: summary.pastilles,
            uniquePerceivedPastilles: trial.uniquePerceivedPastilles,
            captureRate: trial.uniquePerceivedPastilles > 0
              ? summary.pastilles / trial.uniquePerceivedPastilles
              : 0,
            flightPercent: summary.phaseTime.flightPercent,
            wheelPercent: summary.phaseTime.wheelPercent,
            wallPercent: summary.phaseTime.wallPercent,
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
  const fields = [
    'height', 'runClimbMetersPerSec', 'score', 'died',
    'jumpsPerMin', 'wheelJumpsPerMin', 'wallJumpsPerMin',
    'pastillesPerMin', 'pastilles', 'uniquePerceivedPastilles', 'captureRate',
    'flightPercent', 'wheelPercent', 'wallPercent', 'wheelRevMedian',
    'wallDrifts', 'planMs', 'edges', 'scoreClimb', 'scoreWall', 'scoreTotal',
    'spreadRangeClimb', 'spreadRangeWall',
  ];
  const metrics = {};
  for (const field of fields) metrics[field] = stats(condition.trials.map((trial) => trial[field] ?? 0));
  return {
    group: condition.group,
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

function linearFit(points) {
  const clean = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (clean.length < 2) return { slope: 0, intercept: 0, r2: 0, maxStep: 0 };
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
  for (let i = 1; i < sorted.length; i += 1) {
    maxStep = Math.max(maxStep, Math.abs(sorted[i].y - sorted[i - 1].y));
  }
  return { slope, intercept, r2, maxStep };
}

function responsiveness(summaries) {
  const out = {};
  for (const group of [...new Set(summaries.map((summary) => summary.group).filter((group) => group.includes(':')))]) {
    const rows = summaries.filter((summary) => summary.group === group).sort((a, b) => a.value - b.value);
    out[group] = {};
    for (const metric of ['wallJumpsPerMin', 'wallPercent', 'height', 'runClimbMetersPerSec', 'died', 'captureRate']) {
      out[group][metric] = linearFit(rows.map((row) => ({ x: row.value, y: row.metrics[metric].mean })));
    }
  }
  return out;
}

function summarize(raw, meta) {
  const summaries = raw.map(summarizeCondition);
  return { meta, summaries, responsiveness: responsiveness(summaries) };
}

function fmt(value, digits = 1) {
  return Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function reportMarkdown(summary) {
  const lines = [
    '# Interwheel Policy Study',
    '',
    `- trials per condition: ${summary.meta.trials}`,
    `- max seconds: ${fmt(summary.meta.maxTicks / GAME_FPS, 1)}`,
    `- seed base: ${summary.meta.seedBase}`,
    `- study: ${summary.meta.study}`,
    `- pastille spawn: ${summary.meta.pastilleSpawnChance ?? 'natural'}`,
    `- difficulty: ${summary.meta.difficulty ?? 'natural'}`,
    `- wall seconds: ${fmt(summary.meta.wallSeconds, 1)}`,
    '',
    '## Headline',
    '',
    '| condition | policy | metric params | h(m) | run m/s | wallJ/min | wall% | died | capture% | perceived | past/min | wall steer |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];

  for (const s of summary.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${policyLabel(s.policy)} | ${metricLabel(s.metricParams)} | ` +
      `${fmt(m.height.mean, 0)} | ${fmt(m.runClimbMetersPerSec.mean, 2)} | ` +
      `${fmt(m.wallJumpsPerMin.mean, 1)} | ${fmt(m.wallPercent.mean, 1)} | ` +
      `${fmt(m.died.mean * 100, 0)}% | ${fmt(m.captureRate.mean * 100, 1)}% | ` +
      `${fmt(m.uniquePerceivedPastilles.mean, 1)} | ${fmt(m.pastillesPerMin.mean, 1)} | ` +
      `${fmt(m.spreadRangeWall.mean, 0)} |`,
    );
  }

  lines.push('', '## Responsiveness', '');
  lines.push('R2 close to 1 means the response is close to linear over the sampled range; maxStep is the largest adjacent jump in the response curve.', '');

  for (const [group, metrics] of Object.entries(summary.responsiveness)) {
    lines.push(`### ${group}`, '');
    lines.push('| response | slope | r2 | maxStep |');
    lines.push('| --- | ---: | ---: | ---: |');
    for (const [metric, fit] of Object.entries(metrics)) {
      lines.push(`| ${metric} | ${fmt(fit.slope, 3)} | ${fmt(fit.r2, 3)} | ${fmt(fit.maxStep, 2)} |`);
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

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }
  const conditions = makeConditions(args);
  const outDir = args.outDir ?? join('.tmp', 'interwheel-policy-studies', timestamp());
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
      console.log(`[${i + 1}/${conditions.length}] ${condition.name}`);
      const result = await runCondition(browser, url, condition, args);
      raw.push(result);
      const m = summarizeCondition(result).metrics;
      console.log(
        `  h=${m.height.mean.toFixed(1)}m run=${m.runClimbMetersPerSec.mean.toFixed(2)}m/s ` +
        `wallJ=${m.wallJumpsPerMin.mean.toFixed(1)}/min died=${(m.died.mean * 100).toFixed(0)}%`,
      );
    }

    const meta = {
      study: args.study,
      trials: args.trials,
      seedBase: args.seedBase,
      maxTicks: args.maxTicks,
      concurrency: args.concurrency,
      budgetMs: args.budgetMs,
      pastilleSpawnChance: args.pastilleSpawnChance,
      difficulty: args.difficulty,
      conditions: conditions.length,
      wallSeconds: (performance.now() - started) / 1000,
    };
    const summary = summarize(raw, meta);
    await writeFile(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2));
    await writeFile(join(outDir, 'report.md'), reportMarkdown(summary));
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
