#!/usr/bin/env node
// One-shot browser-side probe — same loop as make-video.mjs's probeSeed,
// extracted so we can compare its result to probe-pure.mts (the node-side
// probe) for the same seed. Prints a JSON object on stdout.
//
// Usage:
//   node scripts/interwheel/probe-browser.mjs --seed=4200
//   node scripts/interwheel/probe-browser.mjs --seed=4200 --max-seconds=60

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const GAME_FPS = 40;

function parseArgs(argv) {
  const args = { seed: 4200, maxSeconds: 60, headed: false, hash: 'full' };
  for (const raw of argv.slice(2)) {
    if (raw === '--headed') args.headed = true;
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--hash=')) args.hash = raw.slice('--hash='.length);
    else throw new Error(`Unknown arg: ${raw}`);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

  const vite = await createServer({
    server: {
      port: 0,
      host: '127.0.0.1',
      watch: { ignored: ['**/node_modules/**', '**/.tmp/**', '**/dist/**'] },
    },
    root: repoRoot,
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const port = vite.httpServer.address().port;

  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const ctx = await browser.newContext({ viewport: { width: 300, height: 300 } });
    const page = await ctx.newPage();
    page.on('pageerror', (err) => { throw err; });
    await page.goto(`http://127.0.0.1:${port}/playground.html?canvasHud=off`);
    await page.waitForFunction(() => Boolean(window.__game__), null, { timeout: 30_000 });

    const maxTicks = Math.max(1, Math.round(args.maxSeconds * GAME_FPS));
    const result = await page.evaluate(({ s, maxT, hashMode }) => {
      const game = window.__game__;
      game.app.ticker.stop();
      document.getElementById('scene-preset-video').click();
      const seedInput = document.getElementById('game-seed');
      seedInput.value = String(s);
      seedInput.dispatchEvent(new Event('change', { bubbles: true }));
      document.getElementById('game-reseed').click();
      let rs = (s | 0) >>> 0;
      Math.random = () => {
        rs = (rs + 0x6d2b79f5) | 0;
        let t = rs;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };

      // FNV-1a 32-bit over the same byte stream as probe-pure.mts.
      let h = 0x811c9dc5 >>> 0;
      const buf = new ArrayBuffer(8);
      const f64 = new Float64Array(buf);
      const u32 = new Uint32Array(buf);
      const mix = (x) => {
        for (let i = 0; i < 4; i += 1) {
          h ^= (x >>> (i * 8)) & 0xff;
          h = Math.imul(h, 0x01000193) >>> 0;
        }
      };
      const pushFloat = (v) => { f64[0] = v; mix(u32[0]); mix(u32[1]); };
      let pendingPress = null;

      let ticks = 0;
      let endingTick = -1;
      while (!game.ended && ticks < maxT) {
        const press = !!game.spacePressed;
        game.update();
        ticks += 1;
        if (endingTick < 0 && game.ending) endingTick = ticks;

        if (hashMode === 'full' || (hashMode === 'final' && game.ended)) {
          pushFloat(ticks);
          pushFloat(game.sim.blob.x);
          pushFloat(game.sim.blob.y);
          pushFloat(game.sim.blob.vx);
          pushFloat(game.sim.blob.vy);
          pushFloat(game.sim.blob.state);
          pushFloat(game.sim.waterY);
          pushFloat(game.sim.score);
          pushFloat(press ? 1 : 0);
        }
      }
      const blob = game.sim.blob;
      return {
        ticks,
        endingTick,
        ended: game.ended,
        heightMeters: Math.floor(game.maxHeight * 0.2),
        score: game.score,
        blob: { x: blob.x, y: blob.y, vx: blob.vx, vy: blob.vy, state: blob.state },
        waterY: game.sim.waterY,
        hash: h.toString(16).padStart(8, '0'),
      };
    }, { s: args.seed, maxT: maxTicks, hashMode: args.hash });

    process.stdout.write(JSON.stringify({ seed: args.seed, ...result }) + '\n');
  } finally {
    await browser.close().catch(() => {});
    await vite.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error('probe-browser failed:', err);
  process.exit(1);
});
