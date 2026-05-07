#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeSweep } from './policy-sweep-utils.mjs';

const GAME_FPS = 40;
const POLICY_KEYS = ['climb', 'collectibles', 'wallRoutes', 'pace'];

function parseArgs(argv) {
  const args = {
    trials: 40,
    seedBase: 4200,
    maxTicks: 1200,
    concurrency: 8,
    budgetMs: 5,
    outDir: null,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--trials=')) args.trials = Number(raw.slice('--trials='.length));
    else if (raw.startsWith('--seed=')) args.seedBase = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--max-ticks=')) args.maxTicks = Number(raw.slice('--max-ticks='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxTicks = Math.ceil(Number(raw.slice('--max-seconds='.length)) * GAME_FPS);
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw.startsWith('--budget-ms=')) args.budgetMs = Number(raw.slice('--budget-ms='.length));
    else if (raw === '--full-budget') args.budgetMs = 1_000_000;
    else if (raw.startsWith('--out=')) args.outDir = raw.slice('--out='.length);
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  for (const [name, value] of Object.entries({
    trials: args.trials,
    seedBase: args.seedBase,
    maxTicks: args.maxTicks,
    concurrency: args.concurrency,
    budgetMs: args.budgetMs,
  })) {
    if (!Number.isFinite(value) || value < 0) {
      console.error(`--${name} must be a finite non-negative number`);
      args.help = true;
    }
  }
  if (args.trials < 1 || args.maxTicks < 1 || args.concurrency < 1) args.help = true;
  return args;
}

function help() {
  console.log(`Interwheel policy sweep

USAGE:
  npm run analyze:interwheel:policies -- --trials=40 --seed=4200 --max-seconds=30
  npm run analyze:interwheel:policies -- --full-budget --trials=20

This runs a repeatable numeric policy characterization over the same seed
population for each condition. Outputs are written under
.tmp/interwheel-policy-sweeps/<timestamp>/.

Policy knobs: ${POLICY_KEYS.join(', ')}
`);
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function sweep(knob, values) {
  return values.map((value) => ({
    group: `sweep:${knob}`,
    name: `${knob}=${value}`,
    policy: { [knob]: value },
    knob,
    value,
  }));
}

function interaction(group, knobA, valuesA, knobB, valuesB) {
  const out = [];
  for (const a of valuesA) {
    for (const b of valuesB) {
      out.push({
        group,
        name: `${knobA}=${a},${knobB}=${b}`,
        policy: { [knobA]: a, [knobB]: b },
        [knobA]: a,
        [knobB]: b,
      });
    }
  }
  return out;
}

function makeConditions() {
  return [
    { group: 'baseline', name: 'default', policy: {} },
    ...sweep('collectibles', [0, 0.5, 1, 1.5, 2, 3]),
    ...sweep('wallRoutes', [0, 0.25, 0.5, 1, 1.5, 2]),
    ...sweep('climb', [0.6, 0.8, 1, 1.2, 1.5]),
    ...sweep('pace', [0.5, 0.8, 1, 1.2, 1.6]),
    ...interaction('collectibles_wallRoutes', 'collectibles', [0.5, 1, 2], 'wallRoutes', [0, 0.5, 1.5]),
  ];
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

async function runCondition(browser, url, condition, args) {
  const chunks = makeChunks(args.trials, args.seedBase, Math.min(args.concurrency, args.trials));
  const started = performance.now();
  const partials = await Promise.all(chunks.map(async (chunk) => {
    const page = await openPage(browser, url);
    try {
      return await page.evaluate(async ({ chunk, condition, maxTicks, budgetMs }) => {
        const plannerConfig = {
          budgetMs,
          maxEdgeRollouts: 240,
          maxStableDepth: 3,
          targetClimb: 400,
          collectSegments: false,
          policy: condition.policy,
        };
        const trials = [];
        for (let i = 0; i < chunk.trials; i += 1) {
          trials.push(await window.__interwheelAnalytics__.runPureTrial(chunk.seedBase + i, maxTicks, plannerConfig));
        }
        return trials.map((trial) => {
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
        });
      }, { chunk, condition, maxTicks: args.maxTicks, budgetMs: args.budgetMs });
    } finally {
      await page.close();
    }
  }));
  return {
    ...condition,
    wallMs: performance.now() - started,
    trials: partials.flat(),
  };
}

function reportMarkdown(report) {
  const lines = [
    '# Interwheel Policy Sweep',
    '',
    `- trials per condition: ${report.meta.trials}`,
    `- seed base: ${report.meta.seedBase}`,
    `- max ticks: ${report.meta.maxTicks}`,
    `- budget ms: ${report.meta.budgetMs}`,
    `- wall seconds: ${report.meta.wallSeconds.toFixed(1)}`,
    '',
    '## Sweep Tables',
    '',
  ];
  for (const [group, rows] of Object.entries(report.sweepTables)) {
    lines.push(`### ${group}`, '');
    lines.push('| condition | height | height Δ% | bonus/min | bonus Δ% | wallJ/min | wallJ Δ% |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of rows) {
      lines.push(
        `| ${row.name} | ${row.height} | ${row.heightDeltaPct} | ${row.bonusScorePerMin} | ${row.bonusScorePerMinDeltaPct} | ${row.wallJumpsPerMin} | ${row.wallJumpsPerMinDeltaPct} |`,
      );
    }
    lines.push('');
  }
  if (report.interactionTable.length > 0) {
    lines.push('### collectibles_wallRoutes', '');
    lines.push('| condition | height | height Δ% | bonus/min | bonus Δ% | wallJ/min | wallJ Δ% |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const row of report.interactionTable) {
      lines.push(
        `| ${row.name} | ${row.height} | ${row.heightDeltaPct} | ${row.bonusScorePerMin} | ${row.bonusScorePerMinDeltaPct} | ${row.wallJumpsPerMin} | ${row.wallJumpsPerMinDeltaPct} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }
  const outDir = args.outDir ?? join('.tmp', 'interwheel-policy-sweeps', timestamp());
  await mkdir(outDir, { recursive: true });

  const vite = await createServer({
    server: {
      port: 0,
      host: '127.0.0.1',
      watch: { ignored: ['**/generated-assets/**', '**/dist/**', '**/.tmp/**'] },
    },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;
  const url = `http://127.0.0.1:${port}/analyze-interwheel.html`;
  const browser = await chromium.launch({ headless: true });
  const started = Date.now();
  try {
    const raw = [];
    const conditions = makeConditions();
    for (let i = 0; i < conditions.length; i += 1) {
      const condition = conditions[i];
      console.error(`[${i + 1}/${conditions.length}] ${condition.name}`);
      const result = await runCondition(browser, url, condition, args);
      raw.push(result);
      const quick = summarizeSweep(raw).summaries.at(-1);
      console.error(
        `  height=${quick.metrics.height.mean.toFixed(1)}m` +
          ` wallJ/min=${quick.metrics.wallJumpsPerMin.mean.toFixed(1)}` +
          ` bonus/min=${quick.metrics.bonusScorePerMin.mean.toFixed(1)}` +
          ` wall=${(result.wallMs / 1000).toFixed(1)}s`,
      );
    }

    const summary = summarizeSweep(raw);
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
      },
      ...summary,
    };
    await writeFile(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
    await writeFile(join(outDir, 'report.md'), reportMarkdown(report));
    console.log(JSON.stringify({ outDir, ...report.meta }, null, 2));
  } finally {
    await browser.close();
    await vite.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
