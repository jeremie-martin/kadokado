#!/usr/bin/env node
// Standalone analytics runner for the Interwheel A* agent.
//
// USAGE:
//   npm run analyze:interwheel                      # 5 trials, random levels
//   npm run analyze:interwheel -- --trials=20       # 20 trials
//   npm run analyze:interwheel -- --seed=42         # 5 trials with seedBase=42 (deterministic levels)
//   npm run analyze:interwheel -- --trials=10 --seed=42
//   npm run analyze:interwheel -- --quick           # 1 seeded trial, capped at 30 in-game seconds
//   npm run analyze:interwheel -- --max-seconds=30  # cap each trial's simulated duration
//   npm run analyze:interwheel -- --json            # machine-readable JSON output
//   npm run analyze:interwheel -- --help            # show this help text
//
// PRIMARY METRIC: height in meters (median over the trial population).
//
// This is an analytics run, not a test - it never fails on score thresholds.
// It prints a summary report (or JSON) so a human or an LLM can compare
// experiments. Reproducibility: passing --seed makes the analytics sample
// the same population of levels each invocation, so AI changes can be
// A/B-compared cleanly.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const GAME_FPS = 40;
const DEFAULT_MAX_TICKS = 24_000;
const QUICK_MAX_SECONDS = 30;

function parseArgs(argv) {
  const args = { trials: 5, seedBase: null, maxTicks: null, json: false, help: false };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--json') args.json = true;
    else if (raw === '--quick') {
      args.trials = 1;
      args.seedBase = 42;
      args.maxTicks = QUICK_MAX_SECONDS * GAME_FPS;
    }
    else if (raw.startsWith('--trials=')) args.trials = Number(raw.slice('--trials='.length));
    else if (raw.startsWith('--seed=')) args.seedBase = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--max-ticks=')) args.maxTicks = Number(raw.slice('--max-ticks='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxTicks = Math.ceil(Number(raw.slice('--max-seconds='.length)) * GAME_FPS);
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  if (Number.isNaN(args.trials) || args.trials < 1) {
    console.error('--trials must be a positive integer');
    args.help = true;
  }
  if (args.seedBase !== null && Number.isNaN(args.seedBase)) {
    console.error('--seed must be an integer');
    args.help = true;
  }
  if (args.maxTicks !== null && (!Number.isFinite(args.maxTicks) || args.maxTicks < 1)) {
    console.error('--max-ticks/--max-seconds must produce a positive tick count');
    args.help = true;
  }
  return args;
}

function help() {
  console.log(`Interwheel A* analytics

USAGE:
  npm run analyze:interwheel                       5 trials, random levels
  npm run analyze:interwheel -- --trials=N         set trial count
  npm run analyze:interwheel -- --seed=S           seed level generation (deterministic)
  npm run analyze:interwheel -- --quick            1 seed=42 trial, max 30 in-game seconds
  npm run analyze:interwheel -- --max-seconds=N    cap each trial to N in-game seconds
  npm run analyze:interwheel -- --max-ticks=N      cap each trial to N game ticks
  npm run analyze:interwheel -- --json             emit machine-readable JSON
  npm run analyze:interwheel -- --help             this help

The primary metric is height (median, in meters). Higher is better. The
human player record we are calibrating against is ~2000m. The default cap is
${DEFAULT_MAX_TICKS} ticks (= ${(DEFAULT_MAX_TICKS / GAME_FPS).toFixed(0)} in-game seconds).
`);
}

function fmt(stats, unit = '') {
  const f = (n) => (Number.isFinite(n) ? n.toFixed(unit === 'ms' ? 0 : 1) : '?');
  return [
    `min=${f(stats.min)}${unit}`,
    `p10=${f(stats.p10)}${unit}`,
    `median=${f(stats.median)}${unit}`,
    `p90=${f(stats.p90)}${unit}`,
    `p95=${f(stats.p95)}${unit}`,
    `max=${f(stats.max)}${unit}`,
    `mean=${f(stats.mean)}${unit}`,
    `stdev=${f(stats.stdev)}${unit}`,
  ].join('  ');
}

function statsOf(values) {
  if (values.length === 0) {
    return { count: 0, total: 0, min: 0, max: 0, mean: 0, median: 0, p10: 0, p25: 0, p75: 0, p90: 0, p95: 0, stdev: 0 };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const count = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  const mean = total / count;
  const variance = sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, count);
  const at = (frac) => sorted[Math.min(count - 1, Math.max(0, Math.floor(frac * count)))];
  return {
    count,
    total,
    min: sorted[0],
    max: sorted[count - 1],
    mean,
    median: at(0.5),
    p10: at(0.1),
    p25: at(0.25),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
    stdev: Math.sqrt(variance),
  };
}

function fmtNumber(value, unit = '', digits = 1) {
  if (!Number.isFinite(value)) return '?';
  return `${value.toFixed(digits)}${unit}`;
}

function fmtDist(stats, unit = '', digits = 1) {
  return `count=${stats.count}  median=${fmtNumber(stats.median, unit, digits)}  p95=${fmtNumber(stats.p95, unit, digits)}  max=${fmtNumber(stats.max, unit, digits)}  total=${fmtNumber(stats.total, unit, digits)}`;
}

function combineActionRates(summaries) {
  const totalTicks = summaries.reduce((sum, summary) => sum + summary.ticks, 0);
  const durationMinutes = totalTicks > 0 ? totalTicks / GAME_FPS / 60 : 0;
  const perMinute = (count) => (durationMinutes > 0 ? count / durationMinutes : 0);
  const presses = summaries.reduce((sum, summary) => sum + summary.presses, 0);
  const jumps = summaries.reduce((sum, summary) => sum + summary.jumps, 0);
  const wheelJumps = summaries.reduce((sum, summary) => sum + summary.wheelJumps, 0);
  const wallJumps = summaries.reduce((sum, summary) => sum + summary.wallJumps, 0);
  const flights = summaries.reduce((sum, summary) => sum + summary.flights, 0);
  return {
    presses,
    jumps,
    wheelJumps,
    wallJumps,
    flights,
    pressesPerMinute: perMinute(presses),
    jumpsPerMinute: perMinute(jumps),
    wheelJumpsPerMinute: perMinute(wheelJumps),
    wallJumpsPerMinute: perMinute(wallJumps),
    flightsPerMinute: perMinute(flights),
  };
}

function combinePhaseTime(summaries) {
  const totalTicks = summaries.reduce((sum, summary) => sum + summary.ticks, 0);
  const sumPhase = (field) => summaries.reduce((sum, summary) => sum + (summary.phaseTime?.[field] ?? 0), 0);
  const wheelTicks = sumPhase('wheelTicks');
  const flightTicks = sumPhase('flightTicks');
  const wallTicks = sumPhase('wallTicks');
  const classifiedTicks = sumPhase('classifiedTicks') || wheelTicks + flightTicks + wallTicks;
  const unclassifiedTicks = Math.max(0, totalTicks - classifiedTicks);
  const pct = (ticks) => (totalTicks > 0 ? (100 * ticks) / totalTicks : 0);
  return {
    wheelTicks,
    wheelSeconds: wheelTicks / GAME_FPS,
    wheelPercent: pct(wheelTicks),
    flightTicks,
    flightSeconds: flightTicks / GAME_FPS,
    flightPercent: pct(flightTicks),
    wallTicks,
    wallSeconds: wallTicks / GAME_FPS,
    wallPercent: pct(wallTicks),
    classifiedTicks,
    classifiedSeconds: classifiedTicks / GAME_FPS,
    classifiedPercent: pct(classifiedTicks),
    unclassifiedTicks,
    unclassifiedSeconds: unclassifiedTicks / GAME_FPS,
    unclassifiedPercent: pct(unclassifiedTicks),
  };
}

function fmtPhase(label, ticks, seconds, percent) {
  return `${label}=${fmtNumber(ticks, 't', 0)} ${fmtNumber(seconds, 's', 1)} ${fmtNumber(percent, '%', 1)}`;
}

function printMovementAnalytics(trials) {
  const summaries = trials.map((trial) => trial.analytics.summary);
  const jumps = trials.flatMap((trial) => trial.analytics.events.jumps);
  const wheelStays = trials.flatMap((trial) => trial.analytics.events.wheelStays);
  const wallDrifts = trials.flatMap((trial) => trial.analytics.events.wallDrifts);
  const flights = trials.flatMap((trial) => trial.analytics.events.flights);
  const jumpIntervals = trials.flatMap((trial) => {
    const trialJumps = trial.analytics.events.jumps;
    return trialJumps.slice(1).map((jump, index) => jump.tick - trialJumps[index].tick);
  });
  const totalTicks = summaries.reduce((sum, summary) => sum + summary.ticks, 0);
  const actions = combineActionRates(summaries);
  const phases = combinePhaseTime(summaries);
  const plannerPlans = summaries.reduce((sum, summary) => sum + summary.planner.plans, 0);
  const plannerModes = summaries.reduce((acc, summary) => {
    for (const [mode, count] of Object.entries(summary.planner.modes)) acc[mode] = (acc[mode] ?? 0) + count;
    return acc;
  }, {});
  const planMsP95 = Math.max(...summaries.map((summary) => summary.planner.planMs.p95), 0);
  const planMsMax = Math.max(...summaries.map((summary) => summary.planner.planMs.max), 0);
  const edgesP95 = Math.max(...summaries.map((summary) => summary.planner.edgesEvaluated.p95), 0);
  const edgesMax = Math.max(...summaries.map((summary) => summary.planner.edgesEvaluated.max), 0);

  console.log('');
  console.log('movement analytics:');
  console.log(
    `  actions     presses=${actions.presses} ${fmtNumber(actions.pressesPerMinute, '/min', 1)}  ` +
      `jumps=${actions.jumps} ${fmtNumber(actions.jumpsPerMinute, '/min', 1)}  ` +
      `wheelJumps=${actions.wheelJumps} ${fmtNumber(actions.wheelJumpsPerMinute, '/min', 1)}  ` +
      `wallJumps=${actions.wallJumps} ${fmtNumber(actions.wallJumpsPerMinute, '/min', 1)}`,
  );
  console.log(
    `  phases      ${fmtPhase('wheel', phases.wheelTicks, phases.wheelSeconds, phases.wheelPercent)}  ` +
      `${fmtPhase('flight', phases.flightTicks, phases.flightSeconds, phases.flightPercent)}  ` +
      `${fmtPhase('wall', phases.wallTicks, phases.wallSeconds, phases.wallPercent)}` +
      (phases.unclassifiedTicks > 0
        ? `  ${fmtPhase('other', phases.unclassifiedTicks, phases.unclassifiedSeconds, phases.unclassifiedPercent)}`
        : ''),
  );
  console.log(`  jump gaps   ${fmtDist(statsOf(jumpIntervals), 't', 0)}`);
  console.log(`  wheel stay  duration ${fmtDist(statsOf(wheelStays.map((stay) => stay.durationTicks)), 't', 0)}`);
  console.log(`  wheel revs  ${fmtDist(statsOf(wheelStays.map((stay) => stay.revolutions)), 'rev', 2)}`);
  console.log(`  wall drift  duration ${fmtDist(statsOf(wallDrifts.map((drift) => drift.durationTicks)), 't', 0)}`);
  console.log(`  wall drift  deltaY ${fmtDist(statsOf(wallDrifts.map((drift) => drift.deltaY)), 'px', 1)}`);
  console.log(`  flights     duration ${fmtDist(statsOf(flights.map((flight) => flight.durationTicks)), 't', 0)}`);
  console.log('');
  console.log('planner analytics:');
  console.log(
    `  plans=${plannerPlans}  modes=${Object.entries(plannerModes).map(([mode, count]) => `${mode}:${count}`).join(', ')}`,
  );
  console.log(`  planMs      p95(max trial)=${fmtNumber(planMsP95, 'ms', 1)}  max=${fmtNumber(planMsMax, 'ms', 1)}`);
  console.log(`  edges       p95(max trial)=${fmtNumber(edgesP95, '', 0)}  max=${fmtNumber(edgesMax, '', 0)}`);
}

function prettyPrint(result) {
  const { config, stats, trials, wallMs, cpuMs } = result;
  console.log('Interwheel A* analytics');
  console.log('=======================');
  console.log(`config:    trials=${config.trials}  seedBase=${config.seedBase ?? 'random'}  maxTicks=${config.maxTicks}`);
  console.log(`planner:   ${JSON.stringify(config.plannerConfig)}`);
  console.log('');
  console.log('trials:');
  for (let i = 0; i < trials.length; i += 1) {
    const t = trials[i];
    const seedTag = t.seed !== null ? `  seed=${t.seed}` : '';
    console.log(
      `  #${String(i + 1).padStart(2)}  height=${String(t.heightMeters).padStart(4)}m` +
        `  score=${String(t.score).padStart(6)}  ticks=${String(t.ticks).padStart(4)}` +
        `  cpu=${Math.round(t.cpuMs)}ms` +
        `  jumps=${String(t.analytics.summary.jumps).padStart(3)}` +
        `  wheelRev.med=${t.analytics.summary.wheelStayRevolutions.median.toFixed(2)}` +
        `  wallDrifts=${String(t.analytics.summary.wallDrifts).padStart(2)}` +
        (t.planner ? `  plan=${t.planner.avgPlanMs.toFixed(2)}ms/${Math.round(t.planner.avgEdges)}e` : '') +
        seedTag,
    );
  }
  console.log('');
  console.log('stats:');
  console.log(`  height_m   ${fmt(stats.height_m, 'm')}`);
  console.log(`  score      ${fmt(stats.score)}`);
  console.log(`  ticks      ${fmt(stats.ticks)}`);
  console.log(`  cpu        ${fmt(stats.cpuMs, 'ms')}`);
  printMovementAnalytics(trials);
  console.log('');
  const heightMedian = Math.round(stats.height_m.median);
  console.log(`primary metric: height median = ${heightMedian}m`);
  console.log(`wall: ${(wallMs / 1000).toFixed(1)}s   cpu: ${(cpuMs / 1000).toFixed(1)}s`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }

  const vite = await createServer({
    server: {
      port: 0,
      host: '127.0.0.1',
      watch: {
        ignored: ['**/generated-assets/**', '**/dist/**', '**/.tmp/**'],
      },
    },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;
  const url = `http://127.0.0.1:${port}/analyze-interwheel.html`;

  const browser = await chromium.launch({ headless: true });
  let exitCode = 0;
  try {
    const page = await browser.newPage();

    page.on('pageerror', (err) => {
      console.error('Page error:', err.message);
      exitCode = 1;
    });
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        console.error('Console error:', msg.text());
        exitCode = 1;
      }
    });

    await page.goto(url);
    await page.waitForFunction(() => Boolean(window.__interwheelAnalytics__), null, { timeout: 30_000 });

    const result = await page.evaluate(
      ([trials, seedBase, maxTicks]) =>
        window.__interwheelAnalytics__.runAnalyze({
          trials,
          seedBase: seedBase === null ? undefined : seedBase,
          maxTicks: maxTicks === null ? undefined : maxTicks,
        }),
      [args.trials, args.seedBase, args.maxTicks],
    );

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      prettyPrint(result);
    }
  } catch (err) {
    console.error('Analytics failed:', err);
    exitCode = 1;
  } finally {
    await browser.close();
    await vite.close();
  }
  process.exit(exitCode);
}

main();
