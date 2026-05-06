#!/usr/bin/env node
// Standalone benchmark runner for the Interwheel A* agent.
//
// USAGE:
//   npm run bench                      # 5 trials, random levels
//   npm run bench -- --trials=20       # 20 trials
//   npm run bench -- --seed=42         # 5 trials with seedBase=42 (deterministic levels)
//   npm run bench -- --trials=10 --seed=42
//   npm run bench -- --json            # machine-readable JSON output
//   npm run bench -- --help            # show this help text
//
// PRIMARY METRIC: height in meters (median over the trial population).
//
// This is a benchmark, not a test — it never fails on score thresholds.
// It prints a summary report (or JSON) so a human or an LLM can compare
// experiments. Reproducibility: passing --seed makes the benchmark sample
// the same population of levels each invocation, so AI changes can be
// A/B-compared cleanly.

import { createServer } from 'vite';
import { chromium } from '@playwright/test';

function parseArgs(argv) {
  const args = { trials: 5, seedBase: null, json: false, help: false };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--json') args.json = true;
    else if (raw.startsWith('--trials=')) args.trials = Number(raw.slice('--trials='.length));
    else if (raw.startsWith('--seed=')) args.seedBase = Number(raw.slice('--seed='.length));
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
  return args;
}

function help() {
  console.log(`Interwheel A* benchmark

USAGE:
  npm run bench                       5 trials, random levels
  npm run bench -- --trials=N         set trial count
  npm run bench -- --seed=S           seed level generation (deterministic)
  npm run bench -- --json             emit machine-readable JSON
  npm run bench -- --help             this help

The primary metric is height (median, in meters). Higher is better. The
human player record we are calibrating against is ~2000m.
`);
}

function fmt(stats, unit = '') {
  const f = (n) => (Number.isFinite(n) ? n.toFixed(unit === 'ms' ? 0 : 1) : '?');
  return [
    `min=${f(stats.min)}${unit}`,
    `p10=${f(stats.p10)}${unit}`,
    `median=${f(stats.median)}${unit}`,
    `p90=${f(stats.p90)}${unit}`,
    `max=${f(stats.max)}${unit}`,
    `mean=${f(stats.mean)}${unit}`,
    `stdev=${f(stats.stdev)}${unit}`,
  ].join('  ');
}

function prettyPrint(result) {
  const { config, stats, trials, wallMs, cpuMs } = result;
  console.log('Interwheel A* benchmark');
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
        `  cpu=${Math.round(t.cpuMs)}ms${seedTag}`,
    );
  }
  console.log('');
  console.log('stats:');
  console.log(`  height_m   ${fmt(stats.height_m, 'm')}`);
  console.log(`  score      ${fmt(stats.score)}`);
  console.log(`  ticks      ${fmt(stats.ticks)}`);
  console.log(`  cpu        ${fmt(stats.cpuMs, 'ms')}`);
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
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;
  const url = `http://127.0.0.1:${port}/bench.html`;

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
    await page.waitForFunction(() => Boolean(window.__bench__), null, { timeout: 30_000 });

    const result = await page.evaluate(
      ([trials, seedBase]) =>
        window.__bench__.runBenchmark({
          trials,
          seedBase: seedBase === null ? undefined : seedBase,
        }),
      [args.trials, args.seedBase],
    );

    if (args.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      prettyPrint(result);
    }
  } catch (err) {
    console.error('Bench failed:', err);
    exitCode = 1;
  } finally {
    await browser.close();
    await vite.close();
  }
  process.exit(exitCode);
}

main();
