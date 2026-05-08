#!/usr/bin/env node
// Phase 2.5b validation sweep for the orthogonal-math redesign. Compares the
// new 6-knob default operating point against a "climb-only" floor, an "old-
// style" config (old numerical values mapped onto the new knob names — for
// rough comparison; exact-equivalence is impossible because the formulas
// changed), and runs per-knob isolation + focus-axis sweeps to characterize
// the new operating point.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SWEEP_FIELDS, summarizeCondition } from './policy-sweep-utils.mjs';

// Score-breakdown line aliases (compactTrial keys, one per planner term).
// Maps the post-redesign breakdown fields to sweep-CSV column names.
const KNOB_FIELDS = [
  // Filter out the shared score fields so this script can append the full
  // current breakdown, including internal physics terms.
  ...DEFAULT_SWEEP_FIELDS.filter((f) => f === 'score' || !f.startsWith('score')),
  'scoreClimb',
  'scoreThoroughness',
  'scoreWall',
  'scorePace',
  'scoreDetour',
  'scoreStability',
  'scoreSafety',
  'scoreTotal',
  // Health / characterization metrics derived from the analytics event streams.
  'died',
  'climbRateMs',
  'peakHeight',
  'flightLandingWheelPct',
  'pastillesLow',
  'pastillesMid',
  'pastillesHigh',
  'pressesPerJump',
];

const GAME_FPS = 40;

function parseArgs(argv) {
  const args = {
    trials: null,  // null = use --quick / default heuristic below
    seedBase: 4200,
    // Default 2-minute game time per trial — long enough for high-altitude
    // steady-state behavior without dying. Most policies don't die in 2min
    // so survival is a smoke-test, not a real signal.
    maxTicks: 4800,
    concurrency: 12,
    budgetMs: 5,
    outDir: null,
    quick: false,
    help: false,
    // Pin pastille spawn density to 1.0 (uniform max) by default for
    // apple-to-apple sweep comparisons. Set to null via
    // --pastille-spawn=natural to use the production height-ramp curve.
    pastilleSpawnChance: 1.0,
    // Pin generation difficulty to a moderate constant (0.3) so wheel size,
    // wheel speed, inter-wheel spacing, and mine density are uniform across
    // altitudes. Without this, a faster climber reaches harder geometry,
    // confounding policy effect with terrain difficulty. Set to null via
    // --difficulty=natural to use the production height-ramp curve.
    difficulty: 0.3,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--quick') args.quick = true;
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
  // Default trial count: 4 in --quick mode (super fast iteration),
  // 24 otherwise (the "nice and slow" Phase 2.5b validation sweep).
  // Explicit --trials= always wins.
  if (args.trials === null) args.trials = args.quick ? 4 : 24;
  return args;
}

function help() {
  console.log(`Interwheel knob characterization sweep.

Default: trials=24 concurrency=12 max-ticks=4800 (=120s) budget-ms=5

USAGE:
  node scripts/interwheel/sweep-knobs.mjs [--trials=24] [--seed=4200] [--max-seconds=120] [--quick]

  --quick:    fewer conditions (one level per knob) AND trials defaults to 4
              (vs 24) for fast iteration. Override with --trials=N.
  --trials=N: explicit trial count per condition (always wins over --quick).
`);
}

// Climb-only: only the climb knob on. Height-reference baseline used both as
// a comparison anchor (configs are measured against this height) and as a
// rejection filter (configs below 75% of climb-only's mean height are flagged
// as underperforming).
const CLIMB_BASE = { climb: 1.0, thoroughness: 0, wall: 0, pace: 0, detour: 0, patience: 0 };
// Old-style: prior default policy values mapped onto the new knob names.
// Rough comparison only — the formulas changed, so exact-equivalence to the
// pre-redesign planner is impossible without a git checkout.
const OLD_STYLE = { climb: 1.08, thoroughness: 1.2, wall: 0.65, pace: 1, detour: 0, patience: 0 };
// Current default operating point from DEFAULT_PLANNER_POLICY.
const NEW_DEFAULT = { climb: 1.0, thoroughness: 0, wall: 0.5, pace: 1.5, detour: 1.0, patience: 0 };

const HEIGHT_FLOOR_FRACTION = 0.75;

// Focus-axis lerp endpoints (must mirror policyFromFocus in ai-interwheel.ts).
const FOCUS_CLIMB_MAX = 1.6;
const FOCUS_CLIMB_MIN = 0.3;
const FOCUS_THOROUGHNESS_MAX = 2;

function policyFromFocus(focus) {
  return {
    ...NEW_DEFAULT,
    climb: FOCUS_CLIMB_MAX - (FOCUS_CLIMB_MAX - FOCUS_CLIMB_MIN) * focus,
    thoroughness: FOCUS_THOROUGHNESS_MAX * focus,
  };
}

function makeConditions(_quick = false) {
  const c = [
    // === References ===
    { group: 'reference', name: 'default-new', policy: { ...NEW_DEFAULT } },
    { group: 'reference', name: 'climb-only',  policy: { ...CLIMB_BASE } },
    { group: 'reference', name: 'old-style',   policy: { ...OLD_STYLE } },
  ];

  const probe = (name, overrides) => {
    c.push({ group: 'isolation', name, policy: { ...NEW_DEFAULT, ...overrides } });
  };

  // === Per-knob isolation around the new default ===
  probe('climb=0.5',     { climb: 0.5 });
  probe('climb=1.5',     { climb: 1.5 });
  probe('thoroughness=0.5', { thoroughness: 0.5 });
  probe('thoroughness=2.0', { thoroughness: 2.0 });
  probe('detour=0.25',   { detour: 0.25 });
  probe('detour=1.0',    { detour: 1.0 });
  probe('patience=0',    { patience: 0 });
  probe('patience=1.0',  { patience: 1.0 });
  probe('wall=0',        { wall: 0 });
  probe('wall=1.5',      { wall: 1.5 });
  probe('pace=0.5',      { pace: 0.5 });
  probe('pace=1.5',      { pace: 1.5 });

  // === Focus axis sweep ===
  for (const f of [0, 0.2, 0.4, 0.6, 0.8, 1.0]) {
    c.push({ group: 'focus', name: `focus=${f.toFixed(1)}`, policy: policyFromFocus(f) });
  }

  return c;
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

async function runCondition(browser, url, condition, args) {
  const chunks = makeChunks(args.trials, args.seedBase, Math.min(args.concurrency, args.trials));
  const started = performance.now();
  const partials = await Promise.all(chunks.map(async (chunk) => {
    const page = await openPage(browser, url);
    try {
      return await page.evaluate(async ({ chunk, policy, maxTicks, budgetMs, pastilleSpawnChance, difficulty }) => {
        // Pin pastille spawn density and generation difficulty to constant
        // values for apple-to-apple policy comparison. Production gameplay
        // ramps both with height (pastilles to 100% by 1600m, difficulty
        // toward 1.0 by 20000m), confounding the comparison: a higher-
        // climbing policy meets harder terrain AND denser pastilles.
        if (pastilleSpawnChance !== null) {
          window.__interwheelAnalytics__.setPastilleSpawnChanceOverride(pastilleSpawnChance);
        }
        if (difficulty !== null) {
          window.__interwheelAnalytics__.setGenerationDifficultyOverride(difficulty);
        }
        const plannerConfig = {
          budgetMs,
          maxEdgeRollouts: 240,
          maxStableDepth: 3,
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
          const events = trial.analytics.events ?? {};
          const flights = events.flights ?? [];
          const jumps = events.jumps ?? [];
          const pastilles = events.pastilles ?? [];

          // "died" = run terminated before maxTicks for any reason except a
          // benign timeout. The cleanest signal we have access to is whether
          // the agent reached the tick cap; if it didn't, the level killed
          // it (mine, drown, etc.). Used as a sanity-check filter, not an
          // optimization target.
          const died = trial.ticks < maxTicks ? 1 : 0;

          // Climb rate (m/s): mean over flight events where duration > 0.
          let climbRateSum = 0;
          let climbRateCount = 0;
          let landingWheel = 0;
          for (const f of flights) {
            if (f.durationSeconds > 0) {
              climbRateSum += (f.maxHeightGainMeters ?? 0) / f.durationSeconds;
              climbRateCount += 1;
            }
            if (f.landing === 'wheel') landingWheel += 1;
          }
          const climbRateMs = climbRateCount > 0 ? climbRateSum / climbRateCount : 0;
          const flightLandingWheelPct = flights.length > 0
            ? (landingWheel / flights.length) * 100
            : 0;

          // Per-tier pastille counts: world y → height meters via the same
          // `Math.floor(max(0, -y) * 0.2)` mapping used by the analytics.
          let pLow = 0, pMid = 0, pHigh = 0;
          for (const p of pastilles) {
            const h = Math.floor(Math.max(0, -p.y) * 0.2);
            if (h < 300) pLow += 1;
            else if (h < 600) pMid += 1;
            else pHigh += 1;
          }

          // Peak height = highest heightMeters seen anywhere in the run. For
          // dying-agent diagnostics: agent might fall back before terminal,
          // so trial.heightMeters (final) understates achievement.
          let peak = trial.heightMeters;
          for (const j of jumps) if (j.heightMeters > peak) peak = j.heightMeters;
          for (const f of flights) {
            const fh = Math.floor(Math.max(0, -f.startY) * 0.2);
            if (fh > peak) peak = fh;
            const fhe = Math.floor(Math.max(0, -f.endY) * 0.2);
            if (fhe > peak) peak = fhe;
          }

          const pressesPerJump = summary.jumps > 0
            ? summary.presses / summary.jumps
            : 0;

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
            uniquePerceivedPastilles: trial.uniquePerceivedPastilles,
            captureRate: trial.uniquePerceivedPastilles > 0
              ? summary.pastilles / trial.uniquePerceivedPastilles
              : 0,
            missedPerceived: Math.max(0, trial.uniquePerceivedPastilles - summary.pastilles),
            planMs: trial.planner.avgPlanMs,
            edges: trial.planner.avgEdges,
            scoreClimb:        planner.bestScoreBreakdown.climb?.mean        ?? 0,
            scoreThoroughness: planner.bestScoreBreakdown.thoroughness?.mean ?? 0,
            scoreWall:         planner.bestScoreBreakdown.wall?.mean         ?? 0,
            scorePace:         planner.bestScoreBreakdown.pace?.mean         ?? 0,
            scoreDetour:       planner.bestScoreBreakdown.detour?.mean       ?? 0,
            scoreStability:    planner.bestScoreBreakdown.stability?.mean    ?? 0,
            scoreSafety:       planner.bestScoreBreakdown.safety?.mean       ?? 0,
            scoreTotal:        planner.bestScoreBreakdown.total?.mean        ?? 0,
            died,
            climbRateMs,
            peakHeight: peak,
            flightLandingWheelPct,
            pastillesLow: pLow,
            pastillesMid: pMid,
            pastillesHigh: pHigh,
            pressesPerJump,
          };
        });
      }, { chunk, policy: condition.policy, maxTicks: args.maxTicks, budgetMs: args.budgetMs, pastilleSpawnChance: args.pastilleSpawnChance, difficulty: args.difficulty });
    } finally { await page.close(); }
  }));
  return { ...condition, wallMs: performance.now() - started, trials: partials.flat() };
}

function reportMarkdown(report) {
  const lines = [
    '# Interwheel Knob Characterization',
    '',
    `- trials per condition: ${report.meta.trials}`,
    `- seed base: ${report.meta.seedBase}`,
    `- max ticks: ${report.meta.maxTicks} (= ${(report.meta.maxTicks / GAME_FPS).toFixed(1)}s game time)`,
    `- budget ms: ${report.meta.budgetMs}`,
    `- wall seconds: ${report.meta.wallSeconds.toFixed(1)}`,
    '',
  ];

  // Survival sanity check: surface any condition where the agent died.
  // Treated as a filter, not a target — every sane policy should reach the
  // tick cap alive in 60s.
  const deathHits = [];
  for (const s of report.summaries) {
    const dRate = s.metrics.died?.mean ?? 0;
    if (dRate > 0) deathHits.push({ name: s.name, rate: dRate });
  }
  if (deathHits.length > 0) {
    lines.push('## ⚠ Survival warning', '');
    lines.push('Conditions where the agent died (death rate > 0):');
    for (const h of deathHits) lines.push(`- **${h.name}**: died ${(h.rate * 100).toFixed(0)}% of trials`);
    lines.push('');
  } else {
    lines.push('Survival: ✓ all conditions reached the tick cap alive.', '');
  }

  // Height-floor filter: anything below 75% of climb-only's mean height is
  // flagged. Climb-only is the reference baseline — every other config
  // should be in the same ballpark (or trade a bit of height for capture),
  // not collapse below the floor.
  const climbOnly = report.summaries.find((s) => s.name === 'climb-only');
  const climbHeight = climbOnly?.metrics.height.mean ?? 0;
  const heightFloor = climbHeight * HEIGHT_FLOOR_FRACTION;
  lines.push(`Height reference: \`climb-only\` reaches **${climbHeight.toFixed(0)}m** mean. Floor at ${(HEIGHT_FLOOR_FRACTION * 100).toFixed(0)}% = **${heightFloor.toFixed(0)}m**.`, '');
  const belowFloor = report.summaries.filter((s) => s.name !== 'climb-only' && s.metrics.height.mean < heightFloor);
  if (belowFloor.length > 0) {
    lines.push('## ⚠ Below height floor', '');
    lines.push('These configs sacrifice too much climb to be considered viable:');
    for (const s of belowFloor) {
      const pct = climbHeight > 0 ? (s.metrics.height.mean / climbHeight * 100) : 0;
      lines.push(`- **${s.name}**: ${s.metrics.height.mean.toFixed(0)}m (${pct.toFixed(0)}% of climb-only)`);
    }
    lines.push('');
  } else {
    lines.push('Height floor: ✓ all configs reach ≥75% of climb-only height.', '');
  }

  lines.push('## Headline metrics per condition', '');
  lines.push('Each knob row uses the current planner policy shape (`climb`, `thoroughness`, `wall`, `pace`, `detour`, `patience`).');
  lines.push('');
  lines.push('| condition | h(m) | peak(m) | score | total past | past/min | capture% | climb m/s | wheelLand% | flight% | wheel% | died |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${m.height.mean.toFixed(0)} | ${m.peakHeight.mean.toFixed(0)} | ${m.score.mean.toFixed(0)} | ${m.pastilles.mean.toFixed(1)} | ${m.pastillesPerMin.mean.toFixed(1)} | ${(m.captureRate.mean * 100).toFixed(1)}% | ${m.climbRateMs.mean.toFixed(2)} | ${m.flightLandingWheelPct.mean.toFixed(0)}% | ${m.flightPercent.mean.toFixed(1)} | ${m.wheelPercent.mean.toFixed(1)} | ${(m.died.mean * 100).toFixed(0)}% |`,
    );
  }

  lines.push('', '## Per-tier pastille counts', '');
  lines.push('Pastilles collected, bucketed by the height they were collected at. Tells us where in the run the policy is harvesting.');
  lines.push('');
  lines.push('| condition | low (0-300m) | mid (300-600m) | high (600m+) |');
  lines.push('| --- | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${m.pastillesLow.mean.toFixed(1)} | ${m.pastillesMid.mean.toFixed(1)} | ${m.pastillesHigh.mean.toFixed(1)} |`,
    );
  }

  lines.push('', '## Score breakdown means', '');
  lines.push('| condition | climb | thoroughness | wall | pace | detour | total |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    const m = s.metrics;
    lines.push(
      `| ${s.name} | ${m.scoreClimb.mean.toFixed(0)} | ${m.scoreThoroughness.mean.toFixed(0)} | ${m.scoreWall.mean.toFixed(0)} | ${m.scorePace.mean.toFixed(0)} | ${m.scoreDetour.mean.toFixed(0)} | ${m.scoreTotal.mean.toFixed(0)} |`,
    );
  }

  lines.push('', '## vs climb-only baseline (paired)', '');
  lines.push('| condition | Δheight | Δscore | Δpast/min | Δcapture% | Δclimb m/s |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
  for (const s of report.summaries) {
    if (s.name === 'climb-only') continue;
    const m = s.metricsVsZero;
    if (!m) continue;
    lines.push(
      `| ${s.name} | ${m.height.deltaMean.toFixed(0)} | ${m.score.deltaMean.toFixed(0)} | ${m.pastillesPerMin.deltaMean.toFixed(2)} | ${(m.captureRate.deltaMean * 100).toFixed(1)} | ${m.climbRateMs.deltaMean.toFixed(2)} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }
  const outDir = args.outDir ?? join('.tmp', 'interwheel-knobs', timestamp());
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
    const conditions = makeConditions(args.quick);
    for (let i = 0; i < conditions.length; i += 1) {
      const condition = conditions[i];
      console.error(`[${i + 1}/${conditions.length}] ${condition.name}`);
      const result = await runCondition(browser, url, condition, args);
      raw.push(result);
      const trials = result.trials;
      const heightStats = trials.length > 0 ? trials.map((t) => t.height) : [0];
      const heightMean = heightStats.reduce((a, b) => a + b, 0) / heightStats.length;
      const pastMean = trials.reduce((s, t) => s + t.pastillesPerMin, 0) / Math.max(1, trials.length);
      const flightMean = trials.reduce((s, t) => s + t.flightPercent, 0) / Math.max(1, trials.length);
      console.error(
        `  h=${heightMean.toFixed(1)}m past/min=${pastMean.toFixed(2)} flight%=${flightMean.toFixed(1)} wall=${(result.wallMs / 1000).toFixed(1)}s`,
      );
    }

    const baseline = raw.find((r) => r.name === 'default-new') ?? raw[0];
    const climbOnly = raw.find((r) => r.name === 'climb-only');
    const summaries = raw.map((r) => summarizeCondition(r, r.trials, baseline, KNOB_FIELDS));
    // Attach a separate vs-climb-only comparison so each "climb + new knob"
    // condition can be read against the climb-only baseline that the user
    // actually wants to keep, rather than against the existing default.
    if (climbOnly) {
      for (const s of summaries) {
        const r = raw.find((x) => x.name === s.name);
        s.metricsVsZero = summarizeCondition(r, r.trials, climbOnly, KNOB_FIELDS).metrics;
      }
    }
    const report = {
      meta: {
        trials: args.trials, seedBase: args.seedBase, maxTicks: args.maxTicks,
        maxSeconds: args.maxTicks / GAME_FPS, concurrency: args.concurrency,
        budgetMs: args.budgetMs, configs: conditions.length,
        wallSeconds: (Date.now() - started) / 1000,
        baseline: baseline?.name ?? null,
        climbOnly: climbOnly?.name ?? null,
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
