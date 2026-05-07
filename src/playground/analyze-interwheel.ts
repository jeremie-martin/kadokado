import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  BLOB_STATE_GRAB,
  BLOB_STATE_WALL,
  mount,
  type InterwheelGame,
  type InterwheelSim,
  type SimSnapshot,
} from '../games/interwheel/index';
import { FPS, InterwheelSim as PureInterwheelSim, SCORE_PASTILLE, type SimEvents } from '../games/interwheel/sim';
import { noopGameHost } from '../games/types';
import {
  emptyScoreBreakdown,
  InterwheelPlanner,
  resolvePlannerPolicy,
  type CandidateScoreBreakdown,
  type PlannerConfig,
  type PlannerPolicy,
  type PlannerStats,
} from './interwheel-planner';

// Faithful headless analytics harness.
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
// Everything else - wheel rotation, mine collision, blob physics, pastille
// pickup, spark scoring, water rise — runs the unmodified production code
// path. A `parityCheck()` function below verifies on-page that the same
// starting state + same press sequence produces an identical end state
// with rendering on vs off.

const out = document.getElementById('out') as HTMLPreElement;
const runBtn = document.getElementById('run') as HTMLButtonElement;
const run100Btn = document.getElementById('run100') as HTMLButtonElement;
const detBtn = document.getElementById('determinism') as HTMLButtonElement;
const stage = document.getElementById('hidden-stage') as HTMLDivElement;
const ANALYTICS_PLANNER_CONFIG = {
  budgetMs: 5,
  maxEdgeRollouts: 240,
  maxStableDepth: 3,
  targetClimb: 400,
  collectSegments: false,
} satisfies PlannerConfig;

function plannerConfigForPolicy(policy: Partial<PlannerPolicy> = {}): PlannerConfig {
  return {
    ...ANALYTICS_PLANNER_CONFIG,
    policy: resolvePlannerPolicy(policy),
  };
}

let game: InterwheelGame;
let planner: InterwheelPlanner;
let originalUpdate: () => void;
let originalRender: () => void;
let originalUpdateParticles: () => void;
let recordedPresses: boolean[] = [];
let recording = false;
let currentPlannerRun: PlannerRunStats | null = null;
let currentAnalytics: InterwheelRunAnalytics | null = null;

type DeepDiff = { path: string; a: unknown; b: unknown };

type PlannerRunStats = {
  plans: number;
  totalPlanMs: number;
  maxPlanMs: number;
  totalEdges: number;
  totalSegments: number;
  totalWheels: number;
  totalPastilles: number;
  totalScoreBreakdown: CandidateScoreBreakdown;
};

type TrialPlannerStats = {
  plans: number;
  avgPlanMs: number;
  maxPlanMs: number;
  avgEdges: number;
  avgSegments: number;
  avgWheels: number;
  avgPastilles: number;
  avgScoreBreakdown: CandidateScoreBreakdown;
};

type Stats = {
  count: number;
  total: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  p10: number;
  p25: number;
  p75: number;
  p90: number;
  p95: number;
  stdev: number;
};

type ScoreBreakdownStats = Record<keyof CandidateScoreBreakdown, Stats>;

type MovementExit = 'jump' | 'wallJump' | 'wheel' | 'wall' | 'death' | 'drown' | 'mine' | 'runEnd' | 'timeout' | 'unknown';
type JumpSource = 'wheel' | 'wall' | 'unknown';

type JumpEvent = {
  tick: number;
  timeSeconds: number;
  source: JumpSource;
  x: number;
  y: number;
  heightMeters: number;
  angle: number;
  wheelIdx?: number;
  wheelRay?: number;
  wheelSpeed?: number;
  wheelAngle?: number;
  stayTicksBeforeJump?: number;
  revolutionsBeforeJump?: number;
  wallSide?: -1 | 1;
  wallDriftTicksBeforeJump?: number;
  wallDriftYBeforeJump?: number;
};

type WheelStayEvent = {
  wheelIdx: number;
  startTick: number;
  endTick: number;
  durationTicks: number;
  durationSeconds: number;
  startAngle: number;
  endAngle: number;
  revolutions: number;
  startHeightMeters: number;
  endHeightMeters: number;
  exit: MovementExit;
};

type WallDriftEvent = {
  side: -1 | 1;
  startTick: number;
  endTick: number;
  durationTicks: number;
  durationSeconds: number;
  startY: number;
  endY: number;
  deltaY: number;
  exit: MovementExit;
};

type FlightEvent = {
  startTick: number;
  endTick: number;
  durationTicks: number;
  durationSeconds: number;
  source: JumpSource;
  landing: MovementExit;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  deltaY: number;
  maxHeightGainMeters: number;
};

type PastilleCollectEvent = {
  tick: number;
  x: number;
  y: number;
  type: number;
  score: number;
};

type SparkCollectEvent = {
  tick: number;
  x: number;
  y: number;
  type: number;
  score: number;
};

type PlannerAnalyticsSummary = {
  plans: number;
  modes: Record<PlannerStats['mode'], number>;
  planMs: Stats;
  edgesEvaluated: Stats;
  stableNodesExpanded: Stats;
  perceivedWheels: Stats;
  perceivedPastilles: Stats;
  segments: Stats;
  bestScore: Stats;
  bestScoreBreakdown: ScoreBreakdownStats;
};

type ActionRateSummary = {
  pressesPerMinute: number;
  jumpsPerMinute: number;
  wheelJumpsPerMinute: number;
  wallJumpsPerMinute: number;
  flightsPerMinute: number;
  pastillesPerMinute: number;
  sparksPerMinute: number;
  bonusScorePerMinute: number;
};

type PhaseTimeSummary = {
  wheelTicks: number;
  wheelSeconds: number;
  wheelPercent: number;
  flightTicks: number;
  flightSeconds: number;
  flightPercent: number;
  wallTicks: number;
  wallSeconds: number;
  wallPercent: number;
  classifiedTicks: number;
  classifiedSeconds: number;
  classifiedPercent: number;
  unclassifiedTicks: number;
  unclassifiedSeconds: number;
  unclassifiedPercent: number;
};

type InterwheelRunSummary = {
  ticks: number;
  durationSeconds: number;
  presses: number;
  pressRate: number;
  actionsPerMinute: ActionRateSummary;
  phaseTime: PhaseTimeSummary;
  jumps: number;
  wheelJumps: number;
  wallJumps: number;
  wheelStays: number;
  wallDrifts: number;
  flights: number;
  pastilles: number;
  sparks: number;
  bonusScore: number;
  deathCause: MovementExit | null;
  jumpIntervalsTicks: Stats;
  wheelStayTicks: Stats;
  wheelStayRevolutions: Stats;
  wallDriftTicks: Stats;
  wallDriftDeltaY: Stats;
  flightTicks: Stats;
  planner: PlannerAnalyticsSummary;
};

type InterwheelRunAnalyticsResult = {
  seed: number | null;
  summary: InterwheelRunSummary;
  events: {
    jumps: JumpEvent[];
    wheelStays: WheelStayEvent[];
    wallDrifts: WallDriftEvent[];
    flights: FlightEvent[];
    pastilles: PastilleCollectEvent[];
    sparks: SparkCollectEvent[];
  };
};

type ActiveWheelStay = {
  wheelIdx: number;
  startTick: number;
  startAngle: number;
  startHeightMeters: number;
};

type ActiveWallDrift = {
  side: -1 | 1;
  startTick: number;
  startY: number;
};

type ActiveFlight = {
  startTick: number;
  source: JumpSource;
  startX: number;
  startY: number;
  startHeightMeters: number;
  maxHeightMeters: number;
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
    totalScoreBreakdown: emptyScoreBreakdown(),
  };
}

function recordPlannerStats(stats: PlannerStats): void {
  if (!currentPlannerRun) return;
  addPlannerStats(currentPlannerRun, stats);
}

function addPlannerStats(run: PlannerRunStats, stats: PlannerStats): void {
  run.plans += 1;
  run.totalPlanMs += stats.planMs;
  run.maxPlanMs = Math.max(run.maxPlanMs, stats.planMs);
  run.totalEdges += stats.edgesEvaluated;
  run.totalSegments += stats.segments;
  run.totalWheels += stats.perceivedWheels;
  run.totalPastilles += stats.perceivedPastilles;
  addScoreBreakdown(run.totalScoreBreakdown, stats.bestScoreBreakdown);
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
    avgScoreBreakdown: divideScoreBreakdown(stats.totalScoreBreakdown, plans),
  };
}

function scoreBreakdownKeys(): Array<keyof CandidateScoreBreakdown> {
  return ['height', 'collectibles', 'wallRoute', 'stability', 'paceCost', 'safetyCost', 'backtrackCost', 'loopCost', 'total'];
}

function addScoreBreakdown(target: CandidateScoreBreakdown, source: CandidateScoreBreakdown): void {
  for (const key of scoreBreakdownKeys()) target[key] += source[key];
}

function divideScoreBreakdown(source: CandidateScoreBreakdown, divisor: number): CandidateScoreBreakdown {
  const out = emptyScoreBreakdown();
  for (const key of scoreBreakdownKeys()) out[key] = source[key] / divisor;
  return out;
}

function summarizeScoreBreakdown(values: CandidateScoreBreakdown[]): ScoreBreakdownStats {
  const out = {} as ScoreBreakdownStats;
  for (const key of scoreBreakdownKeys()) {
    out[key] = statsOf(values.map((value) => value[key]));
  }
  return out;
}

function heightMetersFromSnapshot(snapshot: SimSnapshot): number {
  return Math.floor(Math.max(0, -snapshot.blob.y) * 0.2);
}

function statsOf(values: number[]): Stats {
  if (values.length === 0) {
    return {
      count: 0,
      total: 0,
      min: 0,
      max: 0,
      mean: 0,
      median: 0,
      p10: 0,
      p25: 0,
      p75: 0,
      p90: 0,
      p95: 0,
      stdev: 0,
    };
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((a, b) => a + b, 0);
  const mean = total / n;
  const variance = sorted.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, n);
  const at = (frac: number) => sorted[Math.min(n - 1, Math.max(0, Math.floor(frac * n)))];
  return {
    count: n,
    total,
    min: sorted[0],
    max: sorted[n - 1],
    mean,
    median: at(0.5),
    p10: at(0.1),
    p25: at(0.25),
    p75: at(0.75),
    p90: at(0.9),
    p95: at(0.95),
    stdev: Math.sqrt(variance),
  };
}

function findDiff(a: unknown, b: unknown, path: string): DeepDiff | null {
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
}

class InterwheelRunAnalytics {
  private seed: number | null = null;
  private activeWheelStay: ActiveWheelStay | null = null;
  private activeWallDrift: ActiveWallDrift | null = null;
  private activeFlight: ActiveFlight | null = null;
  private lastTick = 0;
  private presses = 0;
  private deathCause: MovementExit | null = null;
  private readonly jumps: JumpEvent[] = [];
  private readonly wheelStays: WheelStayEvent[] = [];
  private readonly wallDrifts: WallDriftEvent[] = [];
  private readonly flights: FlightEvent[] = [];
  private readonly pastilles: PastilleCollectEvent[] = [];
  private readonly sparks: SparkCollectEvent[] = [];
  private readonly plannerStats: PlannerStats[] = [];

  start(seed: number | null, snapshot: SimSnapshot): void {
    this.seed = seed;
    this.lastTick = snapshot.tick;
    this.presses = 0;
    this.deathCause = null;
    this.jumps.length = 0;
    this.wheelStays.length = 0;
    this.wallDrifts.length = 0;
    this.flights.length = 0;
    this.pastilles.length = 0;
    this.sparks.length = 0;
    this.plannerStats.length = 0;
    this.activeWheelStay = null;
    this.activeWallDrift = null;
    this.activeFlight = null;
    this.syncActivePhases(snapshot);
  }

  recordTick(input: {
    before: SimSnapshot;
    after: SimSnapshot;
    press: boolean;
    plannerStats: PlannerStats | null;
    events: SimEvents;
  }): void {
    const { before, after, press, plannerStats, events } = input;
    this.lastTick = after.tick;
    if (press) this.presses += 1;
    if (plannerStats) this.plannerStats.push(plannerStats);
    if (events.blobExploded) this.deathCause = 'mine';
    if (events.blobDrowned) this.deathCause = 'drown';

    if (events.blobJumpAngle !== null) this.recordJump(before, after, events.blobJumpAngle);
    this.recordCollections(after.tick, events);

    this.updateWheelStay(before, after, events);
    this.updateWallDrift(before, after, events);
    this.updateFlight(before, after);
  }

  finish(snapshot: SimSnapshot, timedOut: boolean): InterwheelRunAnalyticsResult {
    this.lastTick = snapshot.tick;
    if (timedOut && !snapshot.ended && this.deathCause === null) this.deathCause = 'timeout';
    const exit = this.finishExit(snapshot, timedOut);
    if (this.activeWheelStay) this.closeWheelStay(snapshot, exit);
    if (this.activeWallDrift) this.closeWallDrift(snapshot, exit);
    if (this.activeFlight) this.closeFlight(snapshot, exit);

    const jumpIntervals = this.jumps.slice(1).map((jump, i) => jump.tick - this.jumps[i].tick);
    const wheelJumps = this.jumps.filter((jump) => jump.source === 'wheel').length;
    const wallJumps = this.jumps.filter((jump) => jump.source === 'wall').length;
    const durationMinutes = this.lastTick > 0 ? this.lastTick / FPS / 60 : 0;
    const perMinute = (count: number) => (durationMinutes > 0 ? count / durationMinutes : 0);
    const wheelTicks = this.wheelStays.reduce((sum, stay) => sum + stay.durationTicks, 0);
    const flightTicks = this.flights.reduce((sum, flight) => sum + flight.durationTicks, 0);
    const wallTicks = this.wallDrifts.reduce((sum, drift) => sum + drift.durationTicks, 0);
    const classifiedTicks = wheelTicks + flightTicks + wallTicks;
    const bonusScore =
      this.pastilles.reduce((sum, event) => sum + event.score, 0) +
      this.sparks.reduce((sum, event) => sum + event.score, 0);
    const unclassifiedTicks = Math.max(0, this.lastTick - classifiedTicks);
    const tickPercent = (ticks: number) => (this.lastTick > 0 ? (100 * ticks) / this.lastTick : 0);
    const tickSeconds = (ticks: number) => ticks / FPS;

    return {
      seed: this.seed,
      summary: {
        ticks: this.lastTick,
        durationSeconds: this.lastTick / FPS,
        presses: this.presses,
        pressRate: this.lastTick > 0 ? this.presses / this.lastTick : 0,
        actionsPerMinute: {
          pressesPerMinute: perMinute(this.presses),
          jumpsPerMinute: perMinute(this.jumps.length),
          wheelJumpsPerMinute: perMinute(wheelJumps),
          wallJumpsPerMinute: perMinute(wallJumps),
          flightsPerMinute: perMinute(this.flights.length),
          pastillesPerMinute: perMinute(this.pastilles.length),
          sparksPerMinute: perMinute(this.sparks.length),
          bonusScorePerMinute: perMinute(bonusScore),
        },
        phaseTime: {
          wheelTicks,
          wheelSeconds: tickSeconds(wheelTicks),
          wheelPercent: tickPercent(wheelTicks),
          flightTicks,
          flightSeconds: tickSeconds(flightTicks),
          flightPercent: tickPercent(flightTicks),
          wallTicks,
          wallSeconds: tickSeconds(wallTicks),
          wallPercent: tickPercent(wallTicks),
          classifiedTicks,
          classifiedSeconds: tickSeconds(classifiedTicks),
          classifiedPercent: tickPercent(classifiedTicks),
          unclassifiedTicks,
          unclassifiedSeconds: tickSeconds(unclassifiedTicks),
          unclassifiedPercent: tickPercent(unclassifiedTicks),
        },
        jumps: this.jumps.length,
        wheelJumps,
        wallJumps,
        wheelStays: this.wheelStays.length,
        wallDrifts: this.wallDrifts.length,
        flights: this.flights.length,
        pastilles: this.pastilles.length,
        sparks: this.sparks.length,
        bonusScore,
        deathCause: this.deathCause,
        jumpIntervalsTicks: statsOf(jumpIntervals),
        wheelStayTicks: statsOf(this.wheelStays.map((stay) => stay.durationTicks)),
        wheelStayRevolutions: statsOf(this.wheelStays.map((stay) => stay.revolutions)),
        wallDriftTicks: statsOf(this.wallDrifts.map((drift) => drift.durationTicks)),
        wallDriftDeltaY: statsOf(this.wallDrifts.map((drift) => drift.deltaY)),
        flightTicks: statsOf(this.flights.map((flight) => flight.durationTicks)),
        planner: this.summarizePlanner(),
      },
      events: {
        jumps: this.jumps,
        wheelStays: this.wheelStays,
        wallDrifts: this.wallDrifts,
        flights: this.flights,
        pastilles: this.pastilles,
        sparks: this.sparks,
      },
    };
  }

  private recordCollections(tick: number, events: SimEvents): void {
    for (const pastille of events.collectedPastilles) {
      this.pastilles.push({
        tick,
        x: pastille.x,
        y: pastille.y,
        type: pastille.type,
        score: SCORE_PASTILLE[pastille.type] ?? SCORE_PASTILLE[0],
      });
    }
    for (const spark of events.collectedSparks) {
      this.sparks.push({
        tick,
        x: spark.x,
        y: spark.y,
        type: spark.type,
        score: spark.score,
      });
    }
  }

  private syncActivePhases(snapshot: SimSnapshot): void {
    if (snapshot.blob.state === BLOB_STATE_GRAB && snapshot.blob.cwIdx >= 0) {
      const wheel = snapshot.wheels[snapshot.blob.cwIdx];
      this.activeWheelStay = {
        wheelIdx: snapshot.blob.cwIdx,
        startTick: snapshot.tick,
        startAngle: wheel?.a ?? 0,
        startHeightMeters: heightMetersFromSnapshot(snapshot),
      };
    } else if (snapshot.blob.state === BLOB_STATE_WALL && snapshot.blob.wallSide !== 0) {
      this.activeWallDrift = {
        side: snapshot.blob.wallSide,
        startTick: snapshot.tick,
        startY: snapshot.blob.y,
      };
    } else if (snapshot.blob.state === BLOB_STATE_FLY) {
      const heightMeters = heightMetersFromSnapshot(snapshot);
      this.activeFlight = {
        startTick: snapshot.tick,
        source: 'unknown',
        startX: snapshot.blob.x,
        startY: snapshot.blob.y,
        startHeightMeters: heightMeters,
        maxHeightMeters: heightMeters,
      };
    }
  }

  private recordJump(before: SimSnapshot, after: SimSnapshot, angle: number): void {
    const source = before.blob.state === BLOB_STATE_GRAB ? 'wheel' : before.blob.state === BLOB_STATE_WALL ? 'wall' : 'unknown';
    const jump: JumpEvent = {
      tick: after.tick,
      timeSeconds: after.tick / FPS,
      source,
      x: before.blob.x,
      y: before.blob.y,
      heightMeters: heightMetersFromSnapshot(before),
      angle,
    };
    if (source === 'wheel' && before.blob.cwIdx >= 0) {
      const wheel = before.wheels[before.blob.cwIdx];
      jump.wheelIdx = before.blob.cwIdx;
      if (wheel) {
        jump.wheelRay = wheel.ray;
        jump.wheelSpeed = wheel.speed;
        jump.wheelAngle = wheel.a;
      }
      if (this.activeWheelStay) {
        jump.stayTicksBeforeJump = Math.max(0, after.tick - this.activeWheelStay.startTick);
        jump.revolutionsBeforeJump = wheel ? this.revolutions(this.activeWheelStay.startAngle, wheel.a) : 0;
      }
    }
    if (source === 'wall' && before.blob.wallSide !== 0) {
      jump.wallSide = before.blob.wallSide;
      if (this.activeWallDrift) {
        jump.wallDriftTicksBeforeJump = Math.max(0, after.tick - this.activeWallDrift.startTick);
        jump.wallDriftYBeforeJump = before.blob.y - this.activeWallDrift.startY;
      }
    }
    this.jumps.push(jump);
  }

  private updateWheelStay(before: SimSnapshot, after: SimSnapshot, events: SimEvents): void {
    const nextWheelIdx = after.blob.state === BLOB_STATE_GRAB ? after.blob.cwIdx : -1;
    if (this.activeWheelStay && this.activeWheelStay.wheelIdx !== nextWheelIdx) {
      this.closeWheelStay(after, this.exitFromTransition(before, after, events));
    }
    if (!this.activeWheelStay && nextWheelIdx >= 0) {
      const wheel = after.wheels[nextWheelIdx];
      this.activeWheelStay = {
        wheelIdx: nextWheelIdx,
        startTick: after.tick,
        startAngle: wheel?.a ?? 0,
        startHeightMeters: heightMetersFromSnapshot(after),
      };
    }
  }

  private updateWallDrift(before: SimSnapshot, after: SimSnapshot, events: SimEvents): void {
    const nextWallSide = after.blob.state === BLOB_STATE_WALL ? after.blob.wallSide : 0;
    if (this.activeWallDrift && this.activeWallDrift.side !== nextWallSide) {
      this.closeWallDrift(after, this.exitFromTransition(before, after, events));
    }
    if (!this.activeWallDrift && nextWallSide !== 0) {
      this.activeWallDrift = {
        side: nextWallSide,
        startTick: after.tick,
        startY: after.blob.y,
      };
    }
  }

  private updateFlight(before: SimSnapshot, after: SimSnapshot): void {
    if (this.activeFlight) {
      this.activeFlight.maxHeightMeters = Math.max(this.activeFlight.maxHeightMeters, heightMetersFromSnapshot(after));
    }
    if (this.activeFlight && after.blob.state !== BLOB_STATE_FLY) {
      this.closeFlight(after, this.flightLanding(after));
    }
    if (!this.activeFlight && after.blob.state === BLOB_STATE_FLY) {
      const source = before.blob.state === BLOB_STATE_GRAB ? 'wheel' : before.blob.state === BLOB_STATE_WALL ? 'wall' : 'unknown';
      const heightMeters = heightMetersFromSnapshot(after);
      this.activeFlight = {
        startTick: after.tick,
        source,
        startX: after.blob.x,
        startY: after.blob.y,
        startHeightMeters: heightMeters,
        maxHeightMeters: heightMeters,
      };
    }
  }

  private closeWheelStay(snapshot: SimSnapshot, exit: MovementExit): void {
    if (!this.activeWheelStay) return;
    const stay = this.activeWheelStay;
    const wheel = snapshot.wheels[stay.wheelIdx];
    const endAngle = wheel?.a ?? stay.startAngle;
    const endTick = snapshot.tick;
    this.wheelStays.push({
      wheelIdx: stay.wheelIdx,
      startTick: stay.startTick,
      endTick,
      durationTicks: Math.max(0, endTick - stay.startTick),
      durationSeconds: Math.max(0, endTick - stay.startTick) / FPS,
      startAngle: stay.startAngle,
      endAngle,
      revolutions: this.revolutions(stay.startAngle, endAngle),
      startHeightMeters: stay.startHeightMeters,
      endHeightMeters: heightMetersFromSnapshot(snapshot),
      exit,
    });
    this.activeWheelStay = null;
  }

  private closeWallDrift(snapshot: SimSnapshot, exit: MovementExit): void {
    if (!this.activeWallDrift) return;
    const drift = this.activeWallDrift;
    const endTick = snapshot.tick;
    this.wallDrifts.push({
      side: drift.side,
      startTick: drift.startTick,
      endTick,
      durationTicks: Math.max(0, endTick - drift.startTick),
      durationSeconds: Math.max(0, endTick - drift.startTick) / FPS,
      startY: drift.startY,
      endY: snapshot.blob.y,
      deltaY: snapshot.blob.y - drift.startY,
      exit,
    });
    this.activeWallDrift = null;
  }

  private closeFlight(snapshot: SimSnapshot, landing: MovementExit): void {
    if (!this.activeFlight) return;
    const flight = this.activeFlight;
    const endTick = snapshot.tick;
    this.flights.push({
      startTick: flight.startTick,
      endTick,
      durationTicks: Math.max(0, endTick - flight.startTick),
      durationSeconds: Math.max(0, endTick - flight.startTick) / FPS,
      source: flight.source,
      landing,
      startX: flight.startX,
      startY: flight.startY,
      endX: snapshot.blob.x,
      endY: snapshot.blob.y,
      deltaY: snapshot.blob.y - flight.startY,
      maxHeightGainMeters: Math.max(0, flight.maxHeightMeters - flight.startHeightMeters),
    });
    this.activeFlight = null;
  }

  private exitFromTransition(before: SimSnapshot, after: SimSnapshot, events: SimEvents): MovementExit {
    if (events.blobJumpAngle !== null && before.blob.state === BLOB_STATE_WALL) return 'wallJump';
    if (events.blobJumpAngle !== null) return 'jump';
    if (events.blobExploded) return 'mine';
    if (events.blobDrowned) return 'drown';
    if (after.blob.state === BLOB_STATE_DEAD) return 'death';
    if (after.ended || events.runFinished) return 'runEnd';
    if (after.blob.state === BLOB_STATE_GRAB) return 'wheel';
    if (after.blob.state === BLOB_STATE_WALL) return 'wall';
    return 'unknown';
  }

  private flightLanding(snapshot: SimSnapshot): MovementExit {
    if (snapshot.blob.state === BLOB_STATE_GRAB) return 'wheel';
    if (snapshot.blob.state === BLOB_STATE_WALL) return 'wall';
    if (snapshot.blob.state === BLOB_STATE_DEAD) return this.deathCause ?? 'death';
    if (snapshot.ended) return 'runEnd';
    return 'unknown';
  }

  private finishExit(snapshot: SimSnapshot, timedOut: boolean): MovementExit {
    if (timedOut && !snapshot.ended) return 'timeout';
    if (snapshot.ended) return 'runEnd';
    if (snapshot.blob.state === BLOB_STATE_DEAD) return this.deathCause ?? 'death';
    return 'unknown';
  }

  private revolutions(startAngle: number, endAngle: number): number {
    return Math.abs(endAngle - startAngle) / (Math.PI * 2);
  }

  private summarizePlanner(): PlannerAnalyticsSummary {
    const modes: Record<PlannerStats['mode'], number> = { dead: 0, flight: 0, idle: 0, stable: 0 };
    for (const stat of this.plannerStats) modes[stat.mode] += 1;
    return {
      plans: this.plannerStats.length,
      modes,
      planMs: statsOf(this.plannerStats.map((stat) => stat.planMs)),
      edgesEvaluated: statsOf(this.plannerStats.map((stat) => stat.edgesEvaluated)),
      stableNodesExpanded: statsOf(this.plannerStats.map((stat) => stat.stableNodesExpanded)),
      perceivedWheels: statsOf(this.plannerStats.map((stat) => stat.perceivedWheels)),
      perceivedPastilles: statsOf(this.plannerStats.map((stat) => stat.perceivedPastilles)),
      segments: statsOf(this.plannerStats.map((stat) => stat.segments)),
      bestScore: statsOf(this.plannerStats.map((stat) => stat.bestScore)),
      bestScoreBreakdown: summarizeScoreBreakdown(this.plannerStats.map((stat) => stat.bestScoreBreakdown)),
    };
  }
}

async function setup(): Promise<void> {
  await mount(stage, {
    host: noopGameHost,
    onReady: (g) => {
      game = g as InterwheelGame;
      // Stash the originals so parityCheck() can swap rendering back on.
      originalRender = game.render.bind(game);
      originalUpdateParticles = game.updateParticles.bind(game);
      // Analytics mode: skip purely-visual work.
      game.render = (() => {}) as typeof game.render;
      game.updateParticles = (() => {}) as typeof game.updateParticles;
      // Halt the RAF-paced ticker; we drive ticks by hand.
      game.app.ticker.stop();

      planner = new InterwheelPlanner(game.sim, ANALYTICS_PLANNER_CONFIG);
      originalUpdate = game.update.bind(game);
      game.update = () => {
        const before = currentAnalytics ? game.sim.clone() : null;
        let press = false;
        let plannerStats: PlannerStats | null = null;
        if (!game.ended && !game.ending) {
          const resultWithPress = planner.step();
          press = resultWithPress.press;
          const { result } = resultWithPress;
          if (press) game.spacePressed = true;
          if (result) {
            plannerStats = result.stats;
            recordPlannerStats(result.stats);
          }
          if (recording) recordedPresses.push(press);
        }
        originalUpdate();
        if (before && currentAnalytics) {
          currentAnalytics.recordTick({
            before,
            after: game.sim.clone(),
            press,
            plannerStats,
            events: game.sim.events,
          });
        }
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
  analytics: InterwheelRunAnalyticsResult;
  /** The seed used for this trial's level generation, or null if Math.random was used. */
  seed: number | null;
};

type TrialOptions = {
  noWater?: boolean;
  stopHeightMeters?: number;
};

const NO_WATER_Y = 1_000_000_000;

async function runTrial(
  seed: number | null = null,
  maxTicks = 24_000,
  plannerCfg: PlannerConfig = plannerConfigForPolicy(),
): Promise<TrialResult> {
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
  planner = new InterwheelPlanner(game.sim, plannerCfg);
  planner.invalidate();
  currentPlannerRun = freshPlannerRunStats();
  currentAnalytics = new InterwheelRunAnalytics();
  currentAnalytics.start(seed, game.sim.clone());
  const startCpu = performance.now();
  let ticks = 0;
  try {
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
      planner: summarizePlannerStats(currentPlannerRun ?? freshPlannerRunStats()),
      analytics: currentAnalytics.finish(game.sim.clone(), !game.ended && ticks >= maxTicks),
      seed,
    };
  } finally {
    currentAnalytics = null;
    currentPlannerRun = null;
  }
}

async function runPureTrial(
  seed: number | null = null,
  maxTicks = 24_000,
  plannerCfg: PlannerConfig = plannerConfigForPolicy(),
  opts: TrialOptions = {},
): Promise<TrialResult> {
  const sim = new PureInterwheelSim();
  sim.reset(seed !== null ? makeSeededRng(seed) : Math.random);
  if (opts.noWater) sim.waterY = NO_WATER_Y;
  const purePlanner = new InterwheelPlanner(sim, plannerCfg);
  const plannerRun = freshPlannerRunStats();
  const analytics = new InterwheelRunAnalytics();
  analytics.start(seed, sim.clone());
  const startCpu = performance.now();
  let ticks = 0;
  while (!sim.ended && ticks < maxTicks && !reachedStopHeight(sim, opts.stopHeightMeters)) {
    const before = sim.clone();
    let press = false;
    let plannerStats: PlannerStats | null = null;
    if (!sim.ended && !sim.ending) {
      const resultWithPress = purePlanner.step();
      press = resultWithPress.press;
      const { result } = resultWithPress;
      if (result) {
        plannerStats = result.stats;
        addPlannerStats(plannerRun, result.stats);
      }
    }
    sim.step(press, () => 0.5);
    analytics.recordTick({
      before,
      after: sim.clone(),
      press,
      plannerStats,
      events: sim.events,
    });
    ticks += 1;
    if ((ticks & 511) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  return {
    score: sim.score,
    heightMeters: Math.floor(sim.maxHeight * 0.2),
    ticks,
    cpuMs: performance.now() - startCpu,
    planner: summarizePlannerStats(plannerRun),
    analytics: analytics.finish(sim.clone(), !sim.ended && ticks >= maxTicks),
    seed,
  };
}

function reachedStopHeight(sim: PureInterwheelSim, stopHeightMeters: number | undefined): boolean {
  return typeof stopHeightMeters === 'number' && Math.floor(sim.maxHeight * 0.2) >= stopHeightMeters;
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
// Programmatic analytics API - meant to be invoked from the CLI script
// (scripts/analyze-interwheel.mjs). Returns rich statistics; height is the primary metric.
// ============================================================================

export type AnalyzeInterwheelOpts = {
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
  /** Numeric planner policy knobs. Omitted fields use the default value 1, except wallRoutes=0. */
  policy?: Partial<PlannerPolicy>;
};

export type AnalyzeInterwheelResult = {
  trials: TrialResult[];
  stats: { height_m: Stats; score: Stats; ticks: Stats; cpuMs: Stats };
  config: {
    trials: number;
    seedBase: number | null;
    maxTicks: number;
    plannerConfig: PlannerConfig;
  };
  wallMs: number;
  cpuMs: number;
};

async function runAnalyze(opts: AnalyzeInterwheelOpts = {}): Promise<AnalyzeInterwheelResult> {
  const trials = Math.max(1, opts.trials ?? 5);
  const seedBase = opts.seedBase ?? null;
  const maxTicks = opts.maxTicks ?? 24_000;
  const plannerCfg = plannerConfigForPolicy(opts.policy);

  log(`analytics: ${trials} trials  seedBase=${seedBase ?? 'random'}  maxTicks=${maxTicks}\n`);

  const results: TrialResult[] = [];
  const wallStart = performance.now();
  for (let i = 0; i < trials; i += 1) {
    const seed = seedBase !== null ? seedBase + i : null;
    const r = await runTrial(seed, maxTicks, plannerCfg);
    results.push(r);
    append(
      `  trial ${String(i + 1).padStart(3)}/${trials}` +
        (seed !== null ? ` (seed=${seed})` : '') +
        `: height=${r.heightMeters}m  score=${r.score}  ticks=${r.ticks}  cpu=${Math.round(r.cpuMs)}ms` +
        `  jumps=${r.analytics.summary.jumps} wheelStays=${r.analytics.summary.wheelStays}` +
        `  wallDrifts=${r.analytics.summary.wallDrifts}` +
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

async function runPureAnalyze(opts: AnalyzeInterwheelOpts = {}): Promise<AnalyzeInterwheelResult> {
  const trials = Math.max(1, opts.trials ?? 5);
  const seedBase = opts.seedBase ?? null;
  const maxTicks = opts.maxTicks ?? 24_000;
  const plannerCfg = plannerConfigForPolicy(opts.policy);

  const results: TrialResult[] = [];
  const wallStart = performance.now();
  for (let i = 0; i < trials; i += 1) {
    const seed = seedBase !== null ? seedBase + i : null;
    results.push(await runPureTrial(seed, maxTicks, plannerCfg));
  }
  const wallMs = performance.now() - wallStart;
  const cpuMs = results.reduce((s, r) => s + r.cpuMs, 0);

  return {
    trials: results,
    stats: {
      height_m: statsOf(results.map((r) => r.heightMeters)),
      score: statsOf(results.map((r) => r.score)),
      ticks: statsOf(results.map((r) => r.ticks)),
      cpuMs: statsOf(results.map((r) => r.cpuMs)),
    },
    config: { trials, seedBase, maxTicks, plannerConfig: plannerCfg },
    wallMs,
    cpuMs,
  };
}

type TickSample = {
  tick: number;
  state: ReturnType<InterwheelSim['clone']>;
};

type TranscriptSample = {
  tick: number;
  press: boolean;
  state: SimSnapshot;
};

type TranscriptResult = {
  seed: number;
  maxTicks: number;
  samples: TranscriptSample[];
  final: { score: number; heightMeters: number; ticks: number; ended: boolean };
  cpuMs: number;
};

type PureReplayEquivalenceResult = {
  seed: number;
  maxTicks: number;
  equal: boolean;
  mounted: Omit<TranscriptResult, 'samples'> & { sampleCount: number };
  pure: Omit<TranscriptResult, 'samples'> & { sampleCount: number };
  firstDivergence?: {
    index: number;
    tick: number;
    path: string;
    mounted: unknown;
    pure: unknown;
  };
};

type PureReplayCorpusResult = {
  trials: number;
  seedBase: number;
  maxTicks: number;
  equal: boolean;
  results: PureReplayEquivalenceResult[];
  firstFailure?: PureReplayEquivalenceResult;
};

type PurePlannerEquivalenceResult = PureReplayEquivalenceResult;
type PurePlannerCorpusResult = PureReplayCorpusResult;

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

function resetMountedGame(seed: number): void {
  const savedRandom = Math.random;
  Math.random = makeSeededRng(seed);
  try {
    game.reset();
  } finally {
    Math.random = savedRandom;
  }
}

async function runMountedTranscript(
  seed: number,
  maxTicks: number,
  plannerCfg: PlannerConfig = plannerConfigForPolicy(),
): Promise<TranscriptResult> {
  resetMountedGame(seed);
  planner = new InterwheelPlanner(game.sim, plannerCfg);
  planner.invalidate();
  recordedPresses = [];
  recording = true;
  const samples: TranscriptSample[] = [];
  const startCpu = performance.now();
  try {
    let ticks = 0;
    while (!game.ended && ticks < maxTicks) {
      game.update();
      const press = recordedPresses[samples.length] ?? false;
      samples.push({ tick: game.tick, press, state: game.sim.clone() });
      ticks += 1;
      if ((ticks & 511) === 0) await new Promise<void>((r) => setTimeout(r, 0));
    }
  } finally {
    recording = false;
  }
  return {
    seed,
    maxTicks,
    samples,
    final: {
      score: game.score,
      heightMeters: Math.floor(game.maxHeight * 0.2),
      ticks: game.tick,
      ended: game.ended,
    },
    cpuMs: performance.now() - startCpu,
  };
}

function runPureReplayTranscript(seed: number, maxTicks: number, presses: readonly boolean[]): TranscriptResult {
  const sim = new PureInterwheelSim();
  sim.reset(makeSeededRng(seed));
  const samples: TranscriptSample[] = [];
  const startCpu = performance.now();
  let ticks = 0;
  while (!sim.ended && ticks < maxTicks) {
    const press = presses[ticks] ?? false;
    sim.step(press, () => 0.5);
    samples.push({ tick: sim.tick, press, state: sim.clone() });
    ticks += 1;
  }
  return {
    seed,
    maxTicks,
    samples,
    final: {
      score: sim.score,
      heightMeters: Math.floor(sim.maxHeight * 0.2),
      ticks: sim.tick,
      ended: sim.ended,
    },
    cpuMs: performance.now() - startCpu,
  };
}

function runPurePlannedTranscript(
  seed: number,
  maxTicks: number,
  plannerCfg: PlannerConfig = plannerConfigForPolicy(),
): TranscriptResult {
  const sim = new PureInterwheelSim();
  sim.reset(makeSeededRng(seed));
  const purePlanner = new InterwheelPlanner(sim, plannerCfg);
  const samples: TranscriptSample[] = [];
  const startCpu = performance.now();
  let ticks = 0;
  while (!sim.ended && ticks < maxTicks) {
    let press = false;
    if (!sim.ended && !sim.ending) {
      press = purePlanner.step().press;
    }
    sim.step(press, () => 0.5);
    samples.push({ tick: sim.tick, press, state: sim.clone() });
    ticks += 1;
  }
  return {
    seed,
    maxTicks,
    samples,
    final: {
      score: sim.score,
      heightMeters: Math.floor(sim.maxHeight * 0.2),
      ticks: sim.tick,
      ended: sim.ended,
    },
    cpuMs: performance.now() - startCpu,
  };
}

function summarizeTranscript(result: TranscriptResult): Omit<TranscriptResult, 'samples'> & { sampleCount: number } {
  return {
    seed: result.seed,
    maxTicks: result.maxTicks,
    sampleCount: result.samples.length,
    final: result.final,
    cpuMs: result.cpuMs,
  };
}

function compareTranscripts(
  mounted: TranscriptResult,
  pure: TranscriptResult,
): PureReplayEquivalenceResult {
  let firstDivergence: PureReplayEquivalenceResult['firstDivergence'];
  const minLen = Math.min(mounted.samples.length, pure.samples.length);
  for (let i = 0; i < minLen; i += 1) {
    const m = mounted.samples[i];
    const p = pure.samples[i];
    if (m.press !== p.press) {
      firstDivergence = { index: i, tick: m.tick, path: 'press', mounted: m.press, pure: p.press };
      break;
    }
    const tickDiff = findDiff(m.tick, p.tick, 'tick');
    if (tickDiff) {
      firstDivergence = { index: i, tick: m.tick, path: tickDiff.path, mounted: tickDiff.a, pure: tickDiff.b };
      break;
    }
    const stateDiff = findDiff(m.state, p.state, 'state');
    if (stateDiff) {
      firstDivergence = { index: i, tick: m.tick, path: stateDiff.path, mounted: stateDiff.a, pure: stateDiff.b };
      break;
    }
  }
  if (!firstDivergence && mounted.samples.length !== pure.samples.length) {
    firstDivergence = {
      index: minLen,
      tick: mounted.samples[minLen - 1]?.tick ?? pure.samples[minLen - 1]?.tick ?? 0,
      path: 'samples.length',
      mounted: mounted.samples.length,
      pure: pure.samples.length,
    };
  }
  if (!firstDivergence) {
    const finalDiff = findDiff(mounted.final, pure.final, 'final');
    if (finalDiff) {
      firstDivergence = {
        index: minLen,
        tick: mounted.final.ticks,
        path: finalDiff.path,
        mounted: finalDiff.a,
        pure: finalDiff.b,
      };
    }
  }
  return {
    seed: mounted.seed,
    maxTicks: mounted.maxTicks,
    equal: !firstDivergence,
    mounted: summarizeTranscript(mounted),
    pure: summarizeTranscript(pure),
    firstDivergence,
  };
}

async function comparePureReplay(
  seed = 42,
  maxTicks = 1_200,
  plannerCfg: PlannerConfig = plannerConfigForPolicy(),
): Promise<PureReplayEquivalenceResult> {
  const mounted = await runMountedTranscript(seed, maxTicks, plannerCfg);
  const pure = runPureReplayTranscript(seed, maxTicks, mounted.samples.map((sample) => sample.press));
  return compareTranscripts(mounted, pure);
}

async function comparePurePlanner(
  seed = 42,
  maxTicks = 1_200,
  plannerCfg: PlannerConfig = plannerConfigForPolicy(),
): Promise<PurePlannerEquivalenceResult> {
  const mounted = await runMountedTranscript(seed, maxTicks, plannerCfg);
  const pure = runPurePlannedTranscript(seed, maxTicks, plannerCfg);
  return compareTranscripts(mounted, pure);
}

async function comparePureReplayCorpus(opts: AnalyzeInterwheelOpts = {}): Promise<PureReplayCorpusResult> {
  const trials = Math.max(1, opts.trials ?? 5);
  const seedBase = opts.seedBase ?? 42;
  const maxTicks = opts.maxTicks ?? 1_200;
  const plannerCfg = plannerConfigForPolicy(opts.policy);
  const results: PureReplayEquivalenceResult[] = [];
  for (let i = 0; i < trials; i += 1) {
    const result = await comparePureReplay(seedBase + i, maxTicks, plannerCfg);
    results.push(result);
    if (!result.equal) break;
  }
  const firstFailure = results.find((result) => !result.equal);
  return {
    trials,
    seedBase,
    maxTicks,
    equal: !firstFailure && results.length === trials,
    results,
    firstFailure,
  };
}

async function comparePurePlannerCorpus(opts: AnalyzeInterwheelOpts = {}): Promise<PurePlannerCorpusResult> {
  const trials = Math.max(1, opts.trials ?? 5);
  const seedBase = opts.seedBase ?? 42;
  const maxTicks = opts.maxTicks ?? 1_200;
  const plannerCfg = plannerConfigForPolicy(opts.policy);
  const results: PurePlannerEquivalenceResult[] = [];
  for (let i = 0; i < trials; i += 1) {
    const result = await comparePurePlanner(seedBase + i, maxTicks, plannerCfg);
    results.push(result);
    if (!result.equal) break;
  }
  const firstFailure = results.find((result) => !result.equal);
  return {
    trials,
    seedBase,
    maxTicks,
    equal: !firstFailure && results.length === trials,
    results,
    firstFailure,
  };
}

async function parityCheck(): Promise<{
  headless: { score: number; height: number; ticks: number };
  full:  { score: number; height: number; ticks: number };
  equal: boolean;
  firstDivergence?: { tick: number; path: string; headless: unknown; full: unknown };
}> {
  log('Parity check: identical seeded level, same presses, render off vs render on…\n');

  const SEED = 0x12345678;
  const savedRandom = Math.random;

  // ----- Phase A — seeded reset (deterministic level), record a headless trial.
  Math.random = makeSeededRng(SEED);
  game.reset();
  Math.random = savedRandom;
  planner.invalidate();
  recordedPresses = [];
  recording = true;
  const headlessSamples: TickSample[] = [];
  const sampleInto = (out: TickSample[]) => {
    out.push({ tick: game.tick, state: game.sim.clone() });
  };
  // Use the existing wrapped update; sample after each tick.
  let ticks = 0;
  while (!game.ended && ticks < 24_000) {
    game.update();
    sampleInto(headlessSamples);
    ticks += 1;
    if ((ticks & 511) === 0) await new Promise<void>((r) => setTimeout(r, 0));
  }
  recording = false;
  const presses = recordedPresses.slice();
  const headless = {
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
  while (!game.ended && fullSamples.length < headlessSamples.length) {
    game.update();
    sampleInto(fullSamples);
  }
  const full = {
    score: game.score,
    height: Math.round(game.maxHeight * 1000) / 1000,
    ticks: game.tick,
  };

  // Restore headless wrappers so subsequent button clicks still work.
  game.render = (() => {}) as typeof game.render;
  game.updateParticles = (() => {}) as typeof game.updateParticles;
  game.update = (() => {
    const before = currentAnalytics ? game.sim.clone() : null;
    let press = false;
    let plannerStats: PlannerStats | null = null;
    if (!game.ended && !game.ending) {
      const resultWithPress = planner.step();
      press = resultWithPress.press;
      const { result } = resultWithPress;
      if (press) game.spacePressed = true;
      if (result) {
        plannerStats = result.stats;
        recordPlannerStats(result.stats);
      }
      if (recording) recordedPresses.push(press);
    }
    originalUpdate();
    if (before && currentAnalytics) {
      currentAnalytics.recordTick({
        before,
        after: game.sim.clone(),
        press,
        plannerStats,
        events: game.sim.events,
      });
    }
  }) as typeof game.update;

  // Deep-compare each tick's full sim-state snapshot. Walks the whole
  // structure and reports the first path that differs.
  type Diff = { tick: number; path: string; headless: unknown; full: unknown };
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
  const minLen = Math.min(headlessSamples.length, fullSamples.length);
  for (let i = 0; i < minLen; i += 1) {
    const d = findDiff(headlessSamples[i].state, fullSamples[i].state, '');
    if (d) {
      firstDivergence = { tick: headlessSamples[i].tick, path: d.path, headless: d.a, full: d.b };
      break;
    }
  }

  const equal =
    headless.score === full.score &&
    headless.ticks === full.ticks &&
    Math.abs(headless.height - full.height) < 1e-6 &&
    !firstDivergence;

  append(`headless (render off): score=${headless.score} height=${headless.height} ticks=${headless.ticks}\n`);
  append(`full  (render on ): score=${full.score} height=${full.height} ticks=${full.ticks}\n`);
  append(`presses.length=${presses.length}  headlessSamples.length=${headlessSamples.length}  fullSamples.length=${fullSamples.length}\n`);
  if (headlessSamples.length > 0) {
    const last = headlessSamples[headlessSamples.length - 1];
    append(`headless last sample: tick=${last.tick} ended=${last.state.ended} ending=${last.state.ending} endTimer=${last.state.endTimer}\n`);
  }
  if (fullSamples.length > 0) {
    const last = fullSamples[fullSamples.length - 1];
    append(`full  last sample: tick=${last.tick} ended=${last.state.ended} ending=${last.state.ending} endTimer=${last.state.endTimer}\n`);
  }
  append(`equal: ${equal}\n`);
  if (firstDivergence) {
    const d = firstDivergence;
    append(`first divergence at tick ${d.tick} path "${d.path}" — headless=${JSON.stringify(d.headless)} full=${JSON.stringify(d.full)}\n`);
  }
  return { headless, full, equal, firstDivergence };
}

(async () => {
  log('Booting Interwheel…');
  await setup();
  log('Ready. Click a button.');
  runBtn.addEventListener('click', () => void runBatch(20));
  run100Btn.addEventListener('click', () => void runBatch(100));
  detBtn.addEventListener('click', () => void parityCheck());
  // Expose a programmatic API for Playwright + the CLI headless script.
  (window as unknown as {
    __interwheelAnalytics__: {
      runBatch: typeof runBatch;
      runTrial: typeof runTrial;
      runAnalyze: typeof runAnalyze;
      runPureTrial: typeof runPureTrial;
      runPureAnalyze: typeof runPureAnalyze;
      comparePureReplay: typeof comparePureReplay;
      comparePureReplayCorpus: typeof comparePureReplayCorpus;
      comparePurePlanner: typeof comparePurePlanner;
      comparePurePlannerCorpus: typeof comparePurePlannerCorpus;
      parityCheck: typeof parityCheck;
    };
  }).__interwheelAnalytics__ = {
    runBatch,
    runTrial,
    runAnalyze,
    runPureTrial,
    runPureAnalyze,
    comparePureReplay,
    comparePureReplayCorpus,
    comparePurePlanner,
    comparePurePlannerCorpus,
    parityCheck,
  };
})().catch((err) => {
  log(`Boot failed: ${err}`);
  console.error(err);
});
