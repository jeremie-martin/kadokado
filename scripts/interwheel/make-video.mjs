#!/usr/bin/env node
// Probe seeds with the "video" scene preset, then render the run that dies in
// a target time window at one or more asset scales. The probe and the render
// share the same browser page; the probe just stops the Pixi ticker and steps
// game.update() in a tight loop. The render restores the same seed and steps
// frame-by-frame, copying each canvas frame into a centered output canvas and
// piping raw RGBA into ffmpeg.
//
// Usage:
//   npm run video:interwheel
//   npm run video:interwheel -- --seed-base=4200 --max-seconds=60 --presets=x1,x2

import { mkdir, symlink, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const GAME_FPS = 40;
const STAGE_SIZE = 300;
const DEFAULT_OUT_DIR = '.tmp/captures/video';
const DEFAULT_MIN_SECONDS = 30;
const DEFAULT_MAX_SECONDS = 54;
const DEFAULT_TAIL_SECONDS = 2;
const DEFAULT_MAX_PROBES = 50;
const DEFAULT_PROBE_TIMEOUT_SECONDS = 5 * 60;
const DEFAULT_FPS = 40;

// Asset roots are URL paths served by Vite from `public/assets/`. The x2/x4
// variant trees live in `generated-assets/interwheel-upscale/` (gitignored,
// produced by the upscale Python scripts), so we symlink them under
// `public/assets/` on demand. ensureAssetMounts() below sets that up.
const ASSET_TARGETS = {
  x1: { label: 'x1', root: '/assets/interwheel', scale: 1 },
  x2: { label: 'x2', root: '/assets/interwheel-2x/waifu2x-cunet-n1', scale: 2 },
  x4: { label: 'x4', root: '/assets/interwheel-4x/animejanai-v3-compact-x2x2', scale: 4 },
};

const ASSET_MOUNTS = [
  {
    presetKey: 'x2',
    publicDir: 'public/assets/interwheel-2x',
    sourceDir: 'generated-assets/interwheel-upscale/interwheel-2x',
  },
  {
    presetKey: 'x4',
    publicDir: 'public/assets/interwheel-4x',
    sourceDir: 'generated-assets/interwheel-upscale/interwheel-4x',
  },
];

async function ensureAssetMounts(repoRoot, presetKeys) {
  for (const mount of ASSET_MOUNTS) {
    if (!presetKeys.includes(mount.presetKey)) continue;
    const publicPath = path.resolve(repoRoot, mount.publicDir);
    const sourcePath = path.resolve(repoRoot, mount.sourceDir);
    let publicStat = null;
    try { publicStat = await lstat(publicPath); } catch { /* missing */ }
    if (publicStat) continue;
    let sourceStat = null;
    try { sourceStat = await lstat(sourcePath); } catch { /* missing */ }
    if (!sourceStat) {
      throw new Error(
        `Preset ${mount.presetKey} needs ${mount.sourceDir} on disk; run scripts/upscale-interwheel-2x.py first.`,
      );
    }
    const rel = path.relative(path.dirname(publicPath), sourcePath);
    await symlink(rel, publicPath);
    console.log(`Linked ${mount.publicDir} → ${rel}`);
  }
}

function parseArgs(argv) {
  const args = {
    seedBase: 4200,
    maxProbes: DEFAULT_MAX_PROBES,
    minSeconds: DEFAULT_MIN_SECONDS,
    maxSeconds: DEFAULT_MAX_SECONDS,
    tailSeconds: DEFAULT_TAIL_SECONDS,
    probeTimeoutSeconds: DEFAULT_PROBE_TIMEOUT_SECONDS,
    outDir: DEFAULT_OUT_DIR,
    fps: DEFAULT_FPS,
    // null = use each preset's asset-native size (300 for x1, 600 for x2,
    // 1200 for x4). Pass --output-side=N to override for all presets.
    outputSide: null,
    presets: ['x1', 'x2'],
    headed: false,
    // Quick mode: skip the death-time probe and capture exactly N seconds
    // from `--seed-base` for each preset. Output mp4s get a `-quickNs` tag so
    // they don't clobber a real probe-and-render capture for the same seed.
    quickSeconds: null,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--headed') args.headed = true;
    else if (raw.startsWith('--seed-base=')) args.seedBase = Number(raw.slice('--seed-base='.length));
    else if (raw.startsWith('--max-probes=')) args.maxProbes = Number(raw.slice('--max-probes='.length));
    else if (raw.startsWith('--min-seconds=')) args.minSeconds = Number(raw.slice('--min-seconds='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--tail-seconds=')) args.tailSeconds = Number(raw.slice('--tail-seconds='.length));
    else if (raw.startsWith('--probe-timeout-seconds=')) args.probeTimeoutSeconds = Number(raw.slice('--probe-timeout-seconds='.length));
    else if (raw.startsWith('--out-dir=')) args.outDir = raw.slice('--out-dir='.length);
    else if (raw.startsWith('--fps=')) args.fps = Number(raw.slice('--fps='.length));
    else if (raw.startsWith('--output-side=')) {
      const v = raw.slice('--output-side='.length);
      args.outputSide = v === 'native' ? null : Number(v);
    }
    else if (raw.startsWith('--presets=')) args.presets = raw.slice('--presets='.length).split(',').map((s) => s.trim()).filter(Boolean);
    else if (raw.startsWith('--quick-seconds=')) args.quickSeconds = Number(raw.slice('--quick-seconds='.length));
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  for (const k of ['seedBase', 'maxProbes', 'minSeconds', 'maxSeconds', 'tailSeconds', 'probeTimeoutSeconds', 'fps']) {
    if (!Number.isFinite(args[k])) {
      console.error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be a number`);
      args.help = true;
    }
  }
  if (args.outputSide !== null && !Number.isFinite(args.outputSide)) {
    console.error('--output-side must be a number, or "native"');
    args.help = true;
  }
  if (args.minSeconds > args.maxSeconds) {
    console.error('--min-seconds must be <= --max-seconds');
    args.help = true;
  }
  if (args.quickSeconds !== null && (!Number.isFinite(args.quickSeconds) || args.quickSeconds <= 0)) {
    console.error('--quick-seconds must be a positive number');
    args.help = true;
  }
  for (const p of args.presets) {
    if (!(p in ASSET_TARGETS)) {
      console.error(`Unknown preset "${p}". Available: ${Object.keys(ASSET_TARGETS).join(', ')}`);
      args.help = true;
    }
  }
  if (args.outputSide !== null && args.outputSide < STAGE_SIZE) {
    console.error(`--output-side must be >= ${STAGE_SIZE}`);
    args.help = true;
  }
  return args;
}

function help() {
  console.log(`Interwheel video maker

USAGE:
  npm run video:interwheel
  npm run video:interwheel -- --seed-base=4200 --presets=x1,x2

OPTIONS:
  --seed-base=N             First seed to probe. Default 4200.
  --max-probes=N            How many seeds to try before giving up. Default ${DEFAULT_MAX_PROBES}.
  --min-seconds=N           Reject seeds that die before this many seconds. Default ${DEFAULT_MIN_SECONDS}.
  --max-seconds=N           Reject seeds that survive past this many seconds. Default ${DEFAULT_MAX_SECONDS}.
  --tail-seconds=N          Extra seconds to record after death. Default ${DEFAULT_TAIL_SECONDS}.
  --probe-timeout-seconds=N Hard cap per probe. Default ${DEFAULT_PROBE_TIMEOUT_SECONDS}.
  --presets=x1,x2           Comma-separated asset presets to render.
  --output-side=N|native    Output canvas side in pixels. Default "native" — each preset
                            renders at its asset-native size (x1=${STAGE_SIZE}, x2=${STAGE_SIZE * 2}, x4=${STAGE_SIZE * 4})
                            so each texture pixel maps to exactly one canvas pixel. Pass an explicit
                            number to force one size for all presets.
  --fps=N                   Recording frame rate. Default ${DEFAULT_FPS}.
  --out-dir=PATH            Output directory. Default ${DEFAULT_OUT_DIR}.
  --quick-seconds=N         Skip the death probe and capture exactly N seconds from
                            --seed-base. Output names get a -quickNs tag so they don't
                            clobber a real capture. Use this for fast color/encoding
                            iteration, not for finished shorts.
  --headed                  Show Chromium while running.

The probe applies the playground's "video" scene preset, then steps the
game without rendering until it dies. The renderer reuses the same seed
and the same preset to capture frames from tick 0 to (death tick + tail).
`);
}

function seededRandomSource(seed) {
  return `
    (() => {
      let s = ${seed >>> 0};
      Math.random = () => {
        s = (s + 0x6d2b79f5) | 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    })();
  `;
}

function devicePixelRatioSource(scale) {
  return `
    (() => {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        get: () => ${scale},
      });
    })();
  `;
}

function writeStream(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (err) => { cleanup(); reject(err); };
    const onDrain = () => { cleanup(); resolve(); };
    const cleanup = () => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
    };
    stream.on('error', onError);
    if (stream.write(chunk)) { cleanup(); resolve(); }
    else stream.on('drain', onDrain);
  });
}

function startRawVideoEncoder(opts, outPath) {
  // Lossless H.264 mp4: -qp 0 makes the encoder reconstruct the source pixels
  // exactly. yuv444p preserves chroma without subsampling — sprite art with
  // saturated colors and sharp edges needs this. -preset veryfast keeps the
  // encode wall-clock close to the rendering loop's pace; lossless mode means
  // the preset only affects compression ratio, not visual quality.
  //
  // Color: tag + convert as BT.709 limited range to match Remotion's output
  // path (remotion/remotion.config.ts sets colorSpace='bt709'). Without the
  // tag, ffmpeg defaults to BT.601 conversion AND Chromium decodes the
  // resulting untagged HD H.264 as BT.709 by heuristic — those two assumptions
  // disagree, desaturating greens and pushing reds toward orange in the final
  // short. The explicit zscale forces ffmpeg's RGB→YUV conversion to use the
  // same matrix the VUI tags advertise, so any decoder reads back the colors
  // we put in.
  const child = spawn('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-f', 'rawvideo',
    '-pix_fmt', 'rgba',
    '-s:v', `${opts.width}x${opts.height}`,
    '-r', String(opts.fps),
    '-i', 'pipe:0',
    '-an',
    '-vf', 'zscale=matrix=709:matrixin=709:range=limited',
    '-c:v', 'libx264',
    '-qp', '0',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv444p',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-color_range', 'tv',
    outPath,
  ], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}\n${stderr}`));
    });
  });
  return { child, closed };
}

async function probeSeed(page, seed, maxTicks) {
  // Single page.evaluate so applyScene/reseed/loop run with no inter-eval
  // boundaries — keeps Math.random consumption identical to the render path
  // (where setupFrameCanvas + reseedRandomFresh + first stepFrame is the
  // equivalent boundary).
  return await page.evaluate(({ s, maxT }) => {
    const game = window.__game__;
    if (!game?.app) throw new Error('Interwheel game is not ready');
    game.app.ticker.stop();
    // Apply video scene + seed via the live UI controls (button click
    // fires applyScenePreset; reseed click fires the wrapped reset).
    const presetBtn = document.getElementById('scene-preset-video');
    if (!presetBtn) throw new Error('scene-preset-video button missing');
    presetBtn.click();
    const seedInput = document.getElementById('game-seed');
    if (!seedInput) throw new Error('game-seed input missing');
    seedInput.value = String(s);
    seedInput.dispatchEvent(new Event('change', { bubbles: true }));
    const reseedBtn = document.getElementById('game-reseed');
    if (!reseedBtn) throw new Error('game-reseed button missing');
    reseedBtn.click();
    // Reseed Math.random AFTER the wrapped-reset's own seed/save/restore so
    // every subsequent game.update consumes from a known fresh stream.
    let rs = (s | 0) >>> 0;
    Math.random = () => {
      rs = (rs + 0x6d2b79f5) | 0;
      let t = rs;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let ticks = 0;
    let endingTick = -1;
    while (!game.ended && ticks < maxT) {
      game.update();
      ticks += 1;
      if (endingTick < 0 && game.ending) endingTick = ticks;
    }
    return {
      ticks,
      endingTick,
      ended: game.ended,
      heightMeters: Math.floor(game.maxHeight * 0.2),
      score: game.score,
    };
  }, { s: seed, maxT: maxTicks });
}

async function setupRenderRun(page, opts, seed) {
  await page.evaluate((init) => {
    const game = window.__game__;
    if (!game?.app?.canvas) throw new Error('Interwheel game canvas is not ready');
    game.app.ticker.stop();
    // Apply video scene + seed.
    const presetBtn = document.getElementById('scene-preset-video');
    if (!presetBtn) throw new Error('scene-preset-video button missing');
    presetBtn.click();
    const seedInput = document.getElementById('game-seed');
    if (!seedInput) throw new Error('game-seed input missing');
    seedInput.value = String(init.seed);
    seedInput.dispatchEvent(new Event('change', { bubbles: true }));
    const reseedBtn = document.getElementById('game-reseed');
    if (!reseedBtn) throw new Error('game-reseed button missing');
    reseedBtn.click();
    // Set up the recording canvas centered over the game canvas.
    const source = game.app.canvas;
    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (sourceWidth !== init.height || sourceHeight !== init.height) {
      throw new Error(
        `Expected a ${init.height}x${init.height} source canvas, got ` +
          `${sourceWidth}x${sourceHeight}. Check devicePixelRatio override.`,
      );
    }
    const canvas = document.createElement('canvas');
    canvas.id = 'recording-canvas';
    canvas.width = init.width;
    canvas.height = init.height;
    canvas.style.cssText = 'display:block;width:' + init.width + 'px;height:' + init.height + 'px;position:fixed;left:0;top:0;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D recording canvas is unavailable');
    ctx.imageSmoothingEnabled = false;
    const dx = Math.floor((init.width - sourceWidth) / 2);
    const dy = Math.floor((init.height - sourceHeight) / 2);
    const renderStage = () => game.app.renderer.render({ container: game.app.stage });
    const draw = () => {
      renderStage();
      ctx.fillStyle = init.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, dx, dy, sourceWidth, sourceHeight);
    };
    // Intentionally NO initial draw() here. We need the first game.update
    // (called inside the first stepFrame) to consume Math.random with the
    // exact same starting state as the probe's first game.update; running
    // a Pixi render before that would leave a small amount of (possibly
    // RNG-consuming) browser activity between Math.random reseed and the
    // first sim.step. The probe path has nothing equivalent.
    ctx.fillStyle = init.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const seed = init.seed;
    let isFirstFrame = true;
    // Captured per real game tick, then read by the hook. The playground
    // wraps game.update to also run the planner, whose sim.step() speculation
    // would otherwise stomp sim.events. We snapshot at the FIRST sim.step
    // after each game.update — that's the real tick.
    let lastRealEvents = null;
    const STATE_NAME = { 1: 'FLY', 2: 'GRAB', 3: 'WALL', 4: 'DEAD' };
    window.__captureInterwheelStepFrame = () => {
      if (isFirstFrame) {
        isFirstFrame = false;
        let rs = (seed | 0) >>> 0;
        Math.random = () => {
          rs = (rs + 0x6d2b79f5) | 0;
          let t = rs;
          t = Math.imul(t ^ (t >>> 15), t | 1);
          t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        // Wrap sim.step + game.update so the first sim.step inside each
        // game.update snapshots the real events before planner speculation.
        const realSimStep = game.sim.step.bind(game.sim);
        let captureNext = false;
        game.sim.step = function (...args) {
          const result = realSimStep(...args);
          if (captureNext) {
            captureNext = false;
            const ev = game.sim.events;
            lastRealEvents = {
              jumpAngle: ev.blobJumpAngle,
              drowned: ev.blobDrowned,
              exploded: ev.blobExploded != null,
              endingStarted: ev.endingStarted,
              runFinished: ev.runFinished,
              sparkScore: ev.collectedSparks.reduce((s, sp) => s + sp.score, 0),
              pastilleCount: ev.collectedPastilles.length,
            };
          }
          return result;
        };
        const realGameUpdate = game.update.bind(game);
        game.update = function () {
          captureNext = true;
          return realGameUpdate();
        };
      }
      game.update();
      draw();
      const sim = game.sim;
      const blob = sim.blob;
      const sidecar = {
        tick: game.tick,
        t: game.tick / 40,
        score: sim.score,
        maxHeight: sim.maxHeight,
        heightM: Math.floor(sim.maxHeight * 0.2),
        waterY: sim.waterY,
        blob: {
          x: blob.x, y: blob.y, vx: blob.vx, vy: blob.vy,
          state: STATE_NAME[blob.state] ?? 'UNKNOWN',
          wallSide: blob.wallSide,
        },
        events: lastRealEvents ?? {
          jumpAngle: null, drowned: false, exploded: false,
          endingStarted: false, runFinished: false,
          sparkScore: 0, pastilleCount: 0,
        },
      };
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      return {
        pixels,
        tick: game.tick,
        ended: game.ended,
        ending: game.ending,
        heightMeters: Math.floor(game.maxHeight * 0.2),
        score: game.score,
        sidecar,
      };
    };
    window.__captureInterwheelMeta = {
      width: canvas.width,
      height: canvas.height,
      sourceWidth,
      sourceHeight,
      gameX: dx,
      gameY: dy,
      assetRoot: game.assetRoot,
      assetScale: game.assetScale,
    };
  }, { ...opts, seed });
  return await page.evaluate(() => window.__captureInterwheelMeta);
}

async function captureRunFrames(page, opts, outPath, seed, tailFrames, hardCapFrames) {
  const expectedBytes = opts.width * opts.height * 4;
  const meta = await setupRenderRun(page, opts, seed);
  const { child, closed } = startRawVideoEncoder(opts, outPath);
  const sidecarPath = outPath.replace(/\.mp4$/, '.ndjson');
  const sidecarLines = [];
  let lastFrame = { tick: 0, score: 0, heightMeters: 0, ending: false, ended: false };
  let endingFirstFrame = -1;
  let frameCount = 0;
  try {
    for (let i = 0; i < hardCapFrames; i += 1) {
      const frame = await page.evaluate(() => window.__captureInterwheelStepFrame());
      if (frame.pixels.length !== expectedBytes) {
        throw new Error(`Raw frame has ${frame.pixels.length} bytes, expected ${expectedBytes}`);
      }
      const pixels = Buffer.from(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
      await writeStream(child.stdin, pixels);
      sidecarLines.push(JSON.stringify(frame.sidecar));
      lastFrame = {
        tick: frame.tick,
        score: frame.score,
        heightMeters: frame.heightMeters,
        ending: frame.ending,
        ended: frame.ended,
      };
      frameCount = i + 1;
      if (endingFirstFrame < 0 && frame.ending) endingFirstFrame = frameCount;
      // tailFrames=0 means the caller wants exactly hardCapFrames (quick mode);
      // skip the adaptive-on-death termination in that case.
      if (tailFrames > 0 && endingFirstFrame > 0 && frameCount - endingFirstFrame >= tailFrames) break;
      if (frameCount % opts.fps === 0) {
        process.stdout.write(`\r  frames: ${frameCount} (${(frameCount / opts.fps).toFixed(1)}s${endingFirstFrame > 0 ? `, dying since frame ${endingFirstFrame}` : ''})     `);
      }
    }
    process.stdout.write(`\r  frames: ${frameCount} done                                                  \n`);
  } catch (err) {
    child.stdin.destroy();
    child.kill('SIGTERM');
    throw err;
  }
  child.stdin.end();
  await closed;
  await writeFile(sidecarPath, sidecarLines.join('\n') + '\n');
  return { ...meta, frameCount, lastFrame, endingFirstFrame, sidecarPath };
}

async function renderRun(repoRoot, port, args, target, seed, tailFrames, hardCapFrames, outName) {
  // Native size: one canvas pixel per asset pixel. Override with --output-side=N.
  const outputSide = args.outputSide ?? STAGE_SIZE * target.scale;
  const url = new URL(`http://127.0.0.1:${port}/playground.html`);
  url.searchParams.set('assetRoot', target.root);
  url.searchParams.set('assetScale', String(target.scale));
  url.searchParams.set('hud', 'off');
  url.searchParams.set('canvasHud', 'off');

  const browser = await chromium.launch({ headless: !args.headed });
  try {
    const context = await browser.newContext({
      acceptDownloads: false,
      deviceScaleFactor: 1,
      viewport: { width: outputSide, height: outputSide },
    });
    const stageScale = outputSide / STAGE_SIZE;
    await context.addInitScript(devicePixelRatioSource(stageScale));
    await context.addInitScript(seededRandomSource(seed));
    const page = await context.newPage();
    page.on('pageerror', (err) => { throw err; });
    page.on('console', (msg) => {
      if (msg.type() === 'error') console.error('console error:', msg.text());
    });
    await page.goto(url.href);
    await page.waitForFunction(() => Boolean(window.__game__), null, { timeout: 30_000 });

    const outPath = path.resolve(repoRoot, args.outDir, outName);
    await mkdir(path.dirname(outPath), { recursive: true });

    console.log(`Rendering ${target.label} at ${outputSide}x${outputSide} → ${path.relative(repoRoot, outPath)} (cap ${hardCapFrames} frames, tail ${tailFrames} after ending)`);
    const meta = await captureRunFrames(page, {
      width: outputSide,
      height: outputSide,
      fps: args.fps,
      background: '#0e1418',
    }, outPath, seed, tailFrames, hardCapFrames);
    return { outPath, meta };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }

  const repoRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

  await ensureAssetMounts(repoRoot, args.presets);

  const vite = await createServer({
    server: {
      port: 0,
      host: '127.0.0.1',
      watch: { ignored: ['**/generated-assets/**', '**/.tmp/**', '**/dist/**'] },
      fs: { allow: [repoRoot, path.resolve(repoRoot, 'generated-assets')] },
    },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;

  let chosenSeed = null;
  let chosenProbe = null;

  // Quick mode: skip the probe entirely. Used for color/encoding iteration —
  // we don't need a real death, just N seconds of pixels and a sidecar.
  if (args.quickSeconds !== null) {
    chosenSeed = args.seedBase;
    chosenProbe = {
      ticks: Math.round(args.quickSeconds * GAME_FPS),
      endingTick: -1,
      ended: false,
      heightMeters: 0,
      score: 0,
    };
    console.log(
      `Quick mode: skipping probe — capturing ${args.quickSeconds}s from seed ${chosenSeed}.`,
    );
  }

  const probeBrowser = chosenSeed === null
    ? await chromium.launch({ headless: !args.headed })
    : null;
  let probeCtx = null;
  let probePage = null;

  if (probeBrowser) {
    try {
      probeCtx = await probeBrowser.newContext({
        acceptDownloads: false,
        deviceScaleFactor: 1,
        viewport: { width: STAGE_SIZE, height: STAGE_SIZE },
      });
      await probeCtx.addInitScript(devicePixelRatioSource(1));
      const probeUrl = new URL(`http://127.0.0.1:${port}/playground.html`);
      probeUrl.searchParams.set('assetPreset', 'x1');
      probePage = await probeCtx.newPage();
      probePage.on('pageerror', (err) => { throw err; });
      probePage.on('console', (msg) => {
        if (msg.type() === 'error') console.error('probe console error:', msg.text());
      });
      await probePage.goto(probeUrl.href);
      await probePage.waitForFunction(() => Boolean(window.__game__), null, { timeout: 30_000 });

      const probeMaxTicks = Math.max(1, Math.round(args.probeTimeoutSeconds * GAME_FPS));
      const minTicks = Math.round(args.minSeconds * GAME_FPS);
      const maxTicks = Math.round(args.maxSeconds * GAME_FPS);

      console.log(`Probing seeds ${args.seedBase}..${args.seedBase + args.maxProbes - 1} for a death in ${args.minSeconds}–${args.maxSeconds}s (video preset)`);
      for (let i = 0; i < args.maxProbes; i += 1) {
        const seed = args.seedBase + i;
        const probeStart = Date.now();
        const probe = await probeSeed(probePage, seed, probeMaxTicks);
        const elapsed = ((Date.now() - probeStart) / 1000).toFixed(1);
        const deathSec = (probe.endingTick > 0 ? probe.endingTick : probe.ticks) / GAME_FPS;
        const verdict = !probe.ended
          ? 'survived' // hit cap
          : probe.endingTick >= minTicks && probe.endingTick <= maxTicks
            ? 'GREEN'
            : probe.endingTick < minTicks
              ? 'too short'
              : 'too long';
        console.log(`  seed=${seed} death=${deathSec.toFixed(2)}s height=${probe.heightMeters}m ticks=${probe.ticks} (${elapsed}s real, ${verdict})`);
        if (verdict === 'GREEN') {
          chosenSeed = seed;
          chosenProbe = probe;
          break;
        }
      }
    } finally {
      if (probePage) await probePage.close().catch(() => {});
      if (probeCtx) await probeCtx.close().catch(() => {});
      await probeBrowser.close().catch(() => {});
    }
  }

  if (chosenSeed === null) {
    console.error(`No seed in [${args.seedBase}, ${args.seedBase + args.maxProbes - 1}] dies in [${args.minSeconds}, ${args.maxSeconds}]s; widen the range or increase --max-probes.`);
    await vite.close();
    process.exit(1);
  }

  // Quick mode: no death tail, capture exactly quickSeconds. Otherwise: full
  // render uses adaptive termination (death + tail) with a maxSeconds-derived
  // hard cap.
  const isQuick = args.quickSeconds !== null;
  const tailFrames = isQuick ? 0 : Math.round(args.tailSeconds * GAME_FPS);
  const hardCapFrames = isQuick
    ? Math.round(args.quickSeconds * GAME_FPS)
    : Math.round((args.maxSeconds + args.tailSeconds + 10) * GAME_FPS);
  if (isQuick) {
    console.log(`\nQuick capture: seed=${chosenSeed}, ${args.quickSeconds}s = ${hardCapFrames} frames per preset`);
  } else {
    console.log(`\nGreen seed=${chosenSeed} (probe death at tick ${chosenProbe.endingTick}, ${(chosenProbe.endingTick / GAME_FPS).toFixed(2)}s; render uses adaptive termination, ${tailFrames} frame tail, hard cap ${hardCapFrames})`);
  }

  const renders = [];
  try {
    for (const presetKey of args.presets) {
      const target = ASSET_TARGETS[presetKey];
      const tag = isQuick ? `-quick${args.quickSeconds}s` : '';
      const outName = `interwheel-seed${chosenSeed}-${target.label}${tag}.mp4`;
      const meta = await renderRun(repoRoot, port, args, target, chosenSeed, tailFrames, hardCapFrames, outName);
      renders.push({ presetKey, ...meta });
    }
  } finally {
    await vite.close();
  }

  console.log('\n=== Summary ===');
  console.log(`  seed:                ${chosenSeed}`);
  if (!isQuick) {
    console.log(`  probe death:         tick ${chosenProbe.endingTick} (${(chosenProbe.endingTick / GAME_FPS).toFixed(2)}s)`);
    console.log(`  probe height:        ${chosenProbe.heightMeters}m`);
  } else {
    console.log(`  mode:                quick (${args.quickSeconds}s, no probe)`);
  }
  for (const r of renders) {
    const meta = r.meta;
    const lf = meta.lastFrame;
    const renderDeathSec = meta.endingFirstFrame > 0 ? (meta.endingFirstFrame / GAME_FPS).toFixed(2) : '—';
    const driftFrames = meta.endingFirstFrame > 0 && chosenProbe.endingTick > 0
      ? meta.endingFirstFrame - chosenProbe.endingTick
      : null;
    console.log(`  ${r.presetKey} render:`);
    console.log(`    file:              ${path.relative(repoRoot, r.outPath)}`);
    console.log(`    sidecar:           ${path.relative(repoRoot, meta.sidecarPath)}`);
    console.log(`    canvas:            ${meta.width}x${meta.height} (game ${meta.sourceWidth}x${meta.sourceHeight} at ${meta.gameX},${meta.gameY})`);
    console.log(`    assets:            ${meta.assetRoot} @ ${meta.assetScale}x`);
    console.log(`    frames:            ${meta.frameCount} (${(meta.frameCount / GAME_FPS).toFixed(2)}s)`);
    console.log(`    death:             ending frame ${meta.endingFirstFrame} (${renderDeathSec}s) → ended=${lf.ended} at frame ${lf.tick}`);
    console.log(`    height:            ${lf.heightMeters}m`);
    if (driftFrames !== null) {
      const driftMs = (driftFrames / GAME_FPS) * 1000;
      const tag = Math.abs(driftFrames) <= 5 ? 'ok' : Math.abs(driftFrames) <= 40 ? 'small drift' : 'WARNING — large drift';
      console.log(`    probe→render drift:${driftFrames > 0 ? '+' : ''}${driftFrames} frames (${driftMs.toFixed(0)}ms) [${tag}]`);
    }
  }
}

main().catch((err) => {
  console.error('make-video failed:', err);
  process.exit(1);
});
