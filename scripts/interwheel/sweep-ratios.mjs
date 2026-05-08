#!/usr/bin/env node
// Ratio-style dose-response sweep. climb=1 is fixed; for each other knob we
// vary the value across a range while keeping all OTHER non-climb knobs at
// zero. The intent is "characterize each knob's individual dose-response
// curve, anchored to climb-only as the reference floor."
//
// Why the climb-only anchor: when a knob is the only non-climb signal active,
// the planner's choice ranks candidates by `climb*pathHeight + knob*signal`.
// Sweeping the knob's coefficient gives a clean steering curve free from
// confounds with other knobs.
//
// Output adds the new per-knob steering diagnostic (leafScoreSpreadRange):
// "across the leaf candidates the planner picked between, how much did each
// knob's contribution differ?". A knob with high range steers; one with low
// range is along for the ride regardless of weight.
//
// Death is reported as a hard signal — the user wants 2-minute survival as
// non-negotiable. Any condition that drowns/dies is flagged.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GAME_FPS = 40;

function parseArgs(argv) {
  const args = {
    trials: null,
    seedBase: 4200,
    maxTicks: 4800,           // 2-min game time. Keep so the death/drown signal stays visible.
    concurrency: 20,
    budgetMs: 5,
    outDir: null,
    quick: false,
    smoke: false,
    balanced: false,
    help: false,
    pastilleSpawnChance: 1.0, // pinned for apples-to-apples (see sweep-knobs.mjs notes)
    difficulty: 0.3,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--quick') args.quick = true;
    else if (raw === '--smoke') args.smoke = true;
    else if (raw === '--balanced') args.balanced = true;
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
    else { console.error(`Unknown argument: ${raw}`); args.help = true; }
  }
  if (args.trials === null) args.trials = args.smoke ? 4 : (args.quick ? 6 : 12);
  return args;
}

function help() {
  console.log(`Interwheel ratio sweep — dose response per knob, climb=1 fixed.

USAGE:
  node scripts/interwheel/sweep-ratios.mjs [--trials=N] [--smoke] [--quick]

Defaults: trials=12 concurrency=20 max-ticks=4800 (2-min game time)
  --smoke:  3 conditions × 4 trials, fast end-to-end check.
  --quick:  full conditions × 6 trials.
`);
}

const CLIMB_ONLY = { climb: 1, thoroughness: 0, wall: 0, pace: 0, detour: 0, patience: 0 };

// Per-knob dose ranges. All other non-climb knobs are 0 in each condition.
// Doses chosen to cover "barely on", "default region", "double default", and
// "stress" so the curve has both shape and saturation visible.
const SWEEPS = [
  { knob: 'thoroughness', doses: [0.25, 0.5, 1.0, 2.0, 4.0] },
  { knob: 'wall',         doses: [0.25, 0.5, 1.0, 1.5] },
  { knob: 'pace',         doses: [0.25, 0.5, 1.0, 1.5] },
  { knob: 'detour',       doses: [0.25, 0.5, 1.0, 1.5] },
  { knob: 'patience',     doses: [0.25, 0.5, 0.65, 1.0] },
];

function makeConditions(smoke, balanced) {
  if (smoke) {
    return [
      { group: 'reference', knob: 'climb', dose: 1, name: 'climb-only', policy: { ...CLIMB_ONLY } },
      { group: 'thoroughness', knob: 'thoroughness', dose: 1, name: 'thoroughness=1', policy: { ...CLIMB_ONLY, thoroughness: 1 } },
      { group: 'detour', knob: 'detour', dose: 1, name: 'detour=1', policy: { ...CLIMB_ONLY, detour: 1 } },
    ];
  }
  if (balanced) {
    // Multi-knob "balanced default" candidates. Tests how thoroughness
    // composes with the prior best (pace+detour+wall) — does adding the
    // bounded miss-fraction signal raise capture% without sacrificing the
    // height/harvest gains?
    const c = [];
    const probe = (name, overrides) => c.push({
      group: 'balanced', knob: 'mix', dose: 0, name, policy: { ...CLIMB_ONLY, ...overrides },
    });
    c.push({ group: 'reference', knob: 'climb', dose: 1, name: 'climb-only', policy: { ...CLIMB_ONLY } });
    // Best-known multi-knob baseline (no thoroughness yet).
    probe('pace+detour+wall',     { pace: 1.5, detour: 1.0, wall: 0.5 });
    // Thoroughness alone — does the bounded penalty pull capture% up?
    probe('thoroughness=0.5',     { thoroughness: 0.5 });
    probe('thoroughness=1.0',     { thoroughness: 1.0 });
    probe('thoroughness=2.0',     { thoroughness: 2.0 });
    // Thoroughness + best baseline — composition test.
    probe('full+thor=0.5',        { thoroughness: 0.5, pace: 1.5, detour: 1.0, wall: 0.5 });
    probe('full+thor=1.0',        { thoroughness: 1.0, pace: 1.5, detour: 1.0, wall: 0.5 });
    probe('full+thor=2.0',        { thoroughness: 2.0, pace: 1.5, detour: 1.0, wall: 0.5 });
    // Proposed defaults with patience — does discounting above-reachable misses help?
    probe('proposed-default',     { thoroughness: 0.5, wall: 0.5, pace: 1.5, detour: 1.0, patience: 0.5 });
    return c;
  }
  const out = [
    { group: 'reference', knob: 'climb', dose: 1, name: 'climb-only', policy: { ...CLIMB_ONLY } },
  ];
  for (const { knob, doses } of SWEEPS) {
    for (const d of doses) {
      out.push({
        group: knob,
        knob,
        dose: d,
        name: `${knob}=${d}`,
        policy: { ...CLIMB_ONLY, [knob]: d },
      });
    }
  }
  return out;
}

function makeChunks(trials, seedBase, workers) {
  const chunks = [];
  let offset = 0;
  for (let i = 0; i < workers; i += 1) {
    const count = Math.floor(trials / workers) + (i < trials % workers ? 1 : 0);
    if (count > 0) { chunks.push({ trials: count, seedBase: seedBase + offset }); offset += count; }
  }
  return chunks;
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => { throw err; });
  page.on('console', (msg) => { if (msg.type() === 'error') console.error('page console error:', msg.text()); });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__interwheelAnalytics__), null, { timeout: 30_000 });
  return page;
}

// Per-trial slimmed payload extracted in the page. Keep this lean — every
// field round-trips per trial × condition.
async function runCondition(browser, url, condition, args) {
  const chunks = makeChunks(args.trials, args.seedBase, Math.min(args.concurrency, args.trials));
  const started = performance.now();
  const partials = await Promise.all(chunks.map(async (chunk) => {
    const page = await openPage(browser, url);
    try {
      return await page.evaluate(async ({ chunk, policy, maxTicks, budgetMs, pastilleSpawnChance, difficulty }) => {
        if (pastilleSpawnChance !== null) {
          window.__interwheelAnalytics__.setPastilleSpawnChanceOverride(pastilleSpawnChance);
        }
        if (difficulty !== null) {
          window.__interwheelAnalytics__.setGenerationDifficultyOverride(difficulty);
        }
        const plannerConfig = {
          // Match production defaults — sweeping a crippled planner produces
          // misleading data. PLANNER_SEARCH_DEFAULTS in interwheel-planner.ts
          // is the source of truth (budgetMs=5, maxEdgeRollouts=360,
          // maxStableDepth=4); revealScreensAbove=0.5 is the perception
          // default.
          budgetMs,
          maxEdgeRollouts: 360,
          maxStableDepth: 4,
          revealScreensAbove: 0.5,
          collectSegments: false,
          policy,
        };
        const trials = [];
        for (let i = 0; i < chunk.trials; i += 1) {
          trials.push(await window.__interwheelAnalytics__.runPureTrial(chunk.seedBase + i, maxTicks, plannerConfig));
        }
        return trials.map((trial) => {
          const summary = trial.analytics.summary;
          const planner = summary.planner;
          const deathCause = summary.deathCause;
          const died = trial.ticks < maxTicks ? 1 : 0;

          const range = planner.leafScoreSpreadRange ?? {};
          const std = planner.leafScoreSpreadStd ?? {};
          const get = (obj, key) => (obj[key]?.mean ?? 0);

          return {
            seed: trial.seed,
            height: trial.heightMeters,
            score: trial.score,
            ticks: trial.ticks,
            cpuMs: trial.cpuMs,
            died,
            deathCause,
            pastilles: summary.pastilles,
            sparks: summary.sparks,
            pastillesPerMin: summary.actionsPerMinute.pastillesPerMinute,
            captureRate: trial.uniquePerceivedPastilles > 0
              ? summary.pastilles / trial.uniquePerceivedPastilles
              : 0,
            uniquePerceivedPastilles: trial.uniquePerceivedPastilles,
            // Behavioral metrics — what is the agent actually DOING?
            jumpsPerMin: summary.actionsPerMinute.jumpsPerMinute,
            wheelJumpsPerMin: summary.actionsPerMinute.wheelJumpsPerMinute,
            wallJumpsPerMin: summary.actionsPerMinute.wallJumpsPerMinute,
            wheelStaysMedianRevs: summary.wheelStayRevolutions.median,
            wheelStaysMedianTicks: summary.wheelStayTicks.median,
            flightPercent: summary.phaseTime.flightPercent,
            wheelPercent: summary.phaseTime.wheelPercent,
            wallPercent: summary.phaseTime.wallPercent,
            wallDrifts: summary.wallDrifts,
            // Best-edge breakdown means (chosen path's contribution per knob).
            scoreClimb:        planner.bestScoreBreakdown.climb?.mean        ?? 0,
            scoreThoroughness: planner.bestScoreBreakdown.thoroughness?.mean ?? 0,
            scoreWall:         planner.bestScoreBreakdown.wall?.mean         ?? 0,
            scorePace:         planner.bestScoreBreakdown.pace?.mean         ?? 0,
            scoreDetour:       planner.bestScoreBreakdown.detour?.mean       ?? 0,
            scoreTotal:        planner.bestScoreBreakdown.total?.mean        ?? 0,
            // Per-knob STEERING diagnostic. spreadRangeX = "how much knob X
            // varied across leaf candidates per plan step (mean across plans
            // with >1 candidate)". A high range = this knob is steering.
            spreadRangeClimb:        get(range, 'climb'),
            spreadRangeThoroughness: get(range, 'thoroughness'),
            spreadRangeWall:         get(range, 'wall'),
            spreadRangePace:         get(range, 'pace'),
            spreadRangeDetour:       get(range, 'detour'),
            spreadRangeTotal:        get(range, 'total'),
            spreadStdTotal:          get(std, 'total'),
          };
        });
      }, { chunk, policy: condition.policy, maxTicks: args.maxTicks, budgetMs: args.budgetMs, pastilleSpawnChance: args.pastilleSpawnChance, difficulty: args.difficulty });
    } finally { await page.close(); }
  }));
  return { ...condition, wallMs: performance.now() - started, trials: partials.flat() };
}

function meanOf(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
function stdOf(values) {
  if (values.length < 2) return 0;
  const m = meanOf(values);
  return Math.sqrt(values.reduce((a, v) => a + (v - m) ** 2, 0) / values.length);
}

function summarizeCondition(condition) {
  const trials = condition.trials;
  const numericKeys = Object.keys(trials[0] || {}).filter((k) => typeof trials[0][k] === 'number');
  const metrics = {};
  for (const key of numericKeys) {
    const values = trials.map((t) => t[key]);
    metrics[key] = { mean: meanOf(values), std: stdOf(values) };
  }
  // Death-cause histogram (string field).
  const causeCounts = {};
  for (const t of trials) {
    const c = t.deathCause ?? 'survived';
    causeCounts[c] = (causeCounts[c] ?? 0) + 1;
  }
  return { ...condition, trials: trials.length, metrics, causeCounts };
}

function reportMarkdown(report) {
  const lines = [
    '# Interwheel Ratio Sweep — climb=1 fixed',
    '',
    `- trials per condition: ${report.meta.trials}`,
    `- seed base: ${report.meta.seedBase}`,
    `- max ticks: ${report.meta.maxTicks} (= ${(report.meta.maxTicks / GAME_FPS).toFixed(1)}s game time)`,
    `- pastille spawn pin: ${report.meta.pastilleSpawnChance ?? 'natural'}`,
    `- difficulty pin: ${report.meta.difficulty ?? 'natural'}`,
    `- wall seconds: ${report.meta.wallSeconds.toFixed(1)}`,
    '',
  ];

  // === Survival check ===
  // 'timeout' means "reached tick cap alive" — that's the success outcome,
  // not a death. Real deaths: drown, mine, death, etc.
  const SURVIVAL_OUTCOMES = new Set(['timeout', 'survived', 'null', 'runEnd']);
  const deaths = [];
  for (const s of report.summaries) {
    const causes = Object.entries(s.causeCounts).filter(([k]) => !SURVIVAL_OUTCOMES.has(k));
    if (causes.length > 0) {
      deaths.push({ name: s.name, causes });
    }
  }
  if (deaths.length > 0) {
    lines.push('## ⚠ Deaths (any non-survival outcome)', '');
    lines.push('| condition | causes |');
    lines.push('| --- | --- |');
    for (const d of deaths) {
      lines.push(`| ${d.name} | ${d.causes.map(([c, n]) => `${c}×${n}`).join(', ')} |`);
    }
    lines.push('');
  } else {
    lines.push('Survival: ✓ all conditions reached the tick cap alive.', '');
  }

  // === Headline metrics ===
  lines.push('## Headline metrics per condition', '');
  lines.push('| condition | h(m) | score | past/min | capture% |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${m.height.mean.toFixed(0)} | ${m.score.mean.toFixed(0)} | ${m.pastillesPerMin.mean.toFixed(1)} | ${(m.captureRate.mean * 100).toFixed(1)}% |`,
    );
  }

  // === Behavior: what is the agent actually DOING? ===
  // wheelStaysRevs > 1.0 means agent regularly waits a full wheel rotation
  // (slow climb, more pastille opportunity); jumpsPerMin tracks aggression;
  // flight% / wheel% / wall% partition where time is spent.
  lines.push('', '## Behavior per condition', '');
  lines.push('| condition | jumps/min | wheelJ/min | wallJ/min | wheelStayRevs(med) | flight% | wheel% | wall% | wallDrift |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${m.jumpsPerMin.mean.toFixed(1)} | ${m.wheelJumpsPerMin.mean.toFixed(1)} | ${m.wallJumpsPerMin.mean.toFixed(1)} | ${m.wheelStaysMedianRevs.mean.toFixed(2)} | ${m.flightPercent.mean.toFixed(1)} | ${m.wheelPercent.mean.toFixed(1)} | ${m.wallPercent.mean.toFixed(1)} | ${m.wallDrifts.mean.toFixed(1)} |`,
    );
  }

  // === Steering diagnostic ===
  lines.push('', '## Per-knob steering range (mean per-plan max−min across leaves)', '');
  lines.push('A knob with high range steers route choice; low range means it\'s along for the ride.');
  lines.push('Reference: total = full leaf-value range across candidates.');
  lines.push('');
  lines.push('| condition | climb | thoroughness | wall | pace | detour | total |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${m.spreadRangeClimb.mean.toFixed(0)} | ${m.spreadRangeThoroughness.mean.toFixed(0)} | ${m.spreadRangeWall.mean.toFixed(0)} | ${m.spreadRangePace.mean.toFixed(0)} | ${m.spreadRangeDetour.mean.toFixed(0)} | ${m.spreadRangeTotal.mean.toFixed(0)} |`,
    );
  }

  // === Per-knob dose curves ===
  const groups = [...new Set(report.summaries.map((s) => s.group))].filter((g) => g !== 'reference');
  for (const group of groups) {
    const rows = report.summaries.filter((s) => s.group === group);
    if (rows.length === 0) continue;
    lines.push('', `## Dose response: ${group}`, '');
    lines.push(`| ${group} | h(m) | Δh vs climb-only | score | past/min | capture% | steering(${group}) | died |`);
    lines.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    const climbOnly = report.summaries.find((s) => s.name === 'climb-only');
    const climbH = climbOnly?.metrics.height.mean ?? 0;
    const climbS = climbOnly?.metrics.score.mean ?? 0;
    // Insert climb-only as dose=0 anchor for context.
    if (climbOnly) {
      lines.push(`| 0 (climb-only) | ${climbH.toFixed(0)} | 0 | ${climbS.toFixed(0)} | ${climbOnly.metrics.pastillesPerMin.mean.toFixed(1)} | ${(climbOnly.metrics.captureRate.mean * 100).toFixed(1)}% | — | ${(climbOnly.metrics.died.mean * 100).toFixed(0)}% |`);
    }
    for (const r of rows) {
      const m = r.metrics;
      const steeringKey = `spreadRange${group.charAt(0).toUpperCase() + group.slice(1)}`;
      const steering = m[steeringKey]?.mean ?? 0;
      lines.push(
        `| ${r.dose} | ${m.height.mean.toFixed(0)} | ${(m.height.mean - climbH).toFixed(0)} | ${m.score.mean.toFixed(0)} | ${m.pastillesPerMin.mean.toFixed(1)} | ${(m.captureRate.mean * 100).toFixed(1)}% | ${steering.toFixed(0)} | ${(m.died.mean * 100).toFixed(0)}% |`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }
  const outDir = args.outDir ?? join('.tmp', 'interwheel-ratios', timestamp());
  await mkdir(outDir, { recursive: true });

  const vite = await createServer({
    server: { port: 0, host: '127.0.0.1', watch: { ignored: ['**/generated-assets/**', '**/dist/**', '**/.tmp/**'] } },
    logLevel: 'silent', clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;
  const url = `http://127.0.0.1:${port}/analyze-interwheel.html`;
  const browser = await chromium.launch({ headless: true });
  const started = Date.now();
  try {
    const raw = [];
    const conditions = makeConditions(args.smoke, args.balanced);
    for (let i = 0; i < conditions.length; i += 1) {
      const condition = conditions[i];
      console.error(`[${i + 1}/${conditions.length}] ${condition.name}`);
      const result = await runCondition(browser, url, condition, args);
      raw.push(result);
      const trials = result.trials;
      const heightMean = meanOf(trials.map((t) => t.height));
      const pastMean = meanOf(trials.map((t) => t.pastillesPerMin));
      const diedFrac = meanOf(trials.map((t) => t.died));
      console.error(
        `  h=${heightMean.toFixed(1)}m past/min=${pastMean.toFixed(2)} died=${(diedFrac * 100).toFixed(0)}% wall=${(result.wallMs / 1000).toFixed(1)}s`,
      );
    }

    const summaries = raw.map(summarizeCondition);
    const report = {
      meta: {
        trials: args.trials,
        seedBase: args.seedBase,
        maxTicks: args.maxTicks,
        maxSeconds: args.maxTicks / GAME_FPS,
        concurrency: args.concurrency,
        budgetMs: args.budgetMs,
        configs: conditions.length,
        wallSeconds: (Date.now() - started) / 1000,
        pastilleSpawnChance: args.pastilleSpawnChance,
        difficulty: args.difficulty,
      },
      summaries,
    };
    await writeFile(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
    await writeFile(join(outDir, 'report.md'), reportMarkdown(report));
    console.log(JSON.stringify({ outDir, ...report.meta }, null, 2));
  } finally { await browser.close(); await vite.close(); }
}

main().catch((err) => { console.error(err); process.exit(1); });
