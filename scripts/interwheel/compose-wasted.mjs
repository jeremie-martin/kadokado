#!/usr/bin/env node
// Render the GTA-V "WASTED" death sequence over an arbitrary base video using
// the Remotion `WastedEffect` composition. No greenscreen — authored from
// scratch in Remotion (color grade, vignette, slow-mo, text impact synced to
// the audio sting at audio_t = textAppearSec).
//
// The default recipe — synced bloom + RGB-split impact at 2.43s, sepia-warm
// tint, retained color (sat ≈ 0.26) — is the result of iterating against
// friend feedback that pinpointed where the early "Max-Payne cool tint /
// near-grayscale / white-flash / screen-shake" sketches drifted from the
// GTA source. The four kept presets express stylistic variation on top of
// that shared foundation; flash + shake are gone for good.
//
// Each render lands in .tmp/renders/videos/<vid>/ with a metadata.json shaped
// like the InterwheelShort renders so dashboard.mjs picks them up.
//
// Usage:
//   npm run compose:wasted
//   npm run compose:wasted -- --preset=cinematic
//   npm run compose:wasted -- --preset=subtle --variant=tweak --base-playback-rate=0.30
//   npm run compose:wasted -- --base=./other.mp4 --text=./other.png --audio=./other.mp3

import { mkdir, stat, copyFile, writeFile, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));
const REMOTION_DIR = 'remotion';
const REMOTION_LATEST_REL = 'public/latest';
const RENDERS_DIR = '.tmp/renders/videos';
const FPS = 40;
const COMPOSITION_SIDE = 1200;

// Mirrors WASTED_EFFECT_DEFAULTS in remotion/src/WastedEffect.tsx. Keep in
// sync — this is the source of truth for the runner's defaults so the user
// can override any single knob via CLI. The CLI parser uses each entry's
// typeof to decide how to coerce its value (number vs string).
//
// These values *are* the canonical recipe (a.k.a. the `default` preset),
// so PRESETS.default is empty — every preset is just a partial override on
// top of these defaults.
const DEFAULTS = {
  drainSec: 1.5,
  textAppearSec: 2.43,
  totalSec: 7.76,
  endSaturation: 0.26,
  endBrightness: 0.56,
  endContrast: 1.16,
  tintStrength: 0.24,
  tintColor: '#34221a',
  vignetteIntensity: 0.86,
  vignetteInnerRadius: 0.28,
  postImpactSaturation: 0.26,    // = endSaturation by default
  postImpactSaturationDurationSec: 1.0,
  basePlaybackRate: 0.15,
  baseStartFromSec: 0,
  textOvershootScale: 1.18,
  textPunchDurationSec: 0.10,
  textBreathAmplitude: 0.025,
  textBloomPeakPx: 24,
  textBloomDurationSec: 0.18,
  textAberrationPeakPx: 6,
  textAberrationDurationSec: 0.16,
  ambientZoomEnd: 1.05,
};

// Stylistic variants. All share the canonical foundation (synced 2.43s
// impact, ~200ms bloom + RGB-split spike, no flash/shake); each one varies
// the grade depth, slow-mo intensity, and tint to express a different
// register. To explore beyond these, override any single knob via CLI:
//   --preset=cinematic --base-playback-rate=0.20 --vignette-intensity=0.95
const PRESETS = {
  // Canonical. Sepia-warm tint, retained color, mid drama. The recipe the
  // user landed on as "very, very, very, very good".
  default: {},

  // More drama: deeper grade, harder slow-mo, tighter vignette, bigger
  // bloom + aberration spike. For impact moments that should hit hard.
  cinematic: {
    drainSec: 1.8,
    endSaturation: 0.18,
    endBrightness: 0.50,
    endContrast: 1.22,
    tintStrength: 0.30,
    tintColor: '#3a2410',         // deeper sepia
    vignetteIntensity: 0.94,
    vignetteInnerRadius: 0.22,
    basePlaybackRate: 0.10,       // ~10× slow-mo
    textOvershootScale: 1.24,
    textPunchDurationSec: 0.12,
    textBloomPeakPx: 36,
    textBloomDurationSec: 0.22,
    textAberrationPeakPx: 9,
    textAberrationDurationSec: 0.20,
  },

  // Less drama: lighter grade, gentler slow-mo, softer accents. For
  // contexts where WASTED shouldn't dominate the gameplay underneath.
  subtle: {
    drainSec: 1.2,
    endSaturation: 0.40,
    endBrightness: 0.65,
    endContrast: 1.10,
    tintStrength: 0.16,
    tintColor: '#2a1f15',         // lighter sepia
    vignetteIntensity: 0.65,
    vignetteInnerRadius: 0.40,
    basePlaybackRate: 0.25,
    textOvershootScale: 1.10,
    textBloomPeakPx: 16,
    textAberrationPeakPx: 3,
  },

  // Tint alternative: same shape as default but with a cool teal tint
  // instead of sepia. Reads more "Max Payne" than GTA — kept as an
  // explicit stylistic choice, not as a faithful GTA recreation.
  cool: {
    tintColor: '#1d2a35',
    tintStrength: 0.28,           // cool tint reads stronger than sepia
                                  // at the same opacity, so trim slightly
  },
};

function parseArgs(argv) {
  const args = {
    base: 'base.mp4',
    text: 'wasted.png',
    audio: 'wasted.mp3',
    rendersDir: RENDERS_DIR,
    variant: null,           // overrides folder name fragment; default = preset
    preset: 'default',
    studio: false,
    overrides: {},           // CLI overrides into the WastedEffect props
    help: false,
  };
  // Each effect knob is a top-level CLI flag. We look them up by lower-kebab.
  const KNOB_KEYS = Object.keys(DEFAULTS);
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') { args.help = true; continue; }
    if (raw === '--studio') { args.studio = true; continue; }
    const m = raw.match(/^--([a-z][a-z0-9-]*)=(.*)$/);
    if (!m) { console.error(`Unknown argument: ${raw}`); args.help = true; continue; }
    const [, key, val] = m;
    if (key === 'base') args.base = val;
    else if (key === 'text') args.text = val;
    else if (key === 'audio') args.audio = val;
    else if (key === 'renders-dir') args.rendersDir = val;
    else if (key === 'variant') args.variant = val;
    else if (key === 'preset') args.preset = val;
    else {
      const camel = kebabToCamel(key);
      if (KNOB_KEYS.includes(camel)) {
        const defaultValue = DEFAULTS[camel];
        if (typeof defaultValue === 'number') {
          const num = Number(val);
          if (!Number.isFinite(num)) {
            console.error(`--${key} must be a number, got "${val}"`);
            args.help = true;
          } else {
            args.overrides[camel] = num;
          }
        } else {
          // String knob (e.g. tintColor). Pass through verbatim.
          args.overrides[camel] = val;
        }
      } else {
        console.error(`Unknown argument: ${raw}`);
        args.help = true;
      }
    }
  }
  if (!(args.preset in PRESETS)) {
    console.error(`Unknown preset "${args.preset}". Available: ${Object.keys(PRESETS).join(', ')}`);
    args.help = true;
  }
  return args;
}

function help() {
  const presetList = Object.keys(PRESETS).join(', ');
  const knobs = Object.entries(DEFAULTS)
    .map(([k, v]) => `    --${camelToKebab(k)}=${v}`)
    .join('\n');
  console.log(`compose-wasted — render the GTA-V WASTED effect over a base video

USAGE:
  npm run compose:wasted
  npm run compose:wasted -- --preset=cinematic
  npm run compose:wasted -- --variant=my-tweak --vignette-intensity=0.92 --base-playback-rate=0.12
  npm run compose:wasted -- --base=./other.mp4 --text=./my-wasted.png --audio=./my-wasted.mp3
  npm run compose:wasted -- --studio          # refresh public/latest only, do not render

INPUT (resolved against repo root):
  --base=PATH               Base video. Default ./base.mp4.
  --text=PATH               WASTED text PNG with transparent bg. Default ./wasted.png.
  --audio=PATH              WASTED audio. Default ./wasted.mp3.

PRESETS (combine with --variant=NAME to label the render folder):
  --preset=KEY              One of: ${presetList}. Default 'default'.

EFFECT KNOBS (override any single value on top of the preset):
${knobs}

OUTPUT:
  --renders-dir=PATH        Where to write the per-render folder. Default ${RENDERS_DIR}.
  --variant=NAME            Folder-name fragment. Default = preset name.
                            Final folder is wasted-<variant>-<YYYYMMDDTHHMMSS>.
`);
}

function kebabToCamel(s) {
  return s.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function camelToKebab(s) {
  return s.replace(/([A-Z])/g, (_, c) => `-${c.toLowerCase()}`);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}
async function lpathExists(p) {
  try { await lstat(p); return true; } catch { return false; }
}

async function ensureFileCopy(srcAbs, dstAbs) {
  if (await lpathExists(dstAbs)) await unlink(dstAbs);
  await mkdir(path.dirname(dstAbs), { recursive: true });
  await copyFile(srcAbs, dstAbs);
}

function spawnLogged(cmd, argv, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}`));
    });
  });
}

function timestampSlug(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }

  // Resolve & validate inputs.
  const baseAbs = path.resolve(REPO_ROOT, args.base);
  const textAbs = path.resolve(REPO_ROOT, args.text);
  const audioAbs = path.resolve(REPO_ROOT, args.audio);
  for (const [label, p] of [['base', baseAbs], ['text', textAbs], ['audio', audioAbs]]) {
    if (!(await pathExists(p))) {
      console.error(`Missing ${label}: ${p}`);
      process.exit(1);
    }
  }

  // Compose final props: defaults → preset → CLI overrides.
  const presetOverrides = PRESETS[args.preset];
  const props = { ...DEFAULTS, ...presetOverrides, ...args.overrides };

  // Refresh remotion/public/latest/ copies. Use stable filenames so the
  // composition's defaultProps work in Studio without further setup.
  const linkDir = path.resolve(REPO_ROOT, REMOTION_DIR, REMOTION_LATEST_REL);
  await ensureFileCopy(baseAbs, path.join(linkDir, 'base.mp4'));
  await ensureFileCopy(textAbs, path.join(linkDir, 'wasted.png'));
  await ensureFileCopy(audioAbs, path.join(linkDir, 'wasted.mp3'));
  console.log(`Refreshed Remotion public/latest:`);
  console.log(`  base  ← ${path.relative(REPO_ROOT, baseAbs)}`);
  console.log(`  text  ← ${path.relative(REPO_ROOT, textAbs)}`);
  console.log(`  audio ← ${path.relative(REPO_ROOT, audioAbs)}`);

  if (args.studio) {
    console.log(`\nFiles refreshed. Launch Remotion Studio with:`);
    console.log(`  cd remotion && npm run studio`);
    console.log(`Then open the WastedEffect composition.`);
    return;
  }

  const variant = args.variant ?? args.preset;
  const vid = `wasted-${variant}-${timestampSlug()}`;
  const renderDir = path.resolve(REPO_ROOT, args.rendersDir, vid);
  await mkdir(renderDir, { recursive: true });

  const outName = `${vid}-short.mp4`;
  const outPath = path.join(renderDir, outName);

  // Remotion props: pass the effect knobs + reference the now-refreshed
  // files via remotion's staticFile mechanism (we mirror the path the
  // composition's defaultProps already use).
  const remotionProps = {
    ...props,
    baseVideoSrc: 'latest/base.mp4',
    wastedTextSrc: 'latest/wasted.png',
    wastedAudioSrc: 'latest/wasted.mp3',
  };
  const totalFrames = Math.round(props.totalSec * FPS);
  const lastFrame = Math.max(0, totalFrames - 1);

  console.log(`\nRendering WastedEffect (preset=${args.preset}, ${COMPOSITION_SIDE}x${COMPOSITION_SIDE}, ${totalFrames} frames)`);
  console.log(`  → ${path.relative(REPO_ROOT, outPath)}`);
  await spawnLogged('npx', [
    'remotion', 'render',
    'src/index.ts', 'WastedEffect',
    outPath,
    `--frames=0-${lastFrame}`,
    `--props=${JSON.stringify(remotionProps)}`,
  ], { cwd: path.resolve(REPO_ROOT, REMOTION_DIR) });

  // Also archive the inputs so each attempt is fully self-contained.
  await copyFile(baseAbs, path.join(renderDir, path.basename(baseAbs)));
  await copyFile(textAbs, path.join(renderDir, path.basename(textAbs)));
  await copyFile(audioAbs, path.join(renderDir, path.basename(audioAbs)));

  // Metadata shaped to satisfy dashboard.mjs's renderCard():
  //   meta.{seed, preset, renderedAt}, meta.short.{file, width, height, fps, frames},
  //   meta.run.{frames, endingTick, finalScore, finalHeightM, finalState}.
  // Most "run" fields are N/A here (this isn't a game capture); we surface
  // useful effect knobs via meta.effect instead and fill run with sentinels
  // so the card doesn't look broken.
  const metadata = {
    vid,
    renderedAt: new Date().toISOString(),
    seed: variant,            // dashboard prints "seed <b>X</b>"; reuse for variant tag
    preset: args.preset,
    sourceMp4: path.relative(REPO_ROOT, baseAbs),
    sourceText: path.relative(REPO_ROOT, textAbs),
    sourceAudio: path.relative(REPO_ROOT, audioAbs),
    short: {
      file: outName,
      width: COMPOSITION_SIDE,
      height: COMPOSITION_SIDE,
      fps: FPS,
      frames: totalFrames,
    },
    run: {
      frames: totalFrames,
      endingTick: Math.round(props.textAppearSec * FPS),
      drownedTick: null,
      explodedTick: null,
      finalScore: null,
      finalHeightM: null,
      finalState: 'DEAD',
    },
    effect: {
      composition: 'WastedEffect',
      preset: args.preset,
      variant,
      ...props,
    },
  };
  await writeFile(path.join(renderDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

  console.log(`\nDone. ${path.relative(REPO_ROOT, renderDir)}/`);
  console.log(`  ${outName}`);
  console.log(`  ${path.basename(baseAbs)}, ${path.basename(textAbs)}, ${path.basename(audioAbs)}`);
  console.log(`  metadata.json`);
}

main().catch((err) => {
  console.error('compose-wasted failed:', err);
  process.exit(1);
});
