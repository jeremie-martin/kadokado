import { mount, type InterwheelGame, type InterwheelSim } from '../games/interwheel/index';
import { noopGameHost } from '../games/types';
import { InterwheelPlanner, type PlannerStats } from './interwheel-planner';

// Faithful headless bench harness.
//
// Goal: produce scores that are *identical* to what the live playground
// would produce. The AI is the production InterwheelPlanner with no
// configuration tweaks. The only deltas vs. the real playground are:
//
//   1. The Pixi `app.ticker` (RAF-paced) is stopped; we drive game.update()
//      back-to-back instead. Saves the ~14ms of idle wait per 25ms frame
//      when AI compute leaves slack.
//   2. `game.render` and `game.updateParticles` are no-op'd. Both only
//      mutate Pixi display objects — they never touch gameplay state.
//
// Everything else — wheel rotation, mine collision, blob physics, pastille
// pickup, spark scoring, water rise — runs the unmodified production code
// path. A `parityCheck()` function below verifies on-page that the same
// starting state + same press sequence produces an identical end state
// with rendering on vs off.

const out = document.getElementById('out') as HTMLPreElement;
const runBtn = document.getElementById('run') as HTMLButtonElement;
const run100Btn = document.getElementById('run100') as HTMLButtonElement;
const detBtn = document.getElementById('determinism') as HTMLButtonElement;
const stage = document.getElementById('hidden-stage') as HTMLDivElement;

let game: InterwheelGame;
let planner: InterwheelPlanner;
let originalUpdate: () => void;
let originalRender: () => void;
let originalUpdateParticles: () => void;
let recordedPresses: boolean[] = [];
let recording = false;
let currentPlannerRun: PlannerRunStats | null = null;

type PlannerRunStats = {
  plans: number;
  totalPlanMs: number;
  maxPlanMs: number;
  totalEdges: number;
  totalSegments: number;
  totalWheels: number;
  totalPastilles: number;
};

type TrialPlannerStats = {
  plans: number;
  avgPlanMs: number;
  maxPlanMs: number;
  avgEdges: number;
  avgSegments: number;
  avgWheels: number;
  avgPastilles: number;
};

function log(msg: string): void {
  out.textContent = msg;
}

function append(msg: string): void {
  out.textContent = (out.textContent ?? '') + msg;
}

function freshPlannerRunStats(): PlannerRunStats {
  return {
    plans: 0,
    totalPlanMs: 0,
    maxPlanMs: 0,
    totalEdges: 0,
    totalSegments: 0,
    totalWheels: 0,
    totalPastilles: 0,
  };
}

function recordPlannerStats(stats: PlannerStats): void {
  if (!currentPlannerRun) return;
  currentPlannerRun.plans += 1;
  currentPlannerRun.totalPlanMs += stats.planMs;
  currentPlannerRun.maxPlanMs = Math.max(currentPlannerRun.maxPlanMs, stats.planMs);
  currentPlannerRun.totalEdges += stats.edgesEvaluated;
  currentPlannerRun.totalSegments += stats.segments;
  currentPlannerRun.totalWheels += stats.perceivedWheels;
  currentPlannerRun.totalPastilles += stats.perceivedPastilles;
}

function summarizePlannerStats(stats: PlannerRunStats): TrialPlannerStats {
  const plans = Math.max(1, stats.plans);
  return {
    plans: stats.plans,
    avgPlanMs: stats.totalPlanMs / plans,
    maxPlanMs: stats.maxPlanMs,
    avgEdges: stats.totalEdges / plans,
    avgSegments: stats.totalSegments / plans,
    avgWheels: stats.totalWheels / plans,
    avgPastilles: stats.totalPastilles / plans,
  };
}

async function setup(): Promise<void> {
  await mount(stage, {
    host: noopGameHost,
    onReady: (g) => {
      game = g as InterwheelGame;
      // Stash the originals so parityCheck() can swap rendering back on.
      originalRender = game.render.bind(game);
      originalUpdateParticles = game.updateParticles.bind(game);
      // Bench mode: skip purely-visual work.
      game.render = (() => {}) as typeof game.render;
      game.updateParticles = (() => {}) as typeof game.updateParticles;
      // Halt the RAF-paced ticker; we drive ticks by hand.
      game.app.ticker.stop();

      planner = new InterwheelPlanner(game.sim); // production defaults — no tweaks.
      originalUpdate = game.update.bind(game);
      game.update = () => {
        if (!game.ended && !game.ending) {
          const { press, result } = planner.step();
          if (press) game.spacePressed = true;
          if (result) recordPlannerStats(result.stats);
          if (recording) recordedPresses.push(press);
        }
        originalUpdate();
      };
    },
  });
  (window as unknown as { __game__: InterwheelGame; __planner__: InterwheelPlanner }).__game__ = game;
  (window as unknown as { __game__: InterwheelGame; __planner__: InterwheelPlanner }).__planner__ = planner;
}

type TrialResult = {
  score: number;
  heightMeters: number;
  ticks: number;
  cpuMs: number;
  planner: TrialPlannerStats;
  /** The seed used for this trial's level generation, or null if Math.random was used. */
  seed: number | null;
};

async function runTrial(seed: number | null = null, maxTicks = 24_000): Promise<TrialResult> {
  if (seed !== null) {
    const savedRandom = Math.random;
    Math.random = makeSeededRng(seed);
    try {
      game.reset();
    } finally {
      Math.random = savedRandom;
    }
  } else {
    game.reset();
  }
  planner.invalidate();
  currentPlannerRun = freshPlannerRunStats();
  const startCpu = performance.now();
  let ticks = 0;
  while (!game.ended && ticks < maxTicks) {
    game.update();
    ticks += 1;
    // Yield occasionally so the browser stays responsive between trials.
    if ((ticks & 511) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return {
    score: game.score,
    heightMeters: Math.floor(game.maxHeight * 0.2),
    ticks,
    cpuMs: performance.now() - startCpu,
    planner: summarizePlannerStats(currentPlannerRun),
    seed,
  };
}

function summarize(label: string, results: TrialResult[]): string {
  const scores = statsOf(results.map((r) => r.score));
  const heights = statsOf(results.map((r) => r.heightMeters));
  const ticks = statsOf(results.map((r) => r.ticks));
  const cpuMs = statsOf(results.map((r) => r.cpuMs));
  const totalCpu = cpuMs.mean * results.length;
  return [
    `${label}: ${results.length} trials`,
    `  score    p10=${scores.p10} median=${scores.median} p90=${scores.p90} max=${scores.max} mean=${Math.round(scores.mean)}`,
    `  height_m p10=${heights.p10} median=${heights.median} p90=${heights.p90} max=${heights.max}`,
    `  ticks    p10=${ticks.p10} median=${ticks.median} p90=${ticks.p90} max=${ticks.max}`,
    `  cpu      mean=${Math.round(cpuMs.mean)}ms total=${Math.round(totalCpu)}ms (${(totalCpu / 1000).toFixed(2)}s)`,
  ].join('\n');
}

async function runBatch(n: number): Promise<TrialResult[]> {
  log(`Running ${n} trials with the production planner…\n`);
  const results: TrialResult[] = [];
  const wallStart = performance.now();
  for (let i = 0; i < n; i += 1) {
    const r = await runTrial();
    results.push(r);
    append(`  trial ${String(i + 1).padStart(3)}/${n}: score=${String(r.score).padStart(6)} height=${r.heightMeters}m ticks=${r.ticks} cpu=${Math.round(r.cpuMs)}ms\n`);
  }
  const wallMs = performance.now() - wallStart;
  append('\n' + summarize('SUMMARY', results) + `\n  wall     ${(wallMs / 1000).toFixed(2)}s\n`);
  return results;
}

// ============================================================================
// Programmatic benchmark API — meant to be invoked from the CLI bench script
// (scripts/bench.mjs). Returns rich statistics; height is the primary metric.
// ============================================================================

export type BenchmarkOpts = {
  /** Number of trials to run. Default 5. */
  trials?: number;
  /**
   * If set, trial i uses RNG seed (seedBase + i) for level generation.
   * Same seedBase + same trial count → identical levels across runs, so
   * AI changes can be A/B-compared on the same population. If omitted,
   * level generation uses Math.random (different levels each invocation).
   */
  seedBase?: number;
  /** Hard cap on ticks per trial. Default 24000 (= 10 in-game minutes at 40 Hz). */
  maxTicks?: number;
};

type Stats = {
  min: number;
  max: number;
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  stdev: number;
};

export type BenchmarkResult = {
  trials: TrialResult[];
  stats: { height_m: Stats; score: Stats; ticks: Stats; cpuMs: Stats };
  config: {
    trials: number;
    seedBase: number | null;
    maxTicks: number;
    plannerConfig: { budgetMs: number; maxEdgeRollouts: number; maxStableDepth: number; targetClimb: number };
  };
  wallMs: number;
  cpuMs: number;
};

function statsOf(values: number[]): Stats {
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const variance = sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n);
  const at = (frac: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(frac * n)))];
  return {
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median: at(0.5),
    p10: at(0.1),
    p25: at(0.25),
    p75: at(0.75),
    p90: at(0.9),
    stdev: Math.sqrt(variance),
  };
}

async function runBenchmark(opts: BenchmarkOpts = {}): Promise<BenchmarkResult> {
  const trials = Math.max(1, opts.trials ?? 5);
  const seedBase = opts.seedBase ?? null;
  const maxTicks = opts.maxTicks ?? 24_000;
  const plannerCfg = {
    budgetMs: 5, maxEdgeRollouts: 240, maxStableDepth: 3, targetClimb: 400,
  };

  log(`benchmark: ${trials} trials  seedBase=${seedBase ?? 'random'}  maxTicks=${maxTicks}\n`);

  const results: TrialResult[] = [];
  const wallStart = performance.now();
  for (let i = 0; i < trials; i += 1) {
    const seed = seedBase !== null ? seedBase + i : null;
    const r = await runTrial(seed, maxTicks);
    results.push(r);
    append(
      `  trial ${String(i + 1).padStart(3)}/${trials}` +
        (seed !== null ? ` (seed=${seed})` : '') +
        `: height=${r.heightMeters}m  score=${r.score}  ticks=${r.ticks}  cpu=${Math.round(r.cpuMs)}ms` +
        `  plan=${r.planner.avgPlanMs.toFixed(2)}ms/${Math.round(r.planner.avgEdges)}e\n`,
    );
  }
  const wallMs = performance.now() - wallStart;
  const cpuMs = results.reduce((s, r) => s + r.cpuMs, 0);

  const stats = {
    height_m: statsOf(results.map((r) => r.heightMeters)),
    score: statsOf(results.map((r) => r.score)),
    ticks: statsOf(results.map((r) => r.ticks)),
    cpuMs: statsOf(results.map((r) => r.cpuMs)),
  };

  return {
    trials: results,
    stats,
    config: { trials, seedBase, maxTicks, plannerConfig: plannerCfg },
    wallMs,
    cpuMs,
  };
}

type TickSample = {
  tick: number;
  state: ReturnType<InterwheelSim['clone']>;
};

// Tiny seeded RNG (mulberry32) so we can `game.reset()` deterministically
// to the same level twice. Used only in parityCheck — production code uses
// Math.random as-is.
function makeSeededRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function parityCheck(): Promise<{
  bench: { score: number; height: number; ticks: number };
  full:  { score: number; height: number; ticks: number };
  equal: boolean;
  firstDivergence?: { tick: number; path: string; bench: unknown; full: unknown };
}> {
  log('Parity check: identical seeded level, same presses, render off vs render on…\n');

  const SEED = 0x12345678;
  const savedRandom = Math.random;

  // ----- Phase A — seeded reset (deterministic level), record a bench trial.
  Math.random = makeSeededRng(SEED);
  game.reset();
  Math.random = savedRandom;
  planner.invalidate();
  recordedPresses = [];
  recording = true;
  const benchSamples: TickSample[] = [];
  const sampleInto = (out: TickSample[]) => {
    out.push({ tick: game.tick, state: game.sim.clone() });
  };
  // Use the existing wrapped update; sample after each tick.
  let ticks = 0;
  while (!game.ended && ticks < 24_000) {
    game.update();
    sampleInto(benchSamples);
    ticks += 1;
    if ((ticks & 511) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  recording = false;
  const presses = recordedPresses.slice();
  const bench = {
    score: game.score,
    height: Math.round(game.maxHeight * 1000) / 1000,
    ticks: game.tick,
  };

  // ----- Phase B — same seeded reset (identical level), swap rendering
  // back on, replay the exact same press sequence WITHOUT the AI. Sample
  // tick-by-tick.
  game.render = originalRender;
  game.updateParticles = originalUpdateParticles;
  game.update = originalUpdate;
  Math.random = makeSeededRng(SEED);
  game.reset();
  Math.random = savedRandom;
  const fullSamples: TickSample[] = [];
  for (const p of presses) {
    if (p) game.spacePressed = true;
    game.update();
    sampleInto(fullSamples);
    if (game.ended) break;
  }
  // Phase A's recording skips the ending phase (the AI doesn't run during
  // those ~30 ticks). Drain that tail here so Phase B reaches the same
  // ended-state Phase A did. Cap by Phase A's sample count rather than a
  // fixed tick budget — Phase A's loop runs up to 24k ticks, and a stale
  // smaller cap here would silently mask real divergences as length deltas.
  while (!game.ended && fullSamples.length < benchSamples.length) {
    game.update();
    sampleInto(fullSamples);
  }
  const full = {
    score: game.score,
    height: Math.round(game.maxHeight * 1000) / 1000,
    ticks: game.tick,
  };

  // Restore bench wrappers so subsequent button clicks still work.
  game.render = (() => {}) as typeof game.render;
  game.updateParticles = (() => {}) as typeof game.updateParticles;
  game.update = (() => {
    if (!game.ended && !game.ending) {
      const { press, result } = planner.step();
      if (press) game.spacePressed = true;
      if (result) recordPlannerStats(result.stats);
      if (recording) recordedPresses.push(press);
    }
    originalUpdate();
  }) as typeof game.update;

  // Deep-compare each tick's full sim-state snapshot. Walks the whole
  // structure and reports the first path that differs.
  type Diff = { tick: number; path: string; bench: unknown; full: unknown };
  let firstDivergence: Diff | undefined;
  const findDiff = (a: unknown, b: unknown, path: string): { path: string; a: unknown; b: unknown } | null => {
    if (a === b) return null;
    if (typeof a === 'number' && typeof b === 'number') {
      if (Math.abs(a - b) < 1e-9) return null;
      return { path, a, b };
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return { path: `${path}.length`, a: a.length, b: b.length };
      for (let i = 0; i < a.length; i += 1) {
        const sub = findDiff(a[i], b[i], `${path}[${i}]`);
        if (sub) return sub;
      }
      return null;
    }
    if (a && b && typeof a === 'object' && typeof b === 'object') {
      const ka = Object.keys(a as object).sort();
      const kb = Object.keys(b as object).sort();
      if (ka.join('|') !== kb.join('|')) return { path: `${path}.keys`, a: ka, b: kb };
      for (const k of ka) {
        const sub = findDiff((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
        if (sub) return sub;
      }
      return null;
    }
    return { path, a, b };
  };
  const minLen = Math.min(benchSamples.length, fullSamples.length);
  for (let i = 0; i < minLen; i += 1) {
    const d = findDiff(benchSamples[i].state, fullSamples[i].state, '');
    if (d) {
      firstDivergence = { tick: benchSamples[i].tick, path: d.path, bench: d.a, full: d.b };
      break;
    }
  }

  const equal =
    bench.score === full.score &&
    bench.ticks === full.ticks &&
    Math.abs(bench.height - full.height) < 1e-6 &&
    !firstDivergence;

  append(`bench (render off): score=${bench.score} height=${bench.height} ticks=${bench.ticks}\n`);
  append(`full  (render on ): score=${full.score} height=${full.height} ticks=${full.ticks}\n`);
  append(`presses.length=${presses.length}  benchSamples.length=${benchSamples.length}  fullSamples.length=${fullSamples.length}\n`);
  if (benchSamples.length > 0) {
    const last = benchSamples[benchSamples.length - 1];
    append(`bench last sample: tick=${last.tick} ended=${last.state.ended} ending=${last.state.ending} endTimer=${last.state.endTimer}\n`);
  }
  if (fullSamples.length > 0) {
    const last = fullSamples[fullSamples.length - 1];
    append(`full  last sample: tick=${last.tick} ended=${last.state.ended} ending=${last.state.ending} endTimer=${last.state.endTimer}\n`);
  }
  append(`equal: ${equal}\n`);
  if (firstDivergence) {
    const d = firstDivergence;
    append(`first divergence at tick ${d.tick} path "${d.path}" — bench=${JSON.stringify(d.bench)} full=${JSON.stringify(d.full)}\n`);
  }
  return { bench, full, equal, firstDivergence };
}

(async () => {
  log('Booting Interwheel…');
  await setup();
  log('Ready. Click a button.');
  runBtn.addEventListener('click', () => void runBatch(20));
  run100Btn.addEventListener('click', () => void runBatch(100));
  detBtn.addEventListener('click', () => void parityCheck());
  // Expose a programmatic API for Playwright + the CLI bench script.
  (window as unknown as {
    __bench__: {
      runBatch: typeof runBatch;
      runTrial: typeof runTrial;
      runBenchmark: typeof runBenchmark;
      parityCheck: typeof parityCheck;
    };
  }).__bench__ = { runBatch, runTrial, runBenchmark, parityCheck };
})().catch((err) => {
  log(`Boot failed: ${err}`);
  console.error(err);
});
