#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { summarizeSweep } from './policy-sweep-utils.mjs';

const GAME_FPS = 40;

function parseArgs(argv) {
  const args = {
    trials: 24,
    seedBase: 4200,
    maxTicks: 1200,
    concurrency: 16,
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
    else { console.error(`Unknown argument: ${raw}`); args.help = true; }
  }
  return args;
}

function help() {
  console.log(`Interwheel collectibles-focused sweep.

Default: trials=24 concurrency=16 max-ticks=1200 (=30s) budget-ms=5

USAGE:
  node scripts/interwheel/sweep-collectibles.mjs [--trials=24] [--seed=4200] [--max-seconds=30] [--concurrency=16]
`);
}

function timestamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

// Aggressive sweep so we can see both saturation and over-driving behavior of
// the now-uncapped collectibles term.
function makeConditions() {
  const conditions = [
    { group: 'baseline', name: 'default', policy: {} },
  ];
  // Wide collectibles sweep including extreme values.
  for (const v of [0, 0.5, 1, 2, 3, 5, 8, 12, 20]) {
    conditions.push({ group: 'sweep:collectibles', name: `collectibles=${v}`, policy: { collectibles: v }, knob: 'collectibles', value: v });
  }
  // Pair high collectibles with lower climb/pace so the height term isn't dwarfing it.
  for (const c of [3, 8, 20]) {
    conditions.push({ group: 'collect+lowClimb', name: `c=${c},climb=0.3`, policy: { collectibles: c, climb: 0.3 } });
  }
  for (const c of [3, 8, 20]) {
    conditions.push({ group: 'collect+lowPace', name: `c=${c},pace=0.3`, policy: { collectibles: c, pace: 0.3 } });
  }
  return conditions;
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
            uniquePerceivedPastilles: trial.uniquePerceivedPastilles,
            captureRate: trial.uniquePerceivedPastilles > 0
              ? summary.pastilles / trial.uniquePerceivedPastilles
              : 0,
            missedPerceived: Math.max(0, trial.uniquePerceivedPastilles - summary.pastilles),
            planMs: trial.planner.avgPlanMs,
            edges: trial.planner.avgEdges,
            scoreHeightTerm: planner.bestScoreBreakdown.height.mean,
            scoreCollectTerm: planner.bestScoreBreakdown.collectibles.mean,
            scoreMissedTerm: planner.bestScoreBreakdown.missedCollect?.mean ?? 0,
            scoreWallTerm: planner.bestScoreBreakdown.wallRoute.mean,
            scorePaceCost: planner.bestScoreBreakdown.paceCost.mean,
            scoreTotal: planner.bestScoreBreakdown.total.mean,
          };
        });
      }, { chunk, condition, maxTicks: args.maxTicks, budgetMs: args.budgetMs });
    } finally { await page.close(); }
  }));
  return { ...condition, wallMs: performance.now() - started, trials: partials.flat() };
}

function reportMarkdown(report) {
  const lines = [
    '# Interwheel Collectibles Investigation',
    '',
    `- trials per condition: ${report.meta.trials}`,
    `- seed base: ${report.meta.seedBase}`,
    `- max ticks: ${report.meta.maxTicks} (= ${(report.meta.maxTicks / GAME_FPS).toFixed(1)}s game time)`,
    `- budget ms: ${report.meta.budgetMs}`,
    `- wall seconds: ${report.meta.wallSeconds.toFixed(1)}`,
    '',
    '## Per-condition summary',
    '',
    '| condition | height(m) | perceived | captured | **rate** | missed | past/min | wallJ/min |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ];
  for (const s of report.summaries) {
    const perceived = s.metrics.uniquePerceivedPastilles?.mean ?? 0;
    const captured = s.metrics.pastilles?.mean ?? 0;
    const rate = s.metrics.captureRate?.mean ?? 0;
    const missed = s.metrics.missedPerceived?.mean ?? 0;
    lines.push(
      `| ${s.name} | ${s.metrics.height.mean.toFixed(1)} | ${perceived.toFixed(1)} | ${captured.toFixed(1)} | **${(rate * 100).toFixed(1)}%** | ${missed.toFixed(1)} | ${s.metrics.pastillesPerMin.mean.toFixed(2)} | ${s.metrics.wallJumpsPerMin.mean.toFixed(2)} |`,
    );
  }
  lines.push('', '## Slopes (per-knob linear fit)', '');
  lines.push('```json');
  lines.push(JSON.stringify(report.slopes, null, 2));
  lines.push('```');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }
  const outDir = args.outDir ?? join('.tmp', 'interwheel-collectibles', timestamp());
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
    const conditions = makeConditions();
    for (let i = 0; i < conditions.length; i += 1) {
      const condition = conditions[i];
      console.error(`[${i + 1}/${conditions.length}] ${condition.name}`);
      const result = await runCondition(browser, url, condition, args);
      raw.push(result);
      const quick = summarizeSweep(raw).summaries.at(-1);
      const policyVal = condition.policy?.collectibles ?? 1;
      const ratio = policyVal === 0 ? 0 : quick.metrics.scoreCollectTerm.mean / policyVal;
      console.error(
        `  h=${quick.metrics.height.mean.toFixed(1)}m` +
          ` past/min=${quick.metrics.pastillesPerMin.mean.toFixed(2)}` +
          ` spk/min=${quick.metrics.sparksPerMin.mean.toFixed(2)}` +
          ` bonus/min=${quick.metrics.bonusScorePerMin.mean.toFixed(0)}` +
          ` collectTerm=${quick.metrics.scoreCollectTerm.mean.toFixed(0)}` +
          ` (ratio/policy=${ratio.toFixed(0)})` +
          ` wall=${(result.wallMs / 1000).toFixed(1)}s`,
      );
    }
    const summary = summarizeSweep(raw);
    // Re-attach policy to summaries so reportMarkdown can compute ratios.
    for (const s of summary.summaries) {
      const src = raw.find((r) => r.name === s.name);
      if (src) s.policy = src.policy;
    }
    const report = {
      meta: {
        trials: args.trials, seedBase: args.seedBase, maxTicks: args.maxTicks,
        maxSeconds: args.maxTicks / GAME_FPS, concurrency: args.concurrency,
        budgetMs: args.budgetMs, configs: conditions.length,
        wallSeconds: (Date.now() - started) / 1000,
      },
      ...summary,
    };
    await writeFile(join(outDir, 'raw.json'), JSON.stringify(raw, null, 2));
    await writeFile(join(outDir, 'summary.json'), JSON.stringify(report, null, 2));
    await writeFile(join(outDir, 'report.md'), reportMarkdown(report));
    console.log(JSON.stringify({ outDir, ...report.meta }, null, 2));
  } finally { await browser.close(); await vite.close(); }
}

main().catch((err) => { console.error(err); process.exit(1); });
