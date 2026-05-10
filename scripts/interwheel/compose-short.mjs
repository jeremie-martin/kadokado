#!/usr/bin/env node
// Copy a chosen game.mp4 + game.ndjson run into remotion/public/latest/,
// invoke `remotion render` to produce a 1080x1920 base mp4, then run an
// ffmpeg post-step that chromakeys a greenscreen WASTED overlay (with its
// own audio) onto the base, mixed with the music track Remotion already
// rendered. The composition's music ducks while the overlay window is on.
//
// Files are copied (not symlinked) into remotion/public/latest/ because
// Remotion's webpack bundler dereferences public/ contents but doesn't
// follow symlinks.
//
// Each rendered short lands in its own `.tmp/renders/videos/<vid>/` folder,
// alongside copies of the source mp4 + sidecar and a metadata.json that
// captures probe + render details. The folder name encodes seed, preset and
// timestamp, so renders accumulate naturally for side-by-side comparison.
//
// First-time setup: cd remotion && npm install
//
// Usage:
//   npm run compose:interwheel -- --seed=4200
//   npm run compose:interwheel -- --seed=4200 --preset=x4
//   npm run compose:interwheel -- --seed=4200 --music-mode=start
//   npm run compose:interwheel -- --seed=4200 --no-music
//   npm run compose:interwheel -- --seed=4200 --no-wasted
//   npm run compose:interwheel -- --seed=4200 --studio
//   npm run compose:interwheel -- --in=path/to/game.mp4 --in-data=path/to/game.ndjson

import { mkdir, stat, unlink, copyFile, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_PRESET = 'x4';
const DEFAULT_VIDEO_DIR = '.tmp/captures/video';
const DEFAULT_RENDERS_DIR = '.tmp/renders/videos';
const REMOTION_DIR = 'remotion';
const REMOTION_LATEST_REL = 'public/latest';
const DEFAULT_MUSIC = path.join(os.homedir(), 'obs', 'infinite_mario_ai_long_level.opus');
const DEFAULT_WASTED_OVERLAY = 'wasted-greenscreen.mp4'; // relative to repo root
const FPS = 40;
// In end-mode the music finishes this many seconds before the music's own
// end — leaves the most resonant section in the body of the video instead
// of bleeding into the file's natural fade-out.
const DEFAULT_MUSIC_TAIL_OFFSET_SEC = 12;
// WASTED visual + audio kick in this many seconds before the actual death
// frame. Foreshadows the impact and lets the audio breathe.
const DEFAULT_WASTED_LEAD_SEC = 0.5;
// Hard cap on extra frames added past the sidecar to fit the WASTED overlay.
const MAX_WASTED_TAIL_SEC = 14;
// Greenscreen alpha extraction. We use a per-pixel screen-subtract / "unmult"
// formula instead of ffmpeg's chromakey filter:
//
//   spill = max(0, G - max(R, B))               // how green-dominant the pixel is
//   alpha = 1 - clip(spill / threshold, 0, 1)   // straight alpha
//   G_out = min(G, max(R, B))                   // strip green spill, leave R/B alone
//
// Why not chromakey: chromakey is a binary keyer — pixels are either fully
// transparent (close enough to the key) or fully opaque (far enough). It can't
// represent regions like the dark horizontal bar behind the WASTED text in this
// overlay, which is authored as a *darker green* meaning "50% black on green
// screen". chromakey collapses that band to either fully keyed-away or fully
// kept, so the GTA-style translucent banner disappears. Screen-subtract maps
// it to ~50% alpha black, which composites correctly over the gameplay.
//
// THRESHOLD knob: spill at the brightest key pixel in this overlay is ≈ 235
// ((20,255,7) → 255-20). A threshold of 235 honours the source's vignette as a
// gentle darkening wash on the periphery — the canonical GTA "wasted" feel.
// Lower it (e.g. 150) to drop the vignette and keep only the explicit dark
// band crisp; raise it slightly above 235 for a stronger wash. Tune with
// scripts/interwheel/experiment-greenscreen.mjs without re-rendering a run.
const GREEN_KEY_THRESHOLD = 235;
// Volume scale applied to the WASTED audio when mixed on top of (already
// ducked) music. < 1 dampens it slightly so it doesn't peak harshly.
const WASTED_AUDIO_GAIN = 0.85;

function parseArgs(argv) {
  const args = {
    seed: null,
    preset: DEFAULT_PRESET,
    inMp4: null,
    inNdjson: null,
    rendersDir: DEFAULT_RENDERS_DIR,
    vid: null,
    musicFile: DEFAULT_MUSIC,
    musicMode: 'end',
    musicTailOffsetSec: DEFAULT_MUSIC_TAIL_OFFSET_SEC,
    noMusic: false,
    wastedOverlay: DEFAULT_WASTED_OVERLAY,
    wastedLeadSec: DEFAULT_WASTED_LEAD_SEC,
    greenThreshold: GREEN_KEY_THRESHOLD,
    noWasted: false,
    studio: false,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--studio') args.studio = true;
    else if (raw === '--no-music') args.noMusic = true;
    else if (raw === '--no-wasted') args.noWasted = true;
    else if (raw.startsWith('--seed=')) args.seed = Number(raw.slice('--seed='.length));
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length);
    else if (raw.startsWith('--in=')) args.inMp4 = raw.slice('--in='.length);
    else if (raw.startsWith('--in-data=')) args.inNdjson = raw.slice('--in-data='.length);
    else if (raw.startsWith('--renders-dir=')) args.rendersDir = raw.slice('--renders-dir='.length);
    else if (raw.startsWith('--vid=')) args.vid = raw.slice('--vid='.length);
    else if (raw.startsWith('--music=')) args.musicFile = raw.slice('--music='.length);
    else if (raw.startsWith('--music-mode=')) args.musicMode = raw.slice('--music-mode='.length);
    else if (raw.startsWith('--music-tail-offset=')) args.musicTailOffsetSec = Number(raw.slice('--music-tail-offset='.length));
    else if (raw.startsWith('--wasted-overlay=')) args.wastedOverlay = raw.slice('--wasted-overlay='.length);
    else if (raw.startsWith('--wasted-lead=')) args.wastedLeadSec = Number(raw.slice('--wasted-lead='.length));
    else if (raw.startsWith('--green-threshold=')) args.greenThreshold = Number(raw.slice('--green-threshold='.length));
    else {
      console.error(`Unknown argument: ${raw}`);
      args.help = true;
    }
  }
  if (!['start', 'end'].includes(args.musicMode)) {
    console.error(`--music-mode must be 'start' or 'end'.`);
    args.help = true;
  }
  return args;
}

function help() {
  console.log(`Interwheel short-form video composer

USAGE:
  npm run compose:interwheel -- --seed=4200
  npm run compose:interwheel -- --seed=4200 --preset=x4
  npm run compose:interwheel -- --seed=4200 --music-mode=start
  npm run compose:interwheel -- --seed=4200 --no-music
  npm run compose:interwheel -- --seed=4200 --no-wasted
  npm run compose:interwheel -- --seed=4200 --studio
  npm run compose:interwheel -- --in=PATH --in-data=PATH

OPTIONS:
  --seed=N                 Resolve interwheel-seedN-<preset>.{mp4,ndjson} from .tmp/captures/video/.
  --preset=KEY             Asset preset to pair with --seed. Default ${DEFAULT_PRESET}.
  --in=PATH                Explicit path to the game.mp4 (overrides --seed).
  --in-data=PATH           Explicit path to the game.ndjson (overrides --seed).
  --renders-dir=PATH       Where to write the per-render folder. Default ${DEFAULT_RENDERS_DIR}.
  --vid=NAME               Override the per-render folder name. Default seed<N>-<preset>-<YYYYMMDDTHHMMSS>.
  --music=PATH             Background music file. Default ${DEFAULT_MUSIC}.
  --music-mode=start|end   Where in the music to start. Default 'end' — anchored to the music tail.
  --music-tail-offset=N    In end-mode, leave N seconds of music tail unused. Default ${DEFAULT_MUSIC_TAIL_OFFSET_SEC}.
                           (e.g. for a 30s video and N=12, music plays from M-42 to M-12.)
  --no-music               Do not add background music.
  --wasted-overlay=PATH    Greenscreen WASTED video composited on death. Default ./${DEFAULT_WASTED_OVERLAY}.
                           Audio from this file is mixed onto the soundtrack.
  --wasted-lead=N          Trigger WASTED N seconds before the actual death frame.
                           Default ${DEFAULT_WASTED_LEAD_SEC}s.
  --green-threshold=N      Screen-subtract threshold for the WASTED greenscreen.
                           Default ${GREEN_KEY_THRESHOLD}. Honours the source vignette as a wash;
                           lower (e.g. 150) drops the wash and keeps only the explicit
                           dark band crisp.
  --no-wasted              Skip the WASTED overlay entirely.
  --studio                 Refresh public/latest/ copies only, do not render.
                           (Studio shows the base render — WASTED is applied in the
                           ffmpeg post-step, which Studio doesn't run.)
`);
}

async function pathExists(p) {
  try { await stat(p); return true; } catch { return false; }
}

async function lpathExists(p) {
  try { const { lstat } = await import('node:fs/promises'); await lstat(p); return true; } catch { return false; }
}

async function ensureFileCopy(srcAbs, dstAbs) {
  // Remotion's webpack bundler doesn't follow symlinks when copying public/
  // into the temp bundle dir, so we copy instead.
  if (await lpathExists(dstAbs)) {
    await unlink(dstAbs);
  }
  await mkdir(path.dirname(dstAbs), { recursive: true });
  await copyFile(srcAbs, dstAbs);
}

async function readSidecar(filePath) {
  const text = await readFile(filePath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    rows.push(JSON.parse(line));
  }
  return rows;
}

function spawnLogged(cmd, args, opts) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', ...opts });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(' ')} exited ${code}`));
    });
  });
}

function ffprobeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nk=1:nw=1',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe ${filePath} exited ${code}: ${stderr}`));
        return;
      }
      const v = parseFloat(stdout.trim());
      if (!Number.isFinite(v)) reject(new Error(`ffprobe could not parse duration for ${filePath}`));
      else resolve(v);
    });
  });
}

// Walk the H.264 stream once to make sure the file is well-formed. A partial
// file (e.g. captured while make-video is still writing) tends to look fine
// to the moov atom but blows up with "Invalid NAL unit size" once decoded —
// Remotion then renders garbage, with the game appearing to freeze. This
// catches that race up front.
function ffprobeStreamHealthy(filePath) {
  return new Promise((resolve) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'default=nk=1:nw=1',
      filePath,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', () => resolve({ ok: false, error: 'ffprobe spawn failed' }));
    proc.on('close', (code) => {
      if (code !== 0 || stderr.length > 0) {
        resolve({ ok: false, error: stderr.split('\n').filter(Boolean).slice(0, 3).join(' / ') || `code ${code}` });
      } else {
        resolve({ ok: true });
      }
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

// Build the ffmpeg invocation that screen-subtracts the WASTED greenscreen
// onto the Remotion-rendered base mp4 and mixes its audio in. See the
// GREEN_KEY_THRESHOLD comment above for the algorithm.
async function compositeWastedOverlay({
  basePath,
  overlayPath,
  outPath,
  overlayStartSec,
  greenThreshold,
}) {
  const overlayMs = Math.round(overlayStartSec * 1000);
  const t = Number.isFinite(greenThreshold) && greenThreshold > 0 ? greenThreshold : GREEN_KEY_THRESHOLD;
  // Filtergraph:
  //   [1:v] scale → rgba → geq (per-pixel screen-subtract) → time-shift
  //   [0:v] base + [wkey] overlay (top-left)
  //   [1:a] adelay+volume → [wa]
  //   [0:a] (already has ducked music) + [wa] → amix
  const maxRB = `max(r(X,Y),b(X,Y))`;
  const spill = `max(0, g(X,Y) - ${maxRB})`;
  const fc = [
    `[1:v]scale=1080:1920,format=rgba,` +
      `geq=` +
        `r='r(X,Y)':` +
        `g='min(g(X,Y), ${maxRB})':` +
        `b='b(X,Y)':` +
        `a='255 - 255 * clip(${spill} / ${t}, 0, 1)',` +
      `setpts=PTS-STARTPTS+${overlayStartSec}/TB[wkey]`,
    `[0:v][wkey]overlay=x=0:y=0:format=auto[outv]`,
    `[1:a]adelay=${overlayMs}|${overlayMs},volume=${WASTED_AUDIO_GAIN}[wa]`,
    `[0:a][wa]amix=inputs=2:duration=longest:dropout_transition=0:normalize=0[outa]`,
  ].join(';');

  await spawnLogged('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'warning',
    '-i', basePath,
    '-i', overlayPath,
    '-filter_complex', fc,
    '-map', '[outv]', '-map', '[outa]',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', '-preset', 'veryfast',
    '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    outPath,
  ]);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { help(); process.exit(0); }

  const repoRoot = path.dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

  let mp4Path;
  let ndjsonPath;
  let inferredSeed = null;
  let inferredPreset = null;
  if (args.inMp4 || args.inNdjson) {
    if (!args.inMp4 || !args.inNdjson) {
      console.error('--in and --in-data must be passed together.');
      process.exit(1);
    }
    mp4Path = path.resolve(repoRoot, args.inMp4);
    ndjsonPath = path.resolve(repoRoot, args.inNdjson);
    const m = path.basename(mp4Path).match(/interwheel-seed(\d+)-([^.]+)\.mp4$/);
    if (m) { inferredSeed = Number(m[1]); inferredPreset = m[2]; }
  } else if (args.seed !== null && Number.isFinite(args.seed)) {
    const base = `interwheel-seed${args.seed}-${args.preset}`;
    mp4Path = path.resolve(repoRoot, DEFAULT_VIDEO_DIR, `${base}.mp4`);
    ndjsonPath = path.resolve(repoRoot, DEFAULT_VIDEO_DIR, `${base}.ndjson`);
    inferredSeed = args.seed;
    inferredPreset = args.preset;
  } else {
    console.error('Pass --seed=N (with optional --preset=) or --in / --in-data.');
    process.exit(1);
  }

  for (const p of [mp4Path, ndjsonPath]) {
    if (!(await pathExists(p))) {
      console.error(`Missing input: ${path.relative(repoRoot, p)}`);
      console.error('Run `npm run video:interwheel` first, or pass --in / --in-data.');
      process.exit(1);
    }
  }

  // Race-condition guard: if make-video is still writing the source mp4 in
  // parallel, the file's moov atom may be present but the H.264 stream is
  // partial / mangled. Decoding it produces garbage frames in Remotion. Do a
  // full-frame walk via ffprobe before continuing.
  const health = await ffprobeStreamHealthy(mp4Path);
  if (!health.ok) {
    console.error(`Source mp4 fails decode check: ${path.relative(repoRoot, mp4Path)}`);
    console.error(`  ffprobe: ${health.error}`);
    console.error('Wait for `npm run video:interwheel` to finish, then retry.');
    process.exit(1);
  }

  // Refresh the Remotion public/latest/ copies.
  const linkDir = path.resolve(repoRoot, REMOTION_DIR, REMOTION_LATEST_REL);
  const mp4Link = path.join(linkDir, 'game.mp4');
  const ndjsonLink = path.join(linkDir, 'game.ndjson');
  await ensureFileCopy(mp4Path, mp4Link);
  await ensureFileCopy(ndjsonPath, ndjsonLink);
  console.log(`Copied → ${path.relative(repoRoot, mp4Link)}  (from ${path.relative(repoRoot, mp4Path)})`);
  console.log(`Copied → ${path.relative(repoRoot, ndjsonLink)}  (from ${path.relative(repoRoot, ndjsonPath)})`);

  const sidecar = await readSidecar(ndjsonPath);
  const sidecarFrames = sidecar.length;
  const sidecarDurationSec = sidecarFrames / FPS;
  console.log(`Sidecar: ${sidecarFrames} frames (${sidecarDurationSec.toFixed(2)}s)`);

  // Find the death frame (first row where endingStarted=true).
  let deathFrame = null;
  for (let i = 0; i < sidecar.length; i += 1) {
    if (sidecar[i].events?.endingStarted) { deathFrame = i; break; }
  }

  const wastedLeadFrames = Math.max(0, Math.round(args.wastedLeadSec * FPS));

  // WASTED overlay: probe duration so we can extend the base render and time
  // the post-step overlay correctly.
  let wastedOverlayPath = null;
  let wastedDurationSec = 0;
  if (!args.noWasted) {
    const wastedAbs = path.resolve(repoRoot, args.wastedOverlay);
    if (await pathExists(wastedAbs)) {
      wastedOverlayPath = wastedAbs;
      wastedDurationSec = await ffprobeDuration(wastedAbs);
      console.log(
        `WASTED overlay: ${path.relative(repoRoot, wastedAbs)} ` +
        `(${wastedDurationSec.toFixed(2)}s, lead ${args.wastedLeadSec}s)`,
      );
    } else {
      console.warn(`WASTED overlay not found at ${wastedAbs} — rendering without stinger.`);
    }
  }

  // Compute total composition frames so the full WASTED overlay plays out.
  let totalFrames = sidecarFrames;
  let wastedSeqStartFrame = null;
  if (deathFrame != null && wastedOverlayPath && wastedDurationSec > 0) {
    wastedSeqStartFrame = Math.max(0, deathFrame - wastedLeadFrames);
    const wastedEnd = wastedSeqStartFrame + Math.round(wastedDurationSec * FPS);
    const cappedWastedEnd = Math.min(
      wastedEnd,
      wastedSeqStartFrame + Math.round(MAX_WASTED_TAIL_SEC * FPS),
    );
    totalFrames = Math.max(totalFrames, cappedWastedEnd);
  }
  const totalDurationSec = totalFrames / FPS;
  if (totalFrames > sidecarFrames) {
    console.log(
      `Extending composition to ${totalFrames} frames (${totalDurationSec.toFixed(2)}s) ` +
      `so the WASTED overlay plays through.`,
    );
  }

  // Background music: copy alongside the game files so Studio sees it too.
  let musicStaticPath = null;
  let musicStartSec = 0;
  if (!args.noMusic) {
    const musicAbs = path.resolve(repoRoot, args.musicFile);
    if (await pathExists(musicAbs)) {
      const musicExt = path.extname(musicAbs).toLowerCase() || '.opus';
      const musicLink = path.join(linkDir, `music${musicExt}`);
      await ensureFileCopy(musicAbs, musicLink);
      musicStaticPath = `latest/music${musicExt}`;
      const musicDurationSec = await ffprobeDuration(musicAbs);
      const tailOffset = Math.max(0, args.musicTailOffsetSec || 0);
      if (args.musicMode === 'end') {
        const musicEndSec = Math.max(0, musicDurationSec - tailOffset);
        musicStartSec = Math.max(0, musicEndSec - totalDurationSec);
      } else {
        musicStartSec = 0;
      }
      console.log(
        `Music: ${path.relative(repoRoot, musicAbs)} (${musicDurationSec.toFixed(2)}s) — ` +
        `mode=${args.musicMode}` +
        (args.musicMode === 'end' ? `, tailOffset=${tailOffset}s` : '') +
        `, startFrom=${musicStartSec.toFixed(2)}s`,
      );
    } else {
      console.warn(`Music not found at ${musicAbs} — rendering without music.`);
    }
  }

  if (args.studio) {
    console.log('\nFiles refreshed. Launch Remotion Studio with:');
    console.log('  cd remotion && npm run studio');
    console.log('Note: WASTED overlay is applied via ffmpeg post-step and is not visible in Studio.');
    return;
  }

  const seedTag = inferredSeed != null ? `seed${inferredSeed}` : path.basename(mp4Path, '.mp4');
  const presetTag = inferredPreset ?? 'unknown';
  const vid = args.vid ?? `${seedTag}-${presetTag}-${timestampSlug()}`;
  const renderDir = path.resolve(repoRoot, args.rendersDir, vid);
  await mkdir(renderDir, { recursive: true });

  // Archive the source mp4 + sidecar inside the render folder so each render
  // is fully self-contained.
  const archivedMp4 = path.join(renderDir, path.basename(mp4Path));
  const archivedNdjson = path.join(renderDir, path.basename(ndjsonPath));
  await copyFile(mp4Path, archivedMp4);
  await copyFile(ndjsonPath, archivedNdjson);

  const shortName = inferredSeed != null
    ? `interwheel-seed${inferredSeed}-short.mp4`
    : `${path.basename(mp4Path, '.mp4')}-short.mp4`;
  const shortPath = path.join(renderDir, shortName);

  // The base render is the Remotion output before the WASTED overlay is
  // composited on. We delete it once the post-step succeeds.
  const basePath = wastedOverlayPath
    ? path.join(renderDir, `${path.basename(shortPath, '.mp4')}.base.mp4`)
    : shortPath;

  console.log(`\nRendering 1080x1920 base → ${path.relative(repoRoot, basePath)}`);
  const lastFrame = Math.max(0, totalFrames - 1);
  const inputProps = {
    gameVideoSrc: 'latest/game.mp4',
    sidecarSrc: 'latest/game.ndjson',
    musicSrc: musicStaticPath,
    musicStartSec,
    musicDuckStartFrame: wastedSeqStartFrame,
  };
  await spawnLogged('npx', [
    'remotion', 'render',
    'src/index.ts', 'InterwheelShort',
    basePath,
    `--frames=0-${lastFrame}`,
    `--props=${JSON.stringify(inputProps)}`,
  ], {
    cwd: path.resolve(repoRoot, REMOTION_DIR),
  });

  if (wastedOverlayPath) {
    const overlayStartSec = (wastedSeqStartFrame ?? 0) / FPS;
    console.log(
      `\nCompositing WASTED overlay (chromakey, audio mix) → ${path.relative(repoRoot, shortPath)}`,
    );
    await compositeWastedOverlay({
      basePath,
      overlayPath: wastedOverlayPath,
      outPath: shortPath,
      overlayStartSec,
      greenThreshold: args.greenThreshold,
    });
    await unlink(basePath);
  }

  // Walk the sidecar for landmark frames worth recording in metadata.
  let endingTick = null;
  let drownedTick = null;
  let explodedTick = null;
  for (const row of sidecar) {
    if (endingTick === null && row.events?.endingStarted) endingTick = row.tick;
    if (drownedTick === null && row.events?.drowned) drownedTick = row.tick;
    if (explodedTick === null && row.events?.exploded) explodedTick = row.tick;
  }
  const last = sidecar[sidecar.length - 1] ?? null;

  const metadata = {
    vid,
    renderedAt: new Date().toISOString(),
    seed: inferredSeed,
    preset: inferredPreset,
    sourceMp4: path.relative(repoRoot, mp4Path),
    sourceNdjson: path.relative(repoRoot, ndjsonPath),
    short: {
      file: path.basename(shortPath),
      width: 1080,
      height: 1920,
      fps: 40,
      frames: totalFrames,
    },
    run: {
      frames: sidecarFrames,
      endingTick,
      drownedTick,
      explodedTick,
      finalScore: last?.score ?? null,
      finalHeightM: last?.heightM ?? null,
      finalState: last?.blob?.state ?? null,
    },
    audio: {
      music: musicStaticPath ? {
        source: path.relative(repoRoot, path.resolve(repoRoot, args.musicFile)),
        mode: args.musicMode,
        tailOffsetSec: args.musicMode === 'end' ? args.musicTailOffsetSec : null,
        startSec: musicStartSec,
        duckStartFrame: wastedSeqStartFrame,
      } : null,
      wasted: wastedOverlayPath ? {
        source: path.relative(repoRoot, wastedOverlayPath),
        durationSec: wastedDurationSec,
        leadSec: args.wastedLeadSec,
        overlayStartSec: (wastedSeqStartFrame ?? 0) / FPS,
        keying: {
          algorithm: 'screen-subtract',
          greenThreshold: args.greenThreshold,
        },
        audioGain: WASTED_AUDIO_GAIN,
      } : null,
    },
  };
  await writeFile(path.join(renderDir, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');

  console.log(`\nDone.`);
  console.log(`  ${path.relative(repoRoot, renderDir)}/`);
  console.log(`    ${path.basename(shortPath)}`);
  console.log(`    ${path.basename(archivedMp4)}`);
  console.log(`    ${path.basename(archivedNdjson)}`);
  console.log(`    metadata.json`);
}

main().catch((err) => {
  console.error('compose-short failed:', err);
  process.exit(1);
});
