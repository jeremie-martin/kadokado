#!/usr/bin/env node
// Build a "stall corpus": scan a range of seeds under the video preset and
// classify each run's death so we can isolate seeds where the planner
// genuinely STALLED in a back-and-forth wheel loop vs seeds where it died
// because the level was unwinnable from the start.
//
// Each run is the same headless playground.html harness used by make-video
// and repro-death — the live planner via attachAI(), no rendering. Seeds
// are scanned sequentially (single chromium page reused) for ~2s each.
//
// Usage:
//   node scripts/interwheel/stall-corpus.mjs                # default 4200..4299
//   node scripts/interwheel/stall-corpus.mjs --seed-base=4200 --count=100
//   node scripts/interwheel/stall-corpus.mjs --tag=baseline # writes .tmp/stall-corpus/baseline.json
//
// Classification rules (last STALL_WINDOW_TICKS before death):
//   - 'stall'     → net height gain < STALL_NET_GAIN_M meters AND distinct
//                   stable-state wheels visited <= STALL_MAX_WHEELS
//   - 'drowned'   → death cause was water and not classified as stall
//   - 'exploded'  → death cause was mine (explosion)
//   - 'surviving' → run did not end within max-seconds
//   - 'other'     → death of unknown cause not matching above
//
// Output: prints a console table summary, writes per-seed JSON to
// .tmp/stall-corpus/<tag>.json. Two such JSONs (e.g. baseline.json and
// fix-2a.json) can be diffed by --compare to show stall-rate delta and
// per-seed verdict transitions.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const STAGE_SIZE = 300;
const GAME_FPS = 40;

const STALL_WINDOW_TICKS = 40;     // ~1.0s of in-game history before death
const STALL_NET_GAIN_M = 5;        // <5 m climbed in window → stalled
const STALL_MAX_WHEELS = 3;        // visited at most 3 distinct wheels in window

function parseArgs(argv) {
  const args = {
    seedBase: 4200,
    count: 100,
    maxSeconds: 60,
    preset: 'video',
    tag: null,
    outDir: '.tmp/stall-corpus',
    compare: null,
    headed: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--headed') args.headed = true;
    else if (raw.startsWith('--seed-base=')) args.seedBase = Number(raw.slice('--seed-base='.length));
    else if (raw.startsWith('--count=')) args.count = Number(raw.slice('--count='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length);
    else if (raw.startsWith('--tag=')) args.tag = raw.slice('--tag='.length);
    else if (raw.startsWith('--out-dir=')) args.outDir = raw.slice('--out-dir='.length);
    else if (raw.startsWith('--compare=')) args.compare = raw.slice('--compare='.length);
    else throw new Error(`Unknown arg: ${raw}`);
  }
  return args;
}

function devicePixelRatioSource(scale) {
  return `(() => { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ${scale} }); })();`;
}

async function setupVideoPresetPage(page) {
  await page.evaluate(({ }) => {
    const game = window.__game__;
    if (!game?.app) throw new Error('Interwheel game not ready');
    game.app.ticker.stop();
  }, {});
}

// Run one seed in the page; returns the death classification record.
async function runSeed(page, seed, preset, maxTicks) {
  return await page.evaluate(({ s, preset, maxT, STALL_WINDOW_TICKS, STALL_NET_GAIN_M, STALL_MAX_WHEELS }) => {
    const game = window.__game__;
    // Apply scene preset + reseed via the live UI controls (fires
    // applySceneOverridesToSim via the wrapped reset).
    const presetBtn = document.getElementById(`scene-preset-${preset}`);
    if (!presetBtn) throw new Error(`scene-preset-${preset} button missing`);
    presetBtn.click();
    const seedInput = document.getElementById('game-seed');
    seedInput.value = String(s);
    seedInput.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('game-reseed').click();

    // Reseed Math.random AFTER the wrapped reset has consumed its own seeded
    // stream — same trick as make-video.mjs. Keeps planner sampling
    // deterministic across seeds.
    let rs = (s | 0) >>> 0;
    Math.random = () => {
      rs = (rs + 0x6d2b79f5) | 0;
      let t = rs;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const PX_PER_M = 5;
    // Ring buffer of (tick, x, y, wheelIdx, state) for the stall window.
    const ring = new Array(STALL_WINDOW_TICKS);
    let ringHead = 0;
    let ringSize = 0;
    let endingTick = -1;
    let drowned = false;
    let exploded = false;
    let ticks = 0;

    while (!game.ended && ticks < maxT) {
      game.update();
      ticks += 1;
      const sim = game.sim;
      const blob = sim.blob;
      const wheelIdx = blob.cw ? sim.wheels.indexOf(blob.cw) : -1;
      ring[ringHead] = { t: game.tick, x: blob.x, y: blob.y, w: wheelIdx, st: blob.state };
      ringHead = (ringHead + 1) % STALL_WINDOW_TICKS;
      if (ringSize < STALL_WINDOW_TICKS) ringSize += 1;
      if (sim.events.blobDrowned) drowned = true;
      if (sim.events.blobExploded != null) exploded = true;
      if (endingTick < 0 && game.ending) endingTick = game.tick;
    }

    // Snapshot the ring as a chronological array of the last `ringSize` ticks.
    const window_ = [];
    for (let i = 0; i < ringSize; i += 1) {
      window_.push(ring[(ringHead + i) % STALL_WINDOW_TICKS]);
    }

    // Net height gain: highest y reached in window vs final y (game uses
    // negative y = up; maxHeight on sim already tracks all-time apex).
    // For stall classification we want the LAST WINDOW's net climb, so:
    //   netGainMeters = (windowStartY - finalY) / 5
    let netGainMeters = 0;
    if (window_.length >= 2) {
      const startY = window_[0].y;
      const finalY = window_[window_.length - 1].y;
      netGainMeters = (startY - finalY) / PX_PER_M;
    }
    const stableWheels = new Set();
    for (const sample of window_) {
      // state 2 = GRAB (BLOB_STATE_GRAB)
      if (sample.st === 2 && sample.w >= 0) stableWheels.add(sample.w);
    }

    let classification;
    if (!game.ended) {
      classification = 'surviving';
    } else if (netGainMeters < STALL_NET_GAIN_M && stableWheels.size > 0 && stableWheels.size <= STALL_MAX_WHEELS) {
      classification = 'stall';
    } else if (exploded) {
      classification = 'exploded';
    } else if (drowned) {
      classification = 'drowned';
    } else {
      classification = 'other';
    }

    return {
      seed: s,
      ticks,
      endingTick,
      heightMeters: Math.floor(game.maxHeight * 0.2),
      score: game.score,
      ended: game.ended,
      drowned,
      exploded,
      classification,
      windowNetGainM: Math.round(netGainMeters * 10) / 10,
      windowStableWheels: [...stableWheels],
      windowDistinctWheels: stableWheels.size,
    };
  }, { s: seed, preset, maxT: maxTicks, STALL_WINDOW_TICKS, STALL_NET_GAIN_M, STALL_MAX_WHEELS });
}

async function buildCorpus(args) {
  const repoRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const maxTicks = Math.round(args.maxSeconds * GAME_FPS);

  const vite = await createServer({
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const port = vite.httpServer.address().port;

  const browser = await chromium.launch({ headless: !args.headed });
  const records = [];
  try {
    const ctx = await browser.newContext({
      viewport: { width: STAGE_SIZE, height: STAGE_SIZE },
      deviceScaleFactor: 1,
    });
    await ctx.addInitScript(devicePixelRatioSource(1));
    const page = await ctx.newPage();
    page.on('pageerror', (err) => { throw err; });
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('console error:', msg.text());
    });
    const url = new URL(`http://127.0.0.1:${port}/playground.html`);
    url.searchParams.set('hud', 'off');
    url.searchParams.set('canvasHud', 'off');
    await page.goto(url.href);
    await page.waitForFunction(() => Boolean(window.__game__ && window.__planner__), null, { timeout: 30_000 });
    await setupVideoPresetPage(page);

    const t0 = Date.now();
    for (let i = 0; i < args.count; i += 1) {
      const seed = args.seedBase + i;
      const rec = await runSeed(page, seed, args.preset, maxTicks);
      records.push(rec);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const tagFlag = rec.classification === 'stall' ? '★' : ' ';
      process.stdout.write(
        `\r [${i + 1}/${args.count}] ${elapsed}s  seed=${rec.seed} ` +
        `${tagFlag}${rec.classification.padEnd(9)} ` +
        `h=${String(rec.heightMeters).padStart(4)}m  ` +
        `netGain=${String(rec.windowNetGainM).padStart(5)}m  wheels=${rec.windowDistinctWheels}    `,
      );
    }
    process.stdout.write('\n');
  } finally {
    await browser.close().catch(() => {});
    await vite.close().catch(() => {});
  }

  return { records, repoRoot };
}

function summarize(records) {
  const counts = {};
  let heightSum = 0, heightP10 = null, heightP50 = null;
  for (const r of records) {
    counts[r.classification] = (counts[r.classification] ?? 0) + 1;
    heightSum += r.heightMeters;
  }
  const sorted = records.map((r) => r.heightMeters).sort((a, b) => a - b);
  if (sorted.length > 0) {
    heightP10 = sorted[Math.floor(sorted.length * 0.1)];
    heightP50 = sorted[Math.floor(sorted.length * 0.5)];
  }
  return {
    n: records.length,
    counts,
    stallRate: (counts.stall ?? 0) / records.length,
    heightMean: heightSum / records.length,
    heightP10,
    heightP50,
  };
}

function printSummary(label, summary) {
  console.log(`\n=== ${label} ===`);
  console.log(`  n=${summary.n}`);
  console.log(`  classifications:`, summary.counts);
  console.log(`  stallRate: ${(summary.stallRate * 100).toFixed(1)}%`);
  console.log(`  height (m): mean=${summary.heightMean.toFixed(0)}  p10=${summary.heightP10}  p50=${summary.heightP50}`);
}

function compareCorpus(baseline, candidate) {
  const baseBySeed = new Map(baseline.records.map((r) => [r.seed, r]));
  const candBySeed = new Map(candidate.records.map((r) => [r.seed, r]));
  const transitions = {};
  let heightDeltaSum = 0;
  let heightDeltaCount = 0;
  for (const [seed, b] of baseBySeed) {
    const c = candBySeed.get(seed);
    if (!c) continue;
    const key = `${b.classification}→${c.classification}`;
    transitions[key] = (transitions[key] ?? 0) + 1;
    heightDeltaSum += c.heightMeters - b.heightMeters;
    heightDeltaCount += 1;
  }
  return {
    baselineStallRate: summarize(baseline.records).stallRate,
    candidateStallRate: summarize(candidate.records).stallRate,
    avgHeightDelta: heightDeltaCount > 0 ? heightDeltaSum / heightDeltaCount : 0,
    transitions,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const outDir = path.resolve(repoRoot, args.outDir);

  if (args.compare) {
    // Diff two existing corpora, no fresh scan.
    const tags = args.compare.split('..');
    if (tags.length !== 2) throw new Error('--compare expects baseline..candidate');
    const baseline = JSON.parse(await readFile(path.join(outDir, `${tags[0]}.json`), 'utf8'));
    const candidate = JSON.parse(await readFile(path.join(outDir, `${tags[1]}.json`), 'utf8'));
    printSummary(`baseline ${tags[0]}`, summarize(baseline.records));
    printSummary(`candidate ${tags[1]}`, summarize(candidate.records));
    const cmp = compareCorpus(baseline, candidate);
    console.log(`\n=== diff (${tags[0]} → ${tags[1]}) ===`);
    console.log(`  stall rate: ${(cmp.baselineStallRate * 100).toFixed(1)}% → ${(cmp.candidateStallRate * 100).toFixed(1)}%  (Δ ${((cmp.candidateStallRate - cmp.baselineStallRate) * 100).toFixed(1)} pts)`);
    console.log(`  avg height Δ: ${cmp.avgHeightDelta.toFixed(1)} m`);
    console.log(`  per-seed transitions:`);
    const sorted = Object.entries(cmp.transitions).sort((a, b) => b[1] - a[1]);
    for (const [k, v] of sorted) console.log(`    ${k.padEnd(28)} ${v}`);
    return;
  }

  console.log(`Stall-corpus scan: ${args.count} seeds [${args.seedBase}..${args.seedBase + args.count - 1}], video preset, max=${args.maxSeconds}s`);
  const { records } = await buildCorpus(args);
  const summary = summarize(records);
  printSummary('summary', summary);

  if (args.tag) {
    await mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, `${args.tag}.json`);
    if (existsSync(outPath)) console.warn(`(overwriting existing ${outPath})`);
    await writeFile(outPath, JSON.stringify({ args, summary, records }, null, 2));
    console.log(`\n  written to ${path.relative(repoRoot, outPath)}`);
  }

  // Print the stalled seeds explicitly for the user.
  const stalls = records.filter((r) => r.classification === 'stall').sort((a, b) => a.heightMeters - b.heightMeters);
  if (stalls.length > 0) {
    console.log(`\n=== stalled seeds (${stalls.length}) ===`);
    console.log('  seed    h(m)   netGain(m)  distinctWheels  endingTick');
    for (const r of stalls) {
      console.log(`  ${String(r.seed).padStart(5)}  ${String(r.heightMeters).padStart(4)}    ${String(r.windowNetGainM).padStart(5)}        ${String(r.windowDistinctWheels).padStart(2)}             ${r.endingTick}`);
    }
  }
}

main().catch((err) => {
  console.error('stall-corpus failed:', err);
  process.exit(1);
});
