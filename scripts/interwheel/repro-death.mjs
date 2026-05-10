#!/usr/bin/env node
// Reproduce a specific seed/preset death in pure simulation (no rendering)
// and dump planner introspection around the death moment so we can see why
// the A* search picked the trajectory it did.
//
// Usage:
//   node scripts/interwheel/repro-death.mjs --seed=31702
//   node scripts/interwheel/repro-death.mjs --seed=31702 --window=80 --preset=video
//
// Output (stdout):
//   - probe summary (death tick, height, score)
//   - per-tick log around death: tick, blob xy/vxvy/state, press, planner.bestScore,
//     candidate count, top-3 candidate apexY + score breakdown
//   - JSON dump at .tmp/repro/death-<seed>.json with the full window

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const STAGE_SIZE = 300;
const GAME_FPS = 40;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 5 * 60;

function parseArgs(argv) {
  const args = {
    seed: 31702,
    preset: 'video',
    window: 80,
    headed: false,
    outDir: '.tmp/repro',
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--headed') args.headed = true;
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length);
    else if (raw.startsWith('--window=')) args.window = Number(raw.slice('--window='.length));
    else if (raw.startsWith('--out-dir=')) args.outDir = raw.slice('--out-dir='.length);
    else throw new Error(`Unknown arg: ${raw}`);
  }
  return args;
}

function devicePixelRatioSource(scale) {
  return `(() => { Object.defineProperty(window, 'devicePixelRatio', { configurable: true, get: () => ${scale} }); })();`;
}

async function reproDeath(page, seed, preset, window_, maxTicks) {
  return await page.evaluate(({ s, preset, window_, maxT }) => {
    const game = window.__game__;
    if (!game?.app) throw new Error('Interwheel game not ready');
    game.app.ticker.stop();

    // Apply preset via UI button (so applySceneOverridesToSim() runs on
    // the next reset, with the same module-level overrides the live
    // playground would use).
    const presetBtn = document.getElementById(`scene-preset-${preset}`);
    if (!presetBtn) throw new Error(`scene-preset-${preset} button missing`);
    presetBtn.click();

    // Set seed + reseed via UI (this triggers attachAI's wrapped reset which
    // applies the scene overrides AND seeds Math.random for the level
    // generation).
    const seedInput = document.getElementById('game-seed');
    seedInput.value = String(s);
    seedInput.dispatchEvent(new Event('change', { bubbles: true }));
    document.getElementById('game-reseed').click();

    // Replace Math.random with a deterministic seeded stream AFTER the
    // wrapped reset has consumed its own seeded stream. Same trick as
    // make-video.mjs's probeSeed.
    let rs = (s | 0) >>> 0;
    Math.random = () => {
      rs = (rs + 0x6d2b79f5) | 0;
      let t = rs;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    const planner = window.__planner__;
    if (!planner) throw new Error('window.__planner__ not exposed');

    const STATE = { 1: 'FLY', 2: 'GRAB', 3: 'WALL', 4: 'DEAD' };

    // Ring buffer of recent ticks so we always have `window_` ticks before
    // the death event, regardless of how long the run lasts.
    const recent = [];
    const pushRecent = (entry) => {
      recent.push(entry);
      if (recent.length > window_ * 4) recent.shift();
    };

    let endingTick = -1;
    let endingDetected = false;
    let postEnd = 0;
    let ticks = 0;

    while (!game.ended && ticks < maxT) {
      // Snapshot the planner state captured during *this* update's planner.step().
      // attachAI calls planAndRecordNextPress() at the END of each game.update(),
      // so planner.lastSegments/lastStats reflects the plan being applied to the
      // NEXT tick. We capture both the press it chose for this tick and the plan
      // for the next tick.
      game.update();
      ticks += 1;

      const sim = game.sim;
      const blob = sim.blob;
      const segments = planner.lastSegments();
      const stats = planner.lastStats();

      // Each Segment is a SAMPLE POINT along an edge's trajectory (many per edge).
      // To get distinct candidate first-jump edges, dedupe by edgeId at gen=1
      // and keep the LAST sample (= edge endpoint).
      const gen1ByEdge = new Map();
      for (const s of segments) {
        if (s.generation !== 1) continue;
        gen1ByEdge.set(s.edgeId, s); // overwrite — keep most recent (terminal) sample
      }
      const firstJumpCandidates = [...gen1ByEdge.values()].map((s) => ({
        edgeId: s.edgeId,
        x1: s.x1,
        y1: s.y1,
        chosen: s.onChosenChain,
      }));
      const chosenChain = segments
        .filter((s) => s.onChosenChain)
        .sort((a, b) => a.depth - b.depth)
        .map((s) => ({ depth: s.depth, gen: s.generation, x0: s.x0, y0: s.y0, x1: s.x1, y1: s.y1 }));

      // Perceived wheels: the planner's perception window is
      //   [viewTop - STAGE_HEIGHT*revealScreensAbove, viewTop + STAGE_HEIGHT].
      // Dump all wheels and tag whether each is in the perception window AND
      // whether it sits ABOVE the viewport (a missed climb target).
      const STAGE_H = 300;
      const reveal = 0; // matches PLANNER_PERCEPTION_DEFAULTS.revealScreensAbove
      const viewTop = -sim.mapY;
      const viewBottom = viewTop + STAGE_H;
      const planTop = viewTop - STAGE_H * reveal;
      const wheels = sim.wheels.map((w, i) => {
        const top = w.y - w.ray;
        const bot = w.y + w.ray;
        const inPlan = bot >= planTop && top <= viewBottom;
        const aboveView = bot < viewTop;
        return {
          i, x: w.x, y: w.y, ray: w.ray, speed: w.speed,
          inPlan, aboveView,
          dyFromBlob: w.y - blob.y, // negative = above blob
        };
      });
      // Keep only the 6 nearest (vertical) wheels to keep the dump compact.
      wheels.sort((a, b) => Math.abs(a.dyFromBlob) - Math.abs(b.dyFromBlob));
      const nearWheels = wheels.slice(0, 8);
      const wheelsAboveOutsidePerception = wheels.filter((w) => w.aboveView && !w.inPlan).slice(0, 6);

      const entry = {
        tick: game.tick,
        x: blob.x,
        y: blob.y,
        vx: blob.vx,
        vy: blob.vy,
        state: STATE[blob.state] ?? '?',
        wallSide: blob.wallSide,
        wheelIdx: blob.wheelIdx ?? -1,
        waterY: sim.waterY,
        heightM: Math.floor(sim.maxHeight * 0.2),
        score: sim.score,
        ended: game.ended,
        ending: game.ending,
        plannerStats: stats ? {
          mode: stats.mode,
          edgesEvaluated: stats.edgesEvaluated,
          stableNodesExpanded: stats.stableNodesExpanded,
          perceivedWheels: stats.perceivedWheels,
          perceivedPastilles: stats.perceivedPastilles,
          segments: stats.segments,
          bestScore: stats.bestScore,
          bestScoreBreakdown: stats.bestScoreBreakdown ? { ...stats.bestScoreBreakdown } : null,
          planMs: stats.planMs,
        } : null,
        firstJumpCandidates,
        chosenChain,
        nearWheels,
        wheelsAboveOutsidePerception,
        viewTop,
        viewBottom,
      };
      pushRecent(entry);

      if (!endingDetected && game.ending) {
        endingDetected = true;
        endingTick = game.tick;
      }
      if (endingDetected) {
        postEnd += 1;
        if (postEnd >= 12) break; // a few ticks of post-mortem context
      }
    }

    // Trim to the death window: from `window_` ticks before the ending tick
    // through `postEnd` ticks after.
    const startTick = Math.max(0, endingTick - window_);
    const death = recent.filter((e) => e.tick >= startTick);

    return {
      seed: s,
      preset,
      ticks,
      ended: game.ended,
      ending: game.ending,
      endingTick,
      heightMeters: Math.floor(game.maxHeight * 0.2),
      score: game.score,
      window: death,
    };
  }, { s: seed, preset, window_, maxT: maxTicks });
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
  const probeMaxTicks = Math.round(DEFAULT_PROBE_TIMEOUT_SECONDS * GAME_FPS);

  const vite = await createServer({
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;

  const browser = await chromium.launch({ headless: !args.headed });
  let result = null;
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

    console.log(`Reproducing seed=${args.seed} preset=${args.preset} (window=${args.window} ticks)`);
    result = await reproDeath(page, args.seed, args.preset, args.window, probeMaxTicks);
  } finally {
    await browser.close().catch(() => {});
    await vite.close().catch(() => {});
  }

  if (!result) throw new Error('repro failed');

  console.log(`\n=== Death summary ===`);
  console.log(`  seed:       ${result.seed} (preset=${result.preset})`);
  console.log(`  total ticks ${result.ticks}`);
  console.log(`  endingTick: ${result.endingTick} (${(result.endingTick / GAME_FPS).toFixed(2)}s)`);
  console.log(`  height:     ${result.heightMeters}m   score: ${result.score}`);
  console.log(`  ended=${result.ended}  ending=${result.ending}`);

  const outDir = path.resolve(repoRoot, args.outDir);
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `death-seed${result.seed}-${result.preset}.json`);
  await writeFile(outPath, JSON.stringify(result, null, 2));
  console.log(`\n  full window written to ${path.relative(repoRoot, outPath)}`);

  // Compact per-tick console table for the LAST 30 ticks before death.
  const tail = result.window.slice(-Math.min(30, result.window.length));
  console.log(`\n=== Last ${tail.length} ticks before death ===`);
  console.log('tick   t(s)  state    x       y      vy   h(m) end  best     edges  perceivedW  chosenChainEndY  1stJumpDy min/med/max (nEdges)');
  for (const e of tail) {
    const t = (e.tick / GAME_FPS).toFixed(2);
    const bs = e.plannerStats?.bestScore?.toFixed(0) ?? '—';
    const ed = e.plannerStats ? `${e.plannerStats.edgesEvaluated}` : '—';
    const pw = e.plannerStats?.perceivedWheels ?? '—';
    const chainEnd = e.chosenChain && e.chosenChain.length
      ? e.chosenChain[e.chosenChain.length - 1].y1.toFixed(0)
      : '—';
    const dys = (e.firstJumpCandidates ?? []).map((c) => c.y1 - e.y).sort((a, b) => a - b);
    const dyStr = dys.length
      ? `${dys[0].toFixed(0)}/${dys[Math.floor(dys.length / 2)].toFixed(0)}/${dys[dys.length - 1].toFixed(0)} (n=${dys.length})`
      : '—';
    console.log(
      `${String(e.tick).padStart(4)}  ${t.padStart(5)}  ${e.state.padEnd(4)} ${e.x.toFixed(1).padStart(6)} ${e.y.toFixed(1).padStart(7)} ${e.vy.toFixed(2).padStart(6)}  ${String(e.heightM).padStart(4)}  ${(e.ending || e.ended) ? '!!' : '  '} ${String(bs).padStart(7)} ${String(ed).padStart(5)}     ${String(pw).padStart(3)}        ${chainEnd.padStart(7)}    ${dyStr}`
    );
  }

  // === PERCEPTION SNAPSHOT at the LAST live planner tick (just before death) ===
  const lastLive = [...result.window].reverse().find((e) => e.plannerStats && e.plannerStats.edgesEvaluated > 0);
  if (lastLive) {
    console.log(`\n=== Perception at tick ${lastLive.tick} (last live plan) ===`);
    console.log(`  blob (x,y) = (${lastLive.x.toFixed(1)}, ${lastLive.y.toFixed(1)})  state=${lastLive.state}`);
    console.log(`  viewport y: [${lastLive.viewTop.toFixed(0)}, ${lastLive.viewBottom.toFixed(0)}]  (height = 300 px = 60m)`);
    console.log(`  planner perception window y: [${lastLive.viewTop.toFixed(0)}, ${lastLive.viewBottom.toFixed(0)}]  (revealScreensAbove=0 → ZERO lookahead above viewport)`);
    console.log(`  perceived wheels: ${lastLive.plannerStats.perceivedWheels}`);
    console.log(`  best chain endY = ${lastLive.chosenChain.at(-1)?.y1.toFixed(0)}  vs current y=${lastLive.y.toFixed(0)}  → net climb = ${(lastLive.chosenChain.at(-1)?.y1 - lastLive.y).toFixed(1)} px (${((lastLive.chosenChain.at(-1)?.y1 - lastLive.y) / 5).toFixed(1)} m)`);
    console.log(`  best score: ${lastLive.plannerStats.bestScore.toFixed(1)}`);
    console.log(`  best score breakdown: ${JSON.stringify(lastLive.plannerStats.bestScoreBreakdown)}`);
    console.log(`\n  nearby wheels (sorted by |dy from blob|):`);
    console.log(`    idx     x      y     ray  speed  dy(px)  dy(m)  inPerception?  aboveView?`);
    for (const w of lastLive.nearWheels) {
      console.log(
        `    ${String(w.i).padStart(3)}  ${w.x.toFixed(1).padStart(6)} ${w.y.toFixed(0).padStart(7)} ${w.ray.toFixed(1).padStart(5)} ${w.speed.toFixed(2).padStart(6)}  ${w.dyFromBlob.toFixed(0).padStart(6)}  ${(w.dyFromBlob / 5).toFixed(1).padStart(6)}    ${w.inPlan ? 'YES' : 'NO '}            ${w.aboveView ? 'YES' : 'no '}`
      );
    }
    if (lastLive.wheelsAboveOutsidePerception.length) {
      console.log(`\n  wheels ABOVE viewport that planner CANNOT see (next climb targets):`);
      for (const w of lastLive.wheelsAboveOutsidePerception) {
        console.log(`    idx ${w.i}  y=${w.y.toFixed(0)}  ray=${w.ray.toFixed(1)}  ${(w.dyFromBlob / 5).toFixed(1)}m above blob`);
      }
    } else {
      console.log(`\n  (no wheels above viewport outside perception)`);
    }
    console.log(`\n  first-jump candidate edges (deduped): ${lastLive.firstJumpCandidates.length}`);
    const upCands = lastLive.firstJumpCandidates.filter((c) => c.y1 < lastLive.y);
    console.log(`    of which y1 < blob.y (climbing): ${upCands.length}`);
    const bestUp = upCands.sort((a, b) => a.y1 - b.y1)[0];
    if (bestUp) console.log(`    best upward candidate: y1=${bestUp.y1.toFixed(1)} (dy=${(bestUp.y1 - lastLive.y).toFixed(1)} px = ${((bestUp.y1 - lastLive.y) / 5).toFixed(1)}m up)  chosen=${bestUp.chosen}`);
  }

  // Quick diagnostic: detect back-and-forth jump pattern in the death window.
  // Heuristic: count distinct wheel indices visited during GRAB states in
  // the last ~40 ticks; if it's exactly 2 and they alternate, that's the
  // back-and-forth pattern.
  const grabs = result.window.filter((e) => e.state === 'GRAB' && e.wheelIdx >= 0);
  const wheelSeq = [];
  for (const e of grabs) {
    if (wheelSeq.length === 0 || wheelSeq[wheelSeq.length - 1] !== e.wheelIdx) {
      wheelSeq.push(e.wheelIdx);
    }
  }
  console.log(`\n=== Back-and-forth detector ===`);
  console.log(`  GRAB-wheel sequence in window: [${wheelSeq.join(' → ')}]`);
  const uniq = [...new Set(wheelSeq)];
  console.log(`  distinct wheels: ${uniq.length} (${uniq.join(', ')})`);
  if (uniq.length === 2 && wheelSeq.length >= 3) {
    let alt = true;
    for (let i = 2; i < wheelSeq.length; i++) {
      if (wheelSeq[i] !== wheelSeq[i - 2]) { alt = false; break; }
    }
    console.log(`  alternating? ${alt ? 'YES — back-and-forth death confirmed' : 'no'}`);
  }
}

main().catch((err) => {
  console.error('repro-death failed:', err);
  process.exit(1);
});
