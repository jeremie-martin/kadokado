#!/usr/bin/env tsx
// Pure-Node Interwheel probe. Imports the simulator and planner directly from
// src/, applies the SCENE_PRESETS.video recipe, and runs the headless game
// loop without a browser. Emits one JSON object per --seed on stdout so
// callers (make-video.mjs, parity tests) can consume cheaply.
//
// Why this exists: until now every "headless" tool (study.mjs, make-video.mjs
// probe, analyze-interwheel.mjs) launched Chromium and ran sim+planner via
// page.evaluate. That's correct but slow; this path is the same code minus
// the Pixi/DOM seam. Parity is enforced by analyze-interwheel.spec.ts at the
// `parityCheck()` level — same sim, same planner, same RNG draws.
//
// Usage:
//   npx tsx scripts/interwheel/probe-pure.mts --seed=4200
//   npx tsx scripts/interwheel/probe-pure.mts --seed=4200 --max-seconds=60
//   npx tsx scripts/interwheel/probe-pure.mts --seed-base=4200 --count=20

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
  // Trajectory hash mode for parity: 'none' = just the summary,
  // 'final' = blob xy + waterY + score at last tick, 'full' = a tick-stream
  // hash so any single divergent step is detectable.
  hash: 'none' | 'final' | 'full';
  printTrajectory: boolean;
  help: boolean;
};

function parseArgs(argv: string[]): Args {
  const args: Args = {
    seedBase: 4200,
    count: 1,
    maxSeconds: 60,
    preset: 'video',
    hash: 'full',
    printTrajectory: false,
    help: false,
  };
  for (const raw of argv.slice(2)) {
    if (raw === '--help' || raw === '-h') args.help = true;
    else if (raw.startsWith('--seed=')) { args.seedBase = Number(raw.slice('--seed='.length)); args.count = 1; }
    else if (raw.startsWith('--seed-base=')) args.seedBase = Number(raw.slice('--seed-base='.length));
    else if (raw.startsWith('--count=')) args.count = Number(raw.slice('--count='.length));
    else if (raw.startsWith('--max-seconds=')) args.maxSeconds = Number(raw.slice('--max-seconds='.length));
    else if (raw.startsWith('--preset=')) args.preset = raw.slice('--preset='.length) as ScenePresetName;
    else if (raw.startsWith('--hash=')) args.hash = raw.slice('--hash='.length) as Args['hash'];
    else if (raw === '--print-trajectory') args.printTrajectory = true;
    else throw new Error(`Unknown arg: ${raw}`);
  }
  return args;
}

function help(): void {
  console.log(`Pure-Node Interwheel probe

USAGE:
  npx tsx scripts/interwheel/probe-pure.mts --seed=4200
  npx tsx scripts/interwheel/probe-pure.mts --seed-base=4200 --count=20

OPTIONS:
  --seed=N            Single seed (sets --count=1).
  --seed-base=N       First seed in a sweep. Default 4200.
  --count=N           How many consecutive seeds to probe. Default 1.
  --max-seconds=N     Hard cap per probe in simulated seconds. Default 60.
  --preset=NAME       SCENE_PRESETS key. Default "video".
  --hash=MODE         "none" | "final" | "full". Default "full".
  --print-trajectory  Dump per-tick blob/water state to stderr (debug).

Output: one JSON object per seed on stdout, one line each. Schema:
  { seed, ticks, endingTick, ended, heightMeters, score, hash, planMs }
`);
}

// FNV-1a 32-bit. We hash a synthetic byte stream of (tick, blob.x, blob.y,
// blob.vx, blob.vy, blob.state, waterY, score, press) so any single
// divergent step shows up as a different final hash. 32-bit is plenty —
// collision probability over 60s × 40fps = 2400 ticks is negligible.
class TrajectoryHasher {
  private h = 0x811c9dc5 >>> 0;
  push(value: number): void {
    // Reinterpret float bits via Float64 → two Uint32 limbs.
    const buf = new ArrayBuffer(8);
    new Float64Array(buf)[0] = value;
    const u = new Uint32Array(buf);
    this.mix(u[0]!);
    this.mix(u[1]!);
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
};

function probeSeed(seed: number, args: Args): ProbeResult {
  const preset = SCENE_PRESETS[args.preset];
  if (!preset) throw new Error(`Unknown preset: ${args.preset}`);

  // 1. World overrides — same as clicking the scene-preset button.
  applyScenePresetToSim(preset);

  // 2. Sim reset. Mirror the playground's wrapped reset: scene overrides
  //    are now staged in the sim module's globals, and reset() is invoked
  //    with a seeded RNG so wheel layout / pastille placement / mines are
  //    reproducible.
  const sim = new InterwheelSim();
  const resetRng = makeSeededRng(seed);
  // Some sim init code paths call Math.random directly; bridge it onto the
  // seeded stream for the duration of reset to match the playground exactly
  // (which wraps reset under `Math.random = makeSeededRng(seed)`).
  const savedRandom = Math.random;
  Math.random = resetRng;
  try {
    sim.reset(resetRng);
  } finally {
    Math.random = savedRandom;
  }

  // 3. Planner. Use the same defaults the playground uses, then apply the
  //    preset's overrides. The constructor takes lookahead + search limits
  //    via cfg; policy is set explicitly.
  const lookahead = preset.lookaheadScreens ?? PLANNER_PERCEPTION_DEFAULTS.revealScreensAbove;
  const searchLimits = {
    maxEdgeRollouts: preset.searchLimits?.maxEdgeRollouts ?? PLANNER_SEARCH_DEFAULTS.maxEdgeRollouts,
    maxStableDepth: preset.searchLimits?.maxStableDepth ?? PLANNER_SEARCH_DEFAULTS.maxStableDepth,
    budgetMs: preset.searchLimits?.budgetMs ?? PLANNER_SEARCH_DEFAULTS.budgetMs,
  };
  const policy: PlannerPolicy = preset.focus !== undefined
    ? policyFromFocus(preset.focus)
    : { climb: 1.0, wall: 0.5, pastille: 0.0 };
  const planner = new InterwheelPlanner(sim, {
    policy,
    revealScreensAbove: lookahead,
    maxEdgeRollouts: searchLimits.maxEdgeRollouts,
    maxStableDepth: searchLimits.maxStableDepth,
    budgetMs: searchLimits.budgetMs,
  });

  // 4. Post-reset RNG: a fresh seeded stream for sim.step's per-tick draws.
  //    The playground does the same — reseed is two independent mulberry32
  //    streams seeded with the same `seed`.
  const stepRng = makeSeededRng(seed);

  // 5. Tick loop. Mirror the playground's reseedGame path: pendingPress
  //    starts null (no plan ran before the first tick), so tick 1 has
  //    press=false. After each sim.step, plan for the next tick.
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

    const t0 = performance.now();
    const result = planner.step();
    const dt = performance.now() - t0;
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
  };
}

function main(): void {
  const args = parseArgs(process.argv);
  if (args.help) { help(); return; }

  for (let i = 0; i < args.count; i += 1) {
    const seed = args.seedBase + i;
    const t0 = performance.now();
    const result = probeSeed(seed, args);
    const wall = performance.now() - t0;
    process.stdout.write(JSON.stringify({ ...result, wallMs: Number(wall.toFixed(1)) }) + '\n');
  }
}

main();
