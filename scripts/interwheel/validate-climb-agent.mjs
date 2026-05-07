#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const GAME_FPS = 40;

function parseArgs(argv) {
  const args = {
    seed: 42,
    maxTicks: 5 * 60 * GAME_FPS,
    minHeightMeters: 1_000,
    lookbackTicks: 30 * GAME_FPS,
    minRecentGainMeters: 100,
    json: false,
    outDir: null,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--json') args.json = true;
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--max-ticks=')) args.maxTicks = Number(raw.slice('--max-ticks='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxTicks = Math.ceil(Number(raw.slice('--max-seconds='.length)) * GAME_FPS);
    else if (raw.startsWith('--min-height=')) args.minHeightMeters = Number(raw.slice('--min-height='.length));
    else if (raw.startsWith('--lookback-seconds=')) args.lookbackTicks = Math.ceil(Number(raw.slice('--lookback-seconds='.length)) * GAME_FPS);
    else if (raw.startsWith('--min-recent-gain=')) args.minRecentGainMeters = Number(raw.slice('--min-recent-gain='.length));
    else if (raw.startsWith('--out=')) args.outDir = raw.slice('--out='.length);
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  for (const [name, value] of Object.entries(args)) {
    if (['json', 'outDir', 'help'].includes(name)) continue;
    if (!Number.isFinite(value) || value < 0) {
      console.error(`--${name} must be a finite non-negative number`);
      args.help = true;
    }
  }
  if (args.maxTicks < 1 || args.lookbackTicks < 1) args.help = true;
  return args;
}

function help() {
  console.log(`Interwheel climb-agent empirical validator

USAGE:
  npm run analyze:interwheel:climb
  npm run analyze:interwheel:climb -- --seed=42 --max-seconds=300
  npm run analyze:interwheel:climb -- --seed=42 --json

This is offline experimental tooling. It runs one deterministic seed through
the trusted pure simulator with a climb-biased planner policy. A pass means the
agent survived to the time cap, reached the minimum height, and still made
recent upward progress near the end of the run.
`);
}

async function openPage(browser, url) {
  const page = await browser.newPage();
  page.on('pageerror', (err) => {
    throw err;
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error('page console error:', msg.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => Boolean(window.__interwheelAnalytics__), null, { timeout: 30_000 });
  return page;
}

function heightTimeline(trial) {
  const points = [{ tick: 0, height: 0, source: 'start' }];
  for (const jump of trial.analytics.events.jumps) {
    points.push({ tick: jump.tick, height: jump.heightMeters, source: jump.source === 'wall' ? 'wallJump' : 'wheelJump' });
  }
  for (const stay of trial.analytics.events.wheelStays) {
    points.push({ tick: stay.endTick, height: stay.endHeightMeters, source: 'wheelStay' });
  }
  points.push({ tick: trial.ticks, height: trial.heightMeters, source: 'final' });
  return points.sort((a, b) => a.tick - b.tick);
}

function validateTrial(trial, args) {
  const summary = trial.analytics.summary;
  const timeline = heightTimeline(trial);
  const lookbackStart = Math.max(0, trial.ticks - args.lookbackTicks);
  const maxBeforeLookback = timeline
    .filter((point) => point.tick <= lookbackStart)
    .reduce((max, point) => Math.max(max, point.height), 0);
  const recentGainMeters = trial.heightMeters - maxBeforeLookback;
  const survivedToCap = trial.ticks >= args.maxTicks && summary.deathCause === 'timeout';
  const reachedMinimum = trial.heightMeters >= args.minHeightMeters;
  const madeRecentProgress = recentGainMeters >= args.minRecentGainMeters;
  const passed = survivedToCap && reachedMinimum && madeRecentProgress;
  return {
    passed,
    reasons: {
      survivedToCap,
      reachedMinimum,
      madeRecentProgress,
    },
    recentGainMeters,
    maxBeforeLookback,
    lookbackStartTick: lookbackStart,
    lastTimelinePoints: timeline.slice(-12),
  };
}

function printReport(report) {
  const trial = report.trial;
  const summary = trial.analytics.summary;
  const validation = report.validation;
  console.log('Interwheel climb-agent empirical validation');
  console.log(`seed:       ${report.config.seed}`);
  console.log(`max ticks:  ${report.config.maxTicks} (${(report.config.maxTicks / GAME_FPS).toFixed(1)}s)`);
  console.log(`policy:     ${JSON.stringify(report.config.plannerConfig.policy)}`);
  console.log(`result:     ${validation.passed ? 'PASS' : 'FAIL'}`);
  console.log(`height:     ${trial.heightMeters}m`);
  console.log(`score:      ${trial.score}`);
  console.log(`ticks:      ${trial.ticks}`);
  console.log(`death:      ${summary.deathCause ?? 'none'}`);
  console.log(`recent:     +${validation.recentGainMeters}m over last ${(report.config.lookbackTicks / GAME_FPS).toFixed(1)}s window`);
  console.log(`movement:   jumps=${summary.jumps} wheel=${summary.wheelJumps} wall=${summary.wallJumps} deaths=${summary.deathCause ?? 'none'}`);
  console.log(`planner:    ${trial.planner.avgPlanMs.toFixed(2)}ms/plan ${trial.planner.avgEdges.toFixed(0)} edges`);
  if (!validation.passed) {
    console.log('checks:');
    for (const [name, ok] of Object.entries(validation.reasons)) {
      console.log(`  ${ok ? 'ok ' : 'bad'} ${name}`);
    }
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }

  const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing Vite server address');
  const browser = await chromium.launch();
  const url = `http://127.0.0.1:${address.port}/analyze-interwheel.html`;
  try {
    const page = await openPage(browser, url);
    try {
      const plannerConfig = {
        budgetMs: 5,
        maxEdgeRollouts: 240,
        maxStableDepth: 3,
        targetClimb: 500,
        collectSegments: false,
        policy: {
          climb: 1.6,
          collectibles: 0,
          wallRoutes: 0,
          pace: 0.8,
        },
      };
      const trial = await page.evaluate(async ({ seed, maxTicks, plannerConfig }) => {
        return await window.__interwheelAnalytics__.runPureTrial(seed, maxTicks, plannerConfig);
      }, { seed: args.seed, maxTicks: args.maxTicks, plannerConfig });
      const report = {
        config: {
          seed: args.seed,
          maxTicks: args.maxTicks,
          lookbackTicks: args.lookbackTicks,
          minHeightMeters: args.minHeightMeters,
          minRecentGainMeters: args.minRecentGainMeters,
          plannerConfig,
        },
        validation: validateTrial(trial, args),
        trial,
      };
      if (args.outDir) {
        await mkdir(args.outDir, { recursive: true });
        await writeFile(join(args.outDir, `climb-agent-seed-${args.seed}.json`), JSON.stringify(report, null, 2));
      }
      if (args.json) console.log(JSON.stringify(report, null, 2));
      else printReport(report);
      process.exitCode = report.validation.passed ? 0 : 1;
    } finally {
      await page.close();
    }
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
