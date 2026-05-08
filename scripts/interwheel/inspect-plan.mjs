#!/usr/bin/env node
import { createServer } from 'vite';
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

function parseArgs(argv) {
  const args = {
    seed: 42,
    tick: 200,
    maxExtraTicks: 120,
    out: null,
    json: false,
    help: false,
    policy: {},
    searchLimits: {},
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--json') args.json = true;
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--tick=')) args.tick = Number(raw.slice('--tick='.length));
    else if (raw.startsWith('--max-extra=')) args.maxExtraTicks = Number(raw.slice('--max-extra='.length));
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (raw.startsWith('--policy=')) parsePolicyArg(raw.slice('--policy='.length), args.policy);
    else if (raw.startsWith('--search=')) parseSearchArg(raw.slice('--search='.length), args.searchLimits);
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  return args;
}

function parsePolicyArg(value, into) {
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = Number(trimmed.slice(eq + 1).trim());
    if (Number.isFinite(v)) into[k] = v;
  }
}

function parseSearchArg(value, into) {
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = Number(trimmed.slice(eq + 1).trim());
    if (Number.isFinite(v)) into[k] = v;
  }
}

function help() {
  console.log(`Interwheel plan inspector — capture one plan tick as markdown

USAGE:
  node scripts/interwheel/inspect-plan.mjs --seed=42 --tick=200
  node scripts/interwheel/inspect-plan.mjs --seed=42 --tick=400 --policy=climb=1,thoroughness=1
  node scripts/interwheel/inspect-plan.mjs --seed=42 --tick=200 --policy=wall=2 --out=.tmp/inspect-wall2.md
  node scripts/interwheel/inspect-plan.mjs --seed=42 --tick=200 --search=maxStableDepth=5,maxEdgeRollouts=480

OPTIONS:
  --seed=<int>          deterministic level seed (default 42)
  --tick=<int>          game tick at which to arm the inspector (default 200)
  --max-extra=<int>     extra ticks to wait for a stable plan capture (default 120)
  --policy=k=v,...      override policy knobs (climb, thoroughness, wall, pace, detour, patience)
  --search=k=v,...      override search limits (maxStableDepth, maxEdgeRollouts, budgetMs)
  --out=<path>          write markdown to file (in addition to stdout)
  --json                also dump the raw inspection record to stdout

This is a single-shot diagnostic. It runs one trial up to the target tick,
captures one plan tick, and dumps a markdown table comparing all leaf
candidates (top by score, plus the chosen leaf, plus the candidate with
maximum pastilles). Use it when sweeps are not telling you why a knob does
or does not change behavior.
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }

  const server = await createServer({
    server: {
      host: '127.0.0.1',
      port: 0,
      watch: { ignored: ['**/generated-assets/**', '**/dist/**', '**/.tmp/**'] },
    },
  });
  await server.listen();
  const address = server.httpServer.address();
  if (!address || typeof address === 'string') throw new Error('missing Vite server address');

  const browser = await chromium.launch();
  const page = await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${address.port}/analyze-interwheel.html`);
    await page.waitForFunction(
      () => Boolean((window).__interwheelAnalytics__?.inspectPlan),
      null,
      { timeout: 15000 },
    );
    const result = await page.evaluate(async (opts) => {
      const api = (window).__interwheelAnalytics__;
      return await api.inspectPlan(opts);
    }, {
      seed: args.seed,
      targetTick: args.tick,
      maxExtraTicks: args.maxExtraTicks,
      policy: args.policy,
      searchLimits: args.searchLimits,
    });

    process.stdout.write(result.markdown);
    process.stdout.write('\n');
    if (args.json) {
      process.stdout.write('\n--- record ---\n');
      process.stdout.write(JSON.stringify(result.record, null, 2));
      process.stdout.write('\n');
    }
    if (args.out) {
      await mkdir(dirname(args.out), { recursive: true });
      await writeFile(args.out, result.markdown);
      console.error(`wrote ${args.out}`);
    }
    process.exitCode = result.record ? 0 : 2;
  } finally {
    await page.close();
    await browser.close();
    await server.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
