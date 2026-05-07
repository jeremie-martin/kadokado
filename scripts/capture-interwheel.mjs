#!/usr/bin/env node
// Record the Interwheel AI playground as archival-quality 1080p WebM.
//
// The game itself is a 300x300 Pixi stage. For a blur-free 1080p export we
// override window.devicePixelRatio to 1080/300, making Pixi render a 1080x1080
// backing canvas. The page then copies that canvas 1:1 into the center of a
// 1920x1080 recording canvas. In archival mode, frames are encoded by ffmpeg;
// live mode uses the browser's native MediaRecorder for faster previews.

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

const DEFAULT_WIDTH = 1920;
const DEFAULT_HEIGHT = 1080;
const GAME_STAGE_SIZE = 300;
const DEFAULT_FPS = 40;
const DEFAULT_BITRATE = 25_000_000;
const DEFAULT_CRF = 15;
const DEFAULT_SECONDS = 10;
const DEFAULT_OUT = '.tmp/captures/interwheel-1080p.webm';
const ASSET_PRESETS = {
  x1: { root: '/assets/interwheel', scale: 1 },
  x2: { root: '/assets/interwheel-2x/median-all', scale: 2 },
  x4: { root: '/assets/interwheel-4x/median-all', scale: 4 },
  'x4-aa': { root: '/assets/interwheel-4x-alpha-aa/median-all', scale: 4 },
};

function parseArgs(argv) {
  const args = {
    seconds: DEFAULT_SECONDS,
    seed: null,
    out: DEFAULT_OUT,
    fps: DEFAULT_FPS,
    bitrate: DEFAULT_BITRATE,
    crf: DEFAULT_CRF,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    mode: 'frames',
    assetPreset: 'x1',
    assetRoot: null,
    assetScale: null,
    headed: false,
    help: false,
  };

  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--headed') args.headed = true;
    else if (raw.startsWith('--seconds=')) args.seconds = Number(raw.slice('--seconds='.length));
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--out=')) args.out = raw.slice('--out='.length);
    else if (raw.startsWith('--fps=')) args.fps = Number(raw.slice('--fps='.length));
    else if (raw.startsWith('--bitrate=')) args.bitrate = Number(raw.slice('--bitrate='.length));
    else if (raw.startsWith('--crf=')) args.crf = Number(raw.slice('--crf='.length));
    else if (raw.startsWith('--width=')) args.width = Number(raw.slice('--width='.length));
    else if (raw.startsWith('--height=')) args.height = Number(raw.slice('--height='.length));
    else if (raw.startsWith('--mode=')) args.mode = raw.slice('--mode='.length);
    else if (raw.startsWith('--asset-preset=')) args.assetPreset = raw.slice('--asset-preset='.length);
    else if (raw.startsWith('--asset-root=')) args.assetRoot = raw.slice('--asset-root='.length);
    else if (raw.startsWith('--asset-scale=')) args.assetScale = Number(raw.slice('--asset-scale='.length));
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }

  if (!Number.isFinite(args.seconds) || args.seconds <= 0) {
    console.error('--seconds must be a positive number');
    args.help = true;
  }
  if (args.seed !== null && (!Number.isInteger(args.seed) || args.seed < 0)) {
    console.error('--seed must be a non-negative integer');
    args.help = true;
  }
  for (const key of ['fps', 'bitrate', 'crf', 'width', 'height']) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) {
      console.error(`--${key} must be a positive number`);
      args.help = true;
    }
  }
  if (!['frames', 'live'].includes(args.mode)) {
    console.error('--mode must be either "frames" or "live"');
    args.help = true;
  }
  if (!(args.assetPreset in ASSET_PRESETS)) {
    console.error(`--asset-preset must be one of: ${Object.keys(ASSET_PRESETS).join(', ')}`);
    args.help = true;
  }
  if (args.assetScale !== null && ![1, 2, 4].includes(args.assetScale)) {
    console.error('--asset-scale must be 1, 2, or 4');
    args.help = true;
  }
  if (args.assetRoot !== null && !args.assetRoot.startsWith('/assets/interwheel')) {
    console.error('--asset-root must be an /assets/interwheel path');
    args.help = true;
  }

  return args;
}

function resolveAssets(args) {
  const preset = ASSET_PRESETS[args.assetPreset];
  return {
    root: (args.assetRoot ?? preset.root).replace(/\/+$/, ''),
    scale: args.assetScale ?? preset.scale,
  };
}

function help() {
  console.log(`Interwheel 1080p capture

USAGE:
  npm run capture:interwheel
  npm run capture:interwheel -- --seconds=20 --seed=42
  npm run capture:interwheel -- --out=.tmp/captures/demo.webm

OPTIONS:
  --seconds=N      Capture duration in seconds. Default ${DEFAULT_SECONDS}.
  --seed=N         Seed Math.random before the playground loads.
  --out=PATH       Output WebM path. Default ${DEFAULT_OUT}.
  --fps=N          Recording stream frame rate. Default ${DEFAULT_FPS}.
  --bitrate=N      Video bitrate in bits per second. Default ${DEFAULT_BITRATE}.
  --crf=N          VP9 CRF for frame-sequence encoding. Default ${DEFAULT_CRF}.
  --mode=frames    "frames" for archival output, "live" for MediaRecorder.
  --asset-preset=P Asset set: x1, x2, x4, or x4-aa. Default x1.
  --asset-root=PATH
                  Advanced asset root override under /assets/interwheel.
  --asset-scale=N  Advanced texture resolution override: 1, 2, or 4.
  --headed         Show Chromium while recording.

The output is a 1920x1080 WebM. Interwheel's 1080x1080 render is centered
with no scaling, so the game pixels are not blurred by page or video layout.
x2/x4 presets are opt-in local capture assets; generate them before using
those presets, or keep the default x1 preset.
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

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function recordInPage(page, opts) {
  const downloadPromise = page.waitForEvent('download', {
    timeout: Math.max(30_000, opts.seconds * 1000 + 30_000),
  });

  const metaPromise = page.evaluate(async (recordOpts) => {
    const game = window.__game__;
    if (!game?.app?.canvas) throw new Error('Interwheel game canvas is not ready');

    const source = game.app.canvas;
    const canvas = document.createElement('canvas');
    canvas.width = recordOpts.width;
    canvas.height = recordOpts.height;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D recording canvas is unavailable');
    ctx.imageSmoothingEnabled = false;

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (sourceWidth !== recordOpts.height || sourceHeight !== recordOpts.height) {
      throw new Error(
        `Expected a ${recordOpts.height}x${recordOpts.height} source canvas, got ` +
          `${sourceWidth}x${sourceHeight}. Check devicePixelRatio override.`,
      );
    }
    if (sourceWidth > recordOpts.width || sourceHeight > recordOpts.height) {
      throw new Error(`Source canvas ${sourceWidth}x${sourceHeight} does not fit in output`);
    }

    const dx = Math.floor((recordOpts.width - sourceWidth) / 2);
    const dy = Math.floor((recordOpts.height - sourceHeight) / 2);
    const bg = recordOpts.background;
    let frameCount = 0;
    let raf = 0;
    let active = true;

    const draw = () => {
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, dx, dy, sourceWidth, sourceHeight);
      frameCount += 1;
      if (active) raf = requestAnimationFrame(draw);
    };
    draw();

    const sample = ctx.getImageData(dx, dy, sourceWidth, sourceHeight).data;
    let nonBackgroundSamples = 0;
    for (let i = 0; i < sample.length; i += 64) {
      const r = sample[i];
      const g = sample[i + 1];
      const b = sample[i + 2];
      if (Math.abs(r - 14) + Math.abs(g - 20) + Math.abs(b - 24) > 20) nonBackgroundSamples += 1;
    }
    if (nonBackgroundSamples === 0) throw new Error('Recording canvas appears blank');

    const mimeType = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ].find((candidate) => MediaRecorder.isTypeSupported(candidate));
    if (!mimeType) throw new Error('This browser does not support WebM MediaRecorder output');

    const stream = canvas.captureStream(recordOpts.fps);
    const chunks = [];
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: recordOpts.bitrate,
    });
    const stopped = new Promise((resolve, reject) => {
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      recorder.onerror = () => reject(recorder.error ?? new Error('MediaRecorder failed'));
      recorder.onstop = resolve;
    });

    let blob;
    try {
      recorder.start(1000);
      await new Promise((resolve) => setTimeout(resolve, recordOpts.seconds * 1000));
      recorder.stop();
      await stopped;
      blob = new Blob(chunks, { type: mimeType });
    } finally {
      active = false;
      cancelAnimationFrame(raf);
      for (const track of stream.getTracks()) track.stop();
    }

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'interwheel-1080p.webm';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);

    return {
      mimeType,
      size: blob.size,
      width: canvas.width,
      height: canvas.height,
      fps: recordOpts.fps,
      bitrate: recordOpts.bitrate,
      sourceWidth,
      sourceHeight,
      gameX: dx,
      gameY: dy,
      frameCount,
      nonBackgroundSamples,
      score: game.score,
      heightMeters: Math.floor(game.maxHeight * 0.2),
      tick: game.tick,
      assetRoot: game.assetRoot,
      assetScale: game.assetScale,
    };
  }, opts);

  const [download, meta] = await Promise.all([downloadPromise, metaPromise]);
  return { download, meta };
}

async function setupFrameCapture(page, opts) {
  await page.evaluate(async (recordOpts) => {
    const game = window.__game__;
    if (!game?.app?.canvas) throw new Error('Interwheel game canvas is not ready');

    game.app.ticker.stop();

    const source = game.app.canvas;
    const canvas = document.createElement('canvas');
    canvas.id = 'recording-canvas';
    canvas.width = recordOpts.width;
    canvas.height = recordOpts.height;
    canvas.style.display = 'block';
    canvas.style.width = `${recordOpts.width}px`;
    canvas.style.height = `${recordOpts.height}px`;
    canvas.style.position = 'fixed';
    canvas.style.left = '0';
    canvas.style.top = '0';

    document.documentElement.style.margin = '0';
    document.documentElement.style.padding = '0';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) throw new Error('2D recording canvas is unavailable');
    ctx.imageSmoothingEnabled = false;

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));

    const sourceWidth = source.width;
    const sourceHeight = source.height;
    if (sourceWidth !== recordOpts.height || sourceHeight !== recordOpts.height) {
      throw new Error(
        `Expected a ${recordOpts.height}x${recordOpts.height} source canvas, got ` +
          `${sourceWidth}x${sourceHeight}. Check devicePixelRatio override.`,
      );
    }

    const dx = Math.floor((recordOpts.width - sourceWidth) / 2);
    const dy = Math.floor((recordOpts.height - sourceHeight) / 2);
    const renderStage = () => {
      game.app.renderer.render({ container: game.app.stage });
    };
    const draw = () => {
      renderStage();
      ctx.fillStyle = recordOpts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(source, 0, 0, sourceWidth, sourceHeight, dx, dy, sourceWidth, sourceHeight);
    };
    draw();

    window.__captureInterwheelFrame = () => {
      game.update();
      draw();
      return {
        tick: game.tick,
        score: game.score,
        heightMeters: Math.floor(game.maxHeight * 0.2),
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
  }, opts);

  const handle = await page.$('#recording-canvas');
  if (!handle) throw new Error('Recording canvas was not created');
  const meta = await page.evaluate(() => window.__captureInterwheelMeta);
  return { handle, meta };
}

async function recordFrames(page, opts, outPath) {
  const totalFrames = Math.max(1, Math.round(opts.seconds * opts.fps));
  const frameDir = `${outPath}.frames`;
  await rm(frameDir, { recursive: true, force: true });
  await mkdir(frameDir, { recursive: true });

  const { handle, meta } = await setupFrameCapture(page, opts);
  let lastFrame = { tick: 0, score: 0, heightMeters: 0 };
  for (let i = 0; i < totalFrames; i += 1) {
    lastFrame = await page.evaluate(() => window.__captureInterwheelFrame());
    const framePath = path.join(frameDir, `${String(i + 1).padStart(6, '0')}.png`);
    await handle.screenshot({ path: framePath });
    if ((i + 1) % Math.max(1, opts.fps) === 0 || i + 1 === totalFrames) {
      console.log(`  frames:     ${i + 1}/${totalFrames}`);
    }
  }

  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel', 'error',
    '-framerate', String(opts.fps),
    '-i', path.join(frameDir, '%06d.png'),
    '-c:v', 'libvpx-vp9',
    '-crf', String(opts.crf),
    '-b:v', '0',
    '-row-mt', '1',
    '-pix_fmt', 'yuv420p',
    outPath,
  ]);

  await rm(frameDir, { recursive: true, force: true });
  return {
    ...meta,
    fps: opts.fps,
    crf: opts.crf,
    frameCount: totalFrames,
    tick: lastFrame.tick,
    heightMeters: lastFrame.heightMeters,
    score: lastFrame.score,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    help();
    process.exit(0);
  }

  const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
  const outPath = path.resolve(repoRoot, args.out);
  const assets = resolveAssets(args);
  await mkdir(path.dirname(outPath), { recursive: true });

  const gameScale = args.height / GAME_STAGE_SIZE;
  const vite = await createServer({
    server: { port: 0, host: '127.0.0.1' },
    logLevel: 'silent',
    clearScreen: false,
  });
  await vite.listen();
  const addr = vite.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;
  const url = new URL(`http://127.0.0.1:${port}/playground.html`);
  url.searchParams.set('assetRoot', assets.root);
  url.searchParams.set('assetScale', String(assets.scale));

  const browser = await chromium.launch({ headless: !args.headed });
  let exitCode = 0;
  try {
    const context = await browser.newContext({
      acceptDownloads: true,
      deviceScaleFactor: 1,
      viewport: { width: args.width, height: args.height },
    });
    await context.addInitScript(devicePixelRatioSource(gameScale));
    if (args.seed !== null) await context.addInitScript(seededRandomSource(args.seed));

    const page = await context.newPage();
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

    await page.goto(url.href);
    await page.waitForFunction(() => Boolean(window.__game__), null, { timeout: 30_000 });

    if (args.mode === 'frames') {
      console.log(`Capturing ${Math.round(args.seconds * args.fps)} frames at ${args.width}x${args.height}...`);
      const meta = await recordFrames(page, {
        seconds: args.seconds,
        fps: args.fps,
        crf: args.crf,
        width: args.width,
        height: args.height,
        background: '#0e1418',
      }, outPath);

      console.log('Interwheel capture complete');
      console.log(`  file:       ${path.relative(repoRoot, outPath)}`);
      console.log('  format:     video/webm;codecs=vp9');
      console.log(`  output:     ${meta.width}x${meta.height} @ ${meta.fps}fps`);
      console.log(`  game:       ${meta.sourceWidth}x${meta.sourceHeight} at (${meta.gameX}, ${meta.gameY})`);
      console.log(`  assets:     ${meta.assetRoot} @ ${meta.assetScale}x`);
      console.log(`  quality:    VP9 CRF ${meta.crf}`);
      console.log(`  frames:     ${meta.frameCount}`);
      console.log(`  tick:       ${meta.tick}`);
      console.log(`  height:     ${meta.heightMeters}m`);
      console.log(`  score:      ${meta.score}`);
    } else {
      const { download, meta } = await recordInPage(page, {
        seconds: args.seconds,
        fps: args.fps,
        bitrate: args.bitrate,
        width: args.width,
        height: args.height,
        background: '#0e1418',
      });
      await download.saveAs(outPath);

      console.log('Interwheel capture complete');
      console.log(`  file:       ${path.relative(repoRoot, outPath)}`);
      console.log(`  format:     ${meta.mimeType}`);
      console.log(`  output:     ${meta.width}x${meta.height} @ ${meta.fps}fps`);
      console.log(`  game:       ${meta.sourceWidth}x${meta.sourceHeight} at (${meta.gameX}, ${meta.gameY})`);
      console.log(`  assets:     ${meta.assetRoot} @ ${meta.assetScale}x`);
      console.log(`  bitrate:    ${Math.round(meta.bitrate / 1_000_000)}Mbps target`);
      console.log(`  size:       ${(meta.size / 1_000_000).toFixed(1)}MB`);
      console.log(`  frames:     ${meta.frameCount}`);
      console.log(`  tick:       ${meta.tick}`);
      console.log(`  height:     ${meta.heightMeters}m`);
      console.log(`  score:      ${meta.score}`);
    }
  } catch (err) {
    console.error('Capture failed:', err);
    exitCode = 1;
  } finally {
    await browser.close();
    await vite.close();
  }
  process.exit(exitCode);
}

main();
