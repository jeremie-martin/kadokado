#!/usr/bin/env node
// Experiment harness for the WASTED green-screen removal algorithm.
//
// What it does
// ------------
// Iterating on the chromakey/screen-subtract algorithm in compose-short.mjs is
// painful because every change requires a full make-video → remotion render →
// ffmpeg post-step round trip (minutes). This script skips all of that:
//   1) Generate (or accept) a colorful 1080x1920 background — by default a
//      6-second moving rainbow + sliding squares so we can clearly see what
//      shows through the overlay.
//   2) Take the WASTED greenscreen overlay (or any greenscreen mp4).
//   3) Composite it onto the background with one of several algorithms.
//   4) Write the result mp4 plus a side-by-side comparison strip.
//
// Algorithms
// ----------
//   chromakey-current  — exactly what compose-short.mjs ships today (chromakey +
//                        despill + alphaCap=0.78). For baseline comparison.
//   chromakey-clean    — same, without the alphaCap=0.78 frosting hack.
//   screen-subtract    — proper alpha extraction:
//                          spill  = max(0, G - max(R, B))
//                          alpha  = 1 - clip(spill / threshold, 0, 1)
//                          G_out  = min(G, max(R, B))    (despill)
//                          R_out, B_out unchanged.
//                        Semi-transparent dark elements over green become
//                        proper semi-transparent dark elements over the bg —
//                        not "kinda-keyed dark green blocks".
//
// Usage
// -----
//   node scripts/interwheel/experiment-greenscreen.mjs
//   node scripts/interwheel/experiment-greenscreen.mjs --algorithm=screen-subtract
//   node scripts/interwheel/experiment-greenscreen.mjs --algorithm=all      # compare every algo
//   node scripts/interwheel/experiment-greenscreen.mjs --bg=path/to/clip.mp4
//   node scripts/interwheel/experiment-greenscreen.mjs --threshold=210      # screen-subtract knob
//
// Outputs land in .tmp/gs-experiment/ and the final paths are printed at the
// end so you can `mpv` / `ffplay` them directly.

import { mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const DEFAULT_OUT_DIR = '.tmp/gs-experiment';
const DEFAULT_OVERLAY = 'wasted-greenscreen.mp4';
const TARGET_W = 1080;
const TARGET_H = 1920;
const FPS = 40;

// Current production values (mirrors compose-short.mjs).
const CHROMAKEY_COLOR = '0x14ff07';
const CHROMAKEY_SIMILARITY = 0.18;
const CHROMAKEY_BLEND = 0.10;
const CHROMAKEY_DESPILL_MIX = 0.5;
const CHROMAKEY_ALPHA_CAP = 0.78;

// Screen-subtract default. The pure-key pixel in the WASTED overlay is roughly
// (20, 255, 7) so G - max(R,B) ≈ 235 in the brightest key region. Mapping 235
// → alpha 0 is the right idea, but the overlay has a vignette where corners
// are at G ≈ 145 (i.e. spill ≈ 134) — so a threshold of 235 leaves the corners
// at alpha ≈ 0.43, which dims the entire periphery of the gameplay.
//
// Lowering the threshold pulls the vignette (and the "dark transparent bar"
// behind WASTED) further toward fully transparent. 200 is a reasonable middle
// ground; 150 makes the vignette nearly invisible and keeps only the explicit
// dark band; 235 honors the full vignette as a darkening wash.
const DEFAULT_SUBTRACT_THRESHOLD = 200;

const ALGORITHMS = ['chromakey-current', 'chromakey-clean', 'screen-subtract'];

function parseArgs(argv) {
  const args = {
    bg: null,
    overlay: DEFAULT_OVERLAY,
    outDir: DEFAULT_OUT_DIR,
    algorithm: 'all',
    threshold: DEFAULT_SUBTRACT_THRESHOLD,
    bgSeconds: 6,
    overlayStart: 0.5,    // when to start showing the overlay over the bg
    keepBg: false,        // skip regenerating the rainbow if it already exists
    sideBySide: true,     // also write a stacked comparison mp4
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--no-side-by-side') args.sideBySide = false;
    else if (raw === '--keep-bg') args.keepBg = true;
    else if (raw.startsWith('--bg=')) args.bg = raw.slice('--bg='.length);
    else if (raw.startsWith('--overlay=')) args.overlay = raw.slice('--overlay='.length);
    else if (raw.startsWith('--out-dir=')) args.outDir = raw.slice('--out-dir='.length);
    else if (raw.startsWith('--algorithm=')) args.algorithm = raw.slice('--algorithm='.length);
    else if (raw.startsWith('--threshold=')) args.threshold = Number(raw.slice('--threshold='.length));
    else if (raw.startsWith('--bg-seconds=')) args.bgSeconds = Number(raw.slice('--bg-seconds='.length));
    else if (raw.startsWith('--overlay-start=')) args.overlayStart = Number(raw.slice('--overlay-start='.length));
    else { console.error(`Unknown argument: ${raw}`); args.help = true; }
  }
  if (args.algorithm !== 'all' && !ALGORITHMS.includes(args.algorithm)) {
    console.error(`--algorithm must be one of: all, ${ALGORITHMS.join(', ')}`);
    args.help = true;
  }
  return args;
}

function help() {
  console.log(`Greenscreen experiment harness

USAGE
  node scripts/interwheel/experiment-greenscreen.mjs                # all algorithms vs rainbow bg
  node scripts/interwheel/experiment-greenscreen.mjs --algorithm=screen-subtract
  node scripts/interwheel/experiment-greenscreen.mjs --bg=clip.mp4

OPTIONS
  --algorithm=KEY      One of: all, ${ALGORITHMS.join(', ')}. Default 'all'.
  --threshold=N        screen-subtract: green-spill value mapped to fully transparent.
                       Default ${DEFAULT_SUBTRACT_THRESHOLD}. 235 keeps the vignette wash; 150 drops it.
  --bg=PATH            Use this video as the background (otherwise generate a rainbow).
  --bg-seconds=N       Length of the generated rainbow. Default 6.
  --overlay=PATH       Greenscreen overlay. Default ./${DEFAULT_OVERLAY}.
  --overlay-start=N    Seconds into the bg before the overlay appears. Default 0.5.
  --out-dir=PATH       Where to dump generated mp4s. Default ${DEFAULT_OUT_DIR}.
  --keep-bg            Don't re-generate the rainbow if it already exists.
  --no-side-by-side    Skip the stacked comparison mp4.
`);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}`));
    });
  });
}

// Generate a 1080x1920 rainbow + drifting white squares background. Uses
// lavfi sources so we don't need any external assets. The rainbow makes it
// easy to see green-spill removal (any leftover green on the foreground stands
// out against red/blue/purple), and the moving squares give us hard edges
// that should remain visible behind semi-transparent overlay regions.
async function generateBackground(outPath, seconds) {
  const dur = seconds.toFixed(2);
  // Filter graph:
  //   testsrc2 → wide rainbow
  //   pad to 1080x1920
  //   overlay a slowly-rotating gradient on top to make it more "scene-like"
  const filter = [
    // Rainbow base (smptebars is too clinical; testsrc2 has motion).
    `color=size=${TARGET_W}x${TARGET_H}:rate=${FPS}:duration=${dur}:color=black[bg]`,
    // Three moving color bands.
    `color=size=${TARGET_W}x600:rate=${FPS}:duration=${dur}:color=#e63946[r]`,
    `color=size=${TARGET_W}x600:rate=${FPS}:duration=${dur}:color=#457b9d[b]`,
    `color=size=${TARGET_W}x600:rate=${FPS}:duration=${dur}:color=#ffd166[y]`,
    `[bg][r]overlay=x=0:y='-300+if(lt(t,${dur}/2),t*200,(${dur}-t)*200)'[bg1]`,
    `[bg1][b]overlay=x=0:y='${TARGET_H}-300-if(lt(t,${dur}/2),t*200,(${dur}-t)*200)'[bg2]`,
    `[bg2][y]overlay=x='if(lt(t,${dur}/2),t*100,(${dur}-t)*100)':y=${(TARGET_H/2)-300}[bg3]`,
    // Drifting white square that should remain visible behind any region the
    // overlay claims to be transparent. Hard contrast edge = good test.
    `color=size=200x200:rate=${FPS}:duration=${dur}:color=white[sq1]`,
    `color=size=200x200:rate=${FPS}:duration=${dur}:color=black[sq2]`,
    `[bg3][sq1]overlay=x='100+t*120':y='100+t*60'[bg4]`,
    `[bg4][sq2]overlay=x='${TARGET_W}-300-t*100':y='${TARGET_H}-300-t*40'[outv]`,
  ].join(';');
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `nullsrc=size=${TARGET_W}x${TARGET_H}:rate=${FPS}:duration=${dur}`,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    outPath,
  ]);
}

// Build the overlay-side filter chain for one algorithm. Inputs are the raw
// overlay video stream (label [1:v]); output is a filter chain that takes
// [1:v] and produces a [keyed] stream that the overlay filter can use.
function overlayChain(algorithm, threshold) {
  const lead = `[1:v]scale=${TARGET_W}:${TARGET_H},format=rgba`;

  if (algorithm === 'chromakey-current') {
    // Mirrors compose-short.mjs exactly.
    return [
      `${lead},`
        + `chromakey=${CHROMAKEY_COLOR}:${CHROMAKEY_SIMILARITY}:${CHROMAKEY_BLEND},`
        + `despill=type=green:mix=${CHROMAKEY_DESPILL_MIX},`
        + `colorchannelmixer=aa=${CHROMAKEY_ALPHA_CAP}[keyed]`,
    ];
  }

  if (algorithm === 'chromakey-clean') {
    // Same as current but without the alphaCap=0.78 hack — fully opaque
    // pixels remain fully opaque.
    return [
      `${lead},`
        + `chromakey=${CHROMAKEY_COLOR}:${CHROMAKEY_SIMILARITY}:${CHROMAKEY_BLEND},`
        + `despill=type=green:mix=${CHROMAKEY_DESPILL_MIX}[keyed]`,
    ];
  }

  if (algorithm === 'screen-subtract') {
    // Per-pixel screen subtraction. Notes:
    //   * geq exposes r(X,Y) / g(X,Y) / b(X,Y) as the input channels.
    //   * In RGBA the alpha plane is computed in plain 0..255 too.
    //   * lt(a,b) returns 1.0 if a<b else 0.0; gt() likewise. We use those
    //     to express max() because geq doesn't ship a max() builtin in some
    //     ffmpeg builds — but `max()` actually IS available, so we use it.
    const t = Number.isFinite(threshold) && threshold > 0 ? threshold : DEFAULT_SUBTRACT_THRESHOLD;
    const rExpr = `r(X,Y)`;
    const bExpr = `b(X,Y)`;
    const gExpr = `g(X,Y)`;
    const maxRB = `max(${rExpr},${bExpr})`;
    const spill = `max(0, ${gExpr} - ${maxRB})`;
    return [
      `${lead},`
        + `geq=`
          + `r='${rExpr}':`
          + `g='min(${gExpr}, ${maxRB})':`
          + `b='${bExpr}':`
          + `a='255 - 255 * clip(${spill} / ${t}, 0, 1)'`
        + `[keyed]`,
    ];
  }

  throw new Error(`Unknown algorithm: ${algorithm}`);
}

async function compositeOne({ bgPath, overlayPath, outPath, algorithm, threshold, overlayStartSec }) {
  const overlayMs = Math.round(overlayStartSec * 1000);
  const chain = overlayChain(algorithm, threshold);
  const filter = [
    ...chain,
    `[keyed]setpts=PTS-STARTPTS+${overlayStartSec}/TB[keyedDelayed]`,
    `[0:v][keyedDelayed]overlay=x=0:y=0:format=auto[outv]`,
  ].join(';');
  void overlayMs; // used to silence linter; we use overlayStartSec directly above
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', bgPath,
    '-i', overlayPath,
    '-filter_complex', filter,
    '-map', '[outv]',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-an',
    outPath,
  ]);
}

// Compose a horizontal stacking of N variants with a label burned into each
// panel. Useful for visually scrubbing through differences in a single mpv.
async function composeSideBySide(panels, outPath) {
  const n = panels.length;
  if (n === 0) return;
  const inputs = panels.flatMap((p) => ['-i', p.path]);
  const labelW = Math.floor(TARGET_W / 2); // each panel is downscaled to half width
  const labelH = Math.floor(TARGET_H / 2);
  const filterParts = [];
  for (let i = 0; i < n; i += 1) {
    filterParts.push(
      `[${i}:v]scale=${labelW}:${labelH},`
        + `drawtext=text='${panels[i].label.replace(/[\\:']/g, '\\$&')}':`
          + `fontsize=28:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=8:`
          + `x=24:y=24[p${i}]`
    );
  }
  // Layout: hstack everything (works fine for up to 4 panels).
  const stackInputs = panels.map((_, i) => `[p${i}]`).join('');
  filterParts.push(`${stackInputs}hstack=inputs=${n}[outv]`);
  await run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...inputs,
    '-filter_complex', filterParts.join(';'),
    '-map', '[outv]',
    '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-an',
    outPath,
  ]);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }

  const outDir = path.resolve(REPO_ROOT, args.outDir);
  await mkdir(outDir, { recursive: true });

  const overlayPath = path.resolve(REPO_ROOT, args.overlay);
  if (!(await pathExists(overlayPath))) {
    console.error(`Overlay not found: ${overlayPath}`);
    process.exit(1);
  }

  let bgPath;
  if (args.bg) {
    bgPath = path.resolve(REPO_ROOT, args.bg);
    if (!(await pathExists(bgPath))) {
      console.error(`Background not found: ${bgPath}`);
      process.exit(1);
    }
    console.log(`Using background: ${path.relative(REPO_ROOT, bgPath)}`);
  } else {
    bgPath = path.join(outDir, `bg-rainbow-${args.bgSeconds}s.mp4`);
    if (args.keepBg && await pathExists(bgPath)) {
      console.log(`Reusing existing rainbow bg: ${path.relative(REPO_ROOT, bgPath)}`);
    } else {
      console.log(`Generating rainbow bg (${args.bgSeconds}s, ${TARGET_W}x${TARGET_H}) → ${path.relative(REPO_ROOT, bgPath)}`);
      await generateBackground(bgPath, args.bgSeconds);
    }
  }

  const algos = args.algorithm === 'all' ? ALGORITHMS : [args.algorithm];
  const panels = [];
  for (const algo of algos) {
    const tag = algo === 'screen-subtract' ? `${algo}-t${args.threshold}` : algo;
    const outPath = path.join(outDir, `composite-${tag}.mp4`);
    console.log(`\n[${algo}] → ${path.relative(REPO_ROOT, outPath)}`);
    await compositeOne({
      bgPath,
      overlayPath,
      outPath,
      algorithm: algo,
      threshold: args.threshold,
      overlayStartSec: args.overlayStart,
    });
    panels.push({ path: outPath, label: tag });
  }

  if (args.sideBySide && panels.length > 1) {
    const sxsPath = path.join(outDir, `compare-${algos.join('_vs_')}.mp4`);
    console.log(`\nSide-by-side → ${path.relative(REPO_ROOT, sxsPath)}`);
    await composeSideBySide(panels, sxsPath);
  }

  console.log(`\nDone. Inspect with:`);
  for (const p of panels) console.log(`  mpv ${path.relative(REPO_ROOT, p.path)}`);
}

main().catch((err) => {
  console.error('experiment-greenscreen failed:', err);
  process.exit(1);
});
