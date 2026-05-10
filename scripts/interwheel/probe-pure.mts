#!/usr/bin/env tsx
// Pure-Node Interwheel probe. Imports the simulator and planner directly from
// src/, applies the SCENE_PRESETS.video recipe, and runs the headless game
// loop without a browser. Emits one JSON object per seed on stdout in
// completion order (so callers can stream-consume and stop early when a
// match is found).
//
// Why this exists: until now every "headless" tool (study.mjs, make-video.mjs
// probe, analyze-interwheel.mjs) launched Chromium and ran sim+planner via
// page.evaluate. That works but spends startup on browser+Pixi and limits
// parallelism to "one Chromium page per worker". This path is the same code
// minus the Pixi/DOM seam, parallelised with worker_threads.
//
// Parity vs the browser path: pre-death trajectories are bit-identical;
// during a death sequence cosmetics consume Math.random in the browser path
// only, drifting the final blob.y by ~0.013 px (sub-pixel, irrelevant for
// probe purposes). All summary fields (ticks, endingTick, ended, height,
// score) match exactly. See scripts/interwheel/probe-browser.mjs for the
// matching browser-side oracle used to validate this.
//
// Usage:
//   npx tsx scripts/interwheel/probe-pure.mts --seed=4200
//   npx tsx scripts/interwheel/probe-pure.mts --seed-base=4200 --count=20
//   npx tsx scripts/interwheel/probe-pure.mts --seed-base=4200 --count=50 \
//     --concurrency=8 --max-seconds=54

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

import { InterwheelSim } from '../../src/games/interwheel/sim.ts';
import { makeSeededRng } from '../../src/playground/interwheel-edge-validator.ts';
import {
  InterwheelPlanner,
  PLANNER_PERCEPTION_DEFAULTS,
  PLANNER_SEARCH_DEFAULTS,
  type PlannerPolicy,
} from '../../src/playground/interwheel-planner.ts';
import {
  applyScenePresetToSim,
  policyFromFocus,
  SCENE_PRESETS,
  type ScenePresetName,
} from '../../src/playground/scene-presets.ts';

const GAME_FPS = 40;

type Args = {
  seedBase: number;
  count: number;
  maxSeconds: number;
  preset: ScenePresetName;
  hash: 'none' | 'final' | 'full';
  concurrency: number;
  printTrajectory: boolean;
  worker: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seedBase: 4200,
    count: 1,
    maxSeconds: 60,
    preset: 'video',
    hash: 'none',
    concurrency: 1,
    printTrajectory: false,
    worker: false,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw === '--worker') args.worker = true;
    else if (raw.startsWith('--seed=')) { args.seedBase = Number(raw.slice('--seed='.length)); args.count = 1; }
    else if (raw.startsWith('--seed-base=')) args.seedBase = Number(raw.slice('--seed-base='.length));
    else if (raw.startsWith('--count=')) args.count = Number(raw.slice('--count='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length) as ScenePresetName;
    else if (raw.startsWith('--hash=')) args.hash = raw.slice('--hash='.length) as Args['hash'];
    else if (raw.startsWith('--concurrency=')) args.concurrency = Number(raw.slice('--concurrency='.length));
    else if (raw === '--print-trajectory') args.printTrajectory = true;
    else throw new Error(`Unknown arg: ${raw}`);
  }
  args.concurrency = Math.max(1, Math.min(args.concurrency, args.count, availableParallelism()));
  return args;
}

function help(): void {
  console.log(`Pure-Node Interwheel probe

USAGE:
  npx tsx scripts/interwheel/probe-pure.mts --seed=4200
  npx tsx scripts/interwheel/probe-pure.mts --seed-base=4200 --count=50 --concurrency=8

OPTIONS:
  --seed=N            Single seed (sets --count=1).
  --seed-base=N       First seed in a sweep. Default 4200.
  --count=N           How many consecutive seeds to probe. Default 1.
  --max-seconds=N     Hard cap per probe in simulated seconds. Default 60.
                      Set this to your window's UPPER bound to skip pointless
                      tail work on surviving seeds.
  --preset=NAME       SCENE_PRESETS key. Default "video".
  --hash=MODE         "none" | "final" | "full". Default "none".
  --concurrency=N     Worker subprocesses. Default 1. Capped by --count and CPU count.
  --print-trajectory  Dump per-tick blob/water state to stderr (debug, single thread only).

Output: one JSON object per seed on stdout, in COMPLETION order (parallel
runs may interleave). Schema:
  { seed, ticks, endingTick, ended, heightMeters, score, hash, planMs, wallMs }
`);
}

// FNV-1a 32-bit. Hashes a synthetic byte stream of (tick, blob.x, blob.y,
// blob.vx, blob.vy, blob.state, waterY, score, press) so any single divergent
// step shows up as a different final hash.
class TrajectoryHasher {
  private h = 0x811c9dc5 >>> 0;
  private buf = new ArrayBuffer(8);
  private f64 = new Float64Array(this.buf);
  private u32 = new Uint32Array(this.buf);
  push(value: number): void {
    this.f64[0] = value;
    this.mix(this.u32[0]!);
    this.mix(this.u32[1]!);
  }
  private mix(x: number): void {
    let h = this.h;
    for (let i = 0; i < 4; i += 1) {
      h ^= (x >>> (i * 8)) & 0xff;
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.h = h;
  }
  digest(): string {
    return this.h.toString(16).padStart(8, '0');
  }
}

type ProbeResult = {
  seed: number;
  ticks: number;
  endingTick: number;
  ended: boolean;
  heightMeters: number;
  score: number;
  blob: { x: number; y: number; vx: number; vy: number; state: number };
  waterY: number;
  hash: string | null;
  planMs: { total: number; max: number };
  wallMs: number;
};

function probeSeed(seed: number, args: Args): ProbeResult {
  const t0 = performance.now();
  const preset = SCENE_PRESETS[args.preset];
  if (!preset) throw new Error(`Unknown preset: ${args.preset}`);

  // World overrides — same as clicking the scene-preset button in the playground.
  applyScenePresetToSim(preset);

  // Sim reset. Mirrors the playground's wrapped reset: scene overrides are
  // staged in the sim module's globals (above), then reset() runs with a
  // seeded RNG so wheel layout / pastille placement / mines are reproducible.
  const sim = new InterwheelSim();
  const resetRng = makeSeededRng(seed);
  // Some sim init paths (and the game class's buildDecor in live play) call
  // Math.random directly; bridge it onto the seeded stream for reset to
  // match the playground exactly. Only matters for code paths *outside*
  // sim.ts that consult Math.random during reset; sim.ts itself uses the
  // explicit rng arg.
  const savedRandom = Math.random;
  Math.random = resetRng;
  try {
    sim.reset(resetRng);
  } finally {
    Math.random = savedRandom;
  }

  // Planner. Use the playground defaults, then apply the preset's overrides.
  const lookahead = preset.lookaheadScreens ?? PLANNER_PERCEPTION_DEFAULTS.revealScreensAbove;
  const policy: PlannerPolicy = preset.focus !== undefined
    ? policyFromFocus(preset.focus)
    : { climb: 1.0, wall: 0.5, pastille: 0.0 };
  const planner = new InterwheelPlanner(sim, {
    policy,
    revealScreensAbove: lookahead,
    maxEdgeRollouts: preset.searchLimits?.maxEdgeRollouts ?? PLANNER_SEARCH_DEFAULTS.maxEdgeRollouts,
    maxStableDepth: preset.searchLimits?.maxStableDepth ?? PLANNER_SEARCH_DEFAULTS.maxStableDepth,
    budgetMs: preset.searchLimits?.budgetMs ?? PLANNER_SEARCH_DEFAULTS.budgetMs,
    // Headless probe doesn't render the candidate-line overlay and doesn't
    // consume planner diagnostics — both default to false here so the
    // lineage-support / segment-build / diagnostics passes are skipped.
    collectSegments: false,
    collectDiagnostics: false,
  });

  // Post-reset RNG: a fresh seeded stream for sim.step's per-tick draws.
  // The playground's reseedGame() does the equivalent — two independent
  // mulberry32 streams seeded with the same `seed`.
  const stepRng = makeSeededRng(seed);

  // Tick loop. Mirror the playground's reseedGame path: pendingPress starts
  // null (no plan ran before tick 1), so tick 1 has press=false. After each
  // sim.step, plan for the next tick.
  const hasher = args.hash !== 'none' ? new TrajectoryHasher() : null;
  const maxTicks = Math.max(1, Math.round(args.maxSeconds * GAME_FPS));
  let ticks = 0;
  let endingTick = -1;
  let pendingPress: boolean | null = null;
  let totalPlanMs = 0;
  let maxPlanMs = 0;
  while (!sim.ended && ticks < maxTicks) {
    const press = pendingPress ?? false;
    pendingPress = null;
    if (press) sim.spacePressed = true;
    sim.step(false, stepRng);
    ticks += 1;
    if (endingTick < 0 && sim.ending) endingTick = ticks;

    if (hasher && (args.hash === 'full' || sim.ended)) {
      hasher.push(ticks);
      hasher.push(sim.blob.x);
      hasher.push(sim.blob.y);
      hasher.push(sim.blob.vx);
      hasher.push(sim.blob.vy);
      hasher.push(sim.blob.state);
      hasher.push(sim.waterY);
      hasher.push(sim.score);
      hasher.push(press ? 1 : 0);
    }

    if (args.printTrajectory) {
      process.stderr.write(`t=${ticks} x=${sim.blob.x.toFixed(2)} y=${sim.blob.y.toFixed(2)} vy=${sim.blob.vy.toFixed(3)} state=${sim.blob.state} waterY=${sim.waterY.toFixed(2)} score=${sim.score} press=${press}\n`);
    }

    if (sim.ended) break;

    const tPlan0 = performance.now();
    const result = planner.step();
    const dt = performance.now() - tPlan0;
    totalPlanMs += dt;
    if (dt > maxPlanMs) maxPlanMs = dt;
    pendingPress = result.press;
  }

  return {
    seed,
    ticks,
    endingTick,
    ended: sim.ended,
    heightMeters: Math.floor(sim.maxHeight * 0.2),
    score: sim.score,
    blob: { x: sim.blob.x, y: sim.blob.y, vx: sim.blob.vx, vy: sim.blob.vy, state: sim.blob.state },
    waterY: sim.waterY,
    hash: hasher?.digest() ?? null,
    planMs: { total: Number(totalPlanMs.toFixed(2)), max: Number(maxPlanMs.toFixed(2)) },
    wallMs: Number((performance.now() - t0).toFixed(1)),
  };
}

// ----------------------------------------------------------------------------
// Master loop: spawn N child processes (each running this same script with
// --worker), distribute seeds round-robin via stdin JSON-lines, collect
// results from each child's stdout. We use child_process rather than
// worker_threads because Node's worker_threads + tsx loader interaction
// drops nested .ts resolutions in the worker's module graph (the loader is
// invoked but its resolve hook isn't applied to imports inside imported
// .ts files). Subprocess startup is ~1s per worker; for sweeps of 50+ seeds
// this is amortised well below the per-probe cost (~13s).
// ----------------------------------------------------------------------------

type ChildHandle = {
  proc: ReturnType<typeof spawn>;
  inflight: number | null;     // seed currently being probed, or null if idle
  stdout: ReturnType<typeof createInterface>;
};

async function runMaster(args: Args): Promise<void> {
  // Stop quietly when the consumer closes our stdout (e.g. piped to head,
  // or make-video.mjs found a GREEN seed and is shutting us down).
  process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  });

  // Forward termination signals to children so workers don't outlive us.
  // Without this, SIGTERM to the master leaves CPU-bound workers running
  // until they finish their current probe.
  let activeChildren: ChildHandle[] = [];
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      for (const c of activeChildren) c.proc.kill(sig);
      process.exit(0);
    });
  }

  if (args.concurrency === 1) {
    // Fast path: skip subprocess overhead entirely. Useful for --seed=N.
    for (let i = 0; i < args.count; i += 1) {
      const result = probeSeed(args.seedBase + i, args);
      process.stdout.write(JSON.stringify(result) + '\n');
    }
    return;
  }

  const total = args.count;
  let nextOffset = 0;
  let emitted = 0;
  const scriptPath = fileURLToPath(import.meta.url);

  const workerArgs = [
    '--worker',
    `--max-seconds=${args.maxSeconds}`,
    `--preset=${args.preset}`,
    `--hash=${args.hash}`,
  ];

  const children: ChildHandle[] = activeChildren;

  // execArgv: forward only the tsx loader flags from this process so the
  // child boots with the same TS resolution. `--require/--import` already
  // live in process.execArgv when we're being run by `npx tsx`.
  const loaderArgv = process.execArgv.filter((arg, i, arr) => {
    if (arg === '--require' || arg === '--import') return true;
    const prev = arr[i - 1];
    return prev === '--require' || prev === '--import';
  });

  await new Promise<void>((resolve, reject) => {
    const dispatch = (child: ChildHandle): void => {
      if (nextOffset < total) {
        const seed = args.seedBase + nextOffset;
        nextOffset += 1;
        child.inflight = seed;
        child.proc.stdin!.write(JSON.stringify({ seed }) + '\n');
      } else {
        child.proc.stdin!.end();
      }
    };

    for (let i = 0; i < args.concurrency; i += 1) {
      const proc = spawn(process.execPath, [...loaderArgv, scriptPath, ...workerArgs], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      const stdout = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
      const child: ChildHandle = { proc, inflight: null, stdout };
      children.push(child);

      stdout.on('line', (line) => {
        if (!line) return;
        try {
          const result = JSON.parse(line) as ProbeResult;
          process.stdout.write(JSON.stringify(result) + '\n');
          emitted += 1;
          child.inflight = null;
          if (emitted >= total) {
            for (const c of children) c.proc.stdin!.end();
          } else {
            dispatch(child);
          }
        } catch (err) {
          reject(new Error(`Bad worker line: ${line} (${err})`));
        }
      });

      proc.on('error', reject);
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null && emitted < total) {
          reject(new Error(`Worker exited with code ${code}`));
          return;
        }
        if (children.every((c) => c.proc.exitCode !== null)) resolve();
      });

      // Prime the worker with its first seed.
      dispatch(child);
    }
  });
}

// ----------------------------------------------------------------------------
// Worker loop: read JSON lines from stdin (`{ "seed": N }`), run probeSeed,
// write the result JSON line to stdout. Loop until stdin closes.
// ----------------------------------------------------------------------------

async function runWorker(args: Args): Promise<void> {
  // Master may close our stdout before we finish writing (e.g. it found a
  // GREEN seed and is shutting the sweep down). Exit silently rather than
  // dumping a stack trace.
  process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  });
  const stdin = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of stdin) {
    if (!line.trim()) continue;
    const { seed } = JSON.parse(line) as { seed: number };
    const result = probeSeed(seed, args);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
}

// ----------------------------------------------------------------------------
// Entry point
// ----------------------------------------------------------------------------

const cliArgs = parseArgs(process.argv);
if (cliArgs.help) { help(); process.exit(0); }
if (cliArgs.worker) {
  await runWorker(cliArgs);
} else {
  await runMaster(cliArgs);
}
