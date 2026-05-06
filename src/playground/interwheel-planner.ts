import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  BLOB_STATE_GRAB,
  BLOB_STATE_WALL,
  type InterwheelSim,
  type SimSnapshot,
} from '../games/interwheel/index';

// Constant RNG used during search — sim's `step` consumes one rng draw on
// destroyed-wheel ticks for cosmetic dust, but cosmetic outcomes don't
// affect blob trajectory. A constant function keeps planning fully
// deterministic without touching the live PRNG.
const constantRng = () => 0.5;

const MAX_GRAB_WAIT = 100;
const MAX_WALL_WAIT = 24;
const MAX_FLIGHT_TICKS = 260;
const WATER_SAFETY_MARGIN = 160;
const REPLAN_TICKS = 8;
const VISUAL_ACTION_REPEAT = 2;
const VISUAL_BLOB_JUMP = 12;
const VISUAL_DEATH_PENALTY = 1_000_000;
const VISUAL_MAX_NODES = 120;
const VISUAL_MAX_DEPTH = 90;

type VisualNode = {
  state: SimSnapshot;
  depth: number;
  isDead: boolean;
  blobX: number;
  blobY: number;
  parentX: number;
  parentY: number;
  g: number;
  h: number;
};

type Candidate = {
  plan: boolean[];
  segment: Segment;
  endState: SimSnapshot;
  score: number;
};

export type SegmentKind = 'branch' | 'best' | 'dead';

export type Segment = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  depth: number;
  kind: SegmentKind;
};

export type PlanResult = {
  plan: boolean[];
  segments: Segment[];
  startBlobY: number;
};

export type PlannerConfig = {
  budgetMs?: number;
  maxNodes?: number;
  maxDepth?: number;
  targetClimb?: number;
};

export class InterwheelPlanner {
  private readonly sim: InterwheelSim;
  private readonly cfg: Required<PlannerConfig>;

  private cachedPlan: boolean[] = [];
  private replanIn = 0;
  private lastResult: PlanResult | null = null;

  constructor(sim: InterwheelSim, cfg: PlannerConfig = {}) {
    this.sim = sim;
    this.cfg = {
      budgetMs: cfg.budgetMs ?? 18,
      maxNodes: cfg.maxNodes ?? 1800,
      maxDepth: cfg.maxDepth ?? 100,
      targetClimb: cfg.targetClimb ?? 400,
    };
  }

  // Pull next planned press for one live tick. If the cache is empty or the
  // replan timer has fired, run a fresh search first.
  step(): { press: boolean; result: PlanResult | null } {
    let result: PlanResult | null = null;
    if (this.cachedPlan.length === 0 || this.replanIn <= 0) {
      result = this.plan();
      this.cachedPlan = result.plan.slice();
      this.replanIn = Math.min(REPLAN_TICKS, Math.max(1, this.cachedPlan.length));
      this.lastResult = result;
    } else {
      this.replanIn -= 1;
    }
    const press = this.cachedPlan.length > 0 ? this.cachedPlan.shift()! : false;
    return { press, result };
  }

  lastSegments(): Segment[] {
    return this.lastResult?.segments ?? [];
  }

  invalidate(): void {
    this.cachedPlan.length = 0;
    this.replanIn = 0;
    this.lastResult = null;
  }

  private plan(): PlanResult {
    const sim = this.sim;
    const startSnap = sim.clone();
    try {
      if (startSnap.blob.state === BLOB_STATE_DEAD || startSnap.ending || startSnap.ended) {
        return { plan: [false], segments: [], startBlobY: startSnap.blob.y };
      }

      if (startSnap.blob.state === BLOB_STATE_FLY) {
        return this.planPassiveFlight(startSnap);
      }

      if (startSnap.blob.state !== BLOB_STATE_GRAB && startSnap.blob.state !== BLOB_STATE_WALL) {
        return { plan: [false], segments: [], startBlobY: startSnap.blob.y };
      }

      const waitLimit = startSnap.blob.state === BLOB_STATE_WALL
        ? Math.min(MAX_WALL_WAIT, this.cfg.maxDepth)
        : Math.min(MAX_GRAB_WAIT, Math.max(this.cfg.maxDepth, this.cfg.targetClimb / 4));
      const candidates: Candidate[] = [];

      for (let wait = 0; wait <= waitLimit && candidates.length < this.cfg.maxNodes; wait += 1) {
        const candidate = this.evaluateLaunch(startSnap, wait);
        if (candidate) candidates.push(candidate);
      }

      if (candidates.length === 0) {
        return { plan: [false], segments: [], startBlobY: startSnap.blob.y };
      }

      let best = candidates[0];
      for (let i = 1; i < candidates.length; i += 1) {
        if (candidates[i].score > best.score) best = candidates[i];
      }

      const segments = [
        ...this.buildTickSearchSegments(startSnap),
        ...this.buildPlanSegments(startSnap, best.plan),
      ];

      return { plan: best.plan, segments, startBlobY: startSnap.blob.y };
    } finally {
      sim.restore(startSnap);
    }
  }

  private planPassiveFlight(startSnap: SimSnapshot): PlanResult {
    const sim = this.sim;
    const plan: boolean[] = [];
    sim.restore(startSnap);

    let ticks = 0;
    while (
      sim.blob.state === BLOB_STATE_FLY &&
      !sim.ending &&
      !sim.ended &&
      ticks < MAX_FLIGHT_TICKS
    ) {
      sim.step(false, constantRng);
      plan.push(false);
      ticks += 1;
    }

    const safePlan = plan.length > 0 ? plan : [false];
    return { plan: safePlan, segments: this.buildPlanSegments(startSnap, safePlan), startBlobY: startSnap.blob.y };
  }

  private evaluateLaunch(startSnap: SimSnapshot, waitTicks: number): Candidate | null {
    const sim = this.sim;
    const plan: boolean[] = [];
    sim.restore(startSnap);

    for (let i = 0; i < waitTicks; i += 1) {
      sim.step(false, constantRng);
      plan.push(false);
      if (sim.blob.state === BLOB_STATE_DEAD || sim.ending || sim.ended) return null;
    }

    sim.step(true, constantRng);
    plan.push(true);

    let flightTicks = 0;
    while (
      sim.blob.state === BLOB_STATE_FLY &&
      !sim.ending &&
      !sim.ended &&
      flightTicks < MAX_FLIGHT_TICKS
    ) {
      sim.step(false, constantRng);
      plan.push(false);
      flightTicks += 1;
    }

    const endState = sim.clone();
    const isDead = endState.blob.state === BLOB_STATE_DEAD || endState.ending || endState.ended;
    const score = this.scoreCandidate(startSnap, endState, plan.length, waitTicks);
    const segment: Segment = {
      x0: startSnap.blob.x,
      y0: startSnap.blob.y,
      x1: endState.blob.x,
      y1: endState.blob.y,
      depth: plan.length,
      kind: isDead ? 'dead' : 'branch',
    };

    return { plan, segment, endState, score };
  }

  private buildTickSearchSegments(startSnap: SimSnapshot): Segment[] {
    const sim = this.sim;
    const startTime = performance.now();
    const goalY = startSnap.blob.y - this.cfg.targetClimb;
    const root: VisualNode = {
      state: startSnap,
      depth: 0,
      isDead: startSnap.blob.state === BLOB_STATE_DEAD,
      blobX: startSnap.blob.x,
      blobY: startSnap.blob.y,
      parentX: startSnap.blob.x,
      parentY: startSnap.blob.y,
      g: 0,
      h: 0,
    };
    const open: VisualNode[] = [root];
    const segments: Segment[] = [];
    const maxNodes = Math.min(this.cfg.maxNodes, VISUAL_MAX_NODES);
    const maxDepth = Math.min(this.cfg.maxDepth, VISUAL_MAX_DEPTH);
    let nodeCount = 0;

    while (open.length > 0 && nodeCount < maxNodes) {
      if ((nodeCount & 31) === 0 && performance.now() - startTime > this.cfg.budgetMs) break;

      let minIdx = 0;
      let minF = open[0].g + open[0].h;
      for (let i = 1; i < open.length; i += 1) {
        const f = open[i].g + open[i].h;
        if (f < minF) {
          minF = f;
          minIdx = i;
        }
      }
      const node = open[minIdx];
      open[minIdx] = open[open.length - 1];
      open.pop();

      if (node.isDead || node.depth >= maxDepth) continue;

      const actions = node.state.blob.state === BLOB_STATE_FLY ? [false] : [false, true];
      for (const action of actions) {
        sim.restore(node.state);
        for (let r = 0; r < VISUAL_ACTION_REPEAT; r += 1) sim.step(action, constantRng);
        const childState = sim.clone();
        const isDead = childState.blob.state === BLOB_STATE_DEAD || childState.ending || childState.ended;
        const depth = node.depth + VISUAL_ACTION_REPEAT;
        const child: VisualNode = {
          state: childState,
          depth,
          isDead,
          blobX: childState.blob.x,
          blobY: childState.blob.y,
          parentX: node.blobX,
          parentY: node.blobY,
          g: depth * 0.9 + (isDead ? VISUAL_DEATH_PENALTY : 0),
          h: Math.max(0, childState.blob.y - goalY) / VISUAL_BLOB_JUMP
            + this.visualWaterPenalty(childState.blob.y, childState.waterY),
        };
        segments.push({
          x0: child.parentX,
          y0: child.parentY,
          x1: child.blobX,
          y1: child.blobY,
          depth,
          kind: isDead ? 'dead' : 'branch',
        });
        nodeCount += 1;
        if (!isDead) open.push(child);
      }
    }

    return segments;
  }

  private buildPlanSegments(startSnap: SimSnapshot, plan: boolean[]): Segment[] {
    const sim = this.sim;
    const segments: Segment[] = [];
    sim.restore(startSnap);

    for (let i = 0; i < plan.length; i += VISUAL_ACTION_REPEAT) {
      const x0 = sim.blob.x;
      const y0 = sim.blob.y;
      let depth = i;
      for (let r = 0; r < VISUAL_ACTION_REPEAT && i + r < plan.length; r += 1) {
        sim.step(plan[i + r], constantRng);
        depth = i + r + 1;
      }
      segments.push({
        x0,
        y0,
        x1: sim.blob.x,
        y1: sim.blob.y,
        depth,
        kind: sim.blob.state === BLOB_STATE_DEAD || sim.ending || sim.ended ? 'dead' : 'best',
      });
      if (sim.blob.state === BLOB_STATE_DEAD || sim.ending || sim.ended) break;
    }

    return segments;
  }

  private visualWaterPenalty(blobY: number, waterY: number): number {
    const margin = waterY - blobY;
    if (margin > 200) return 0;
    if (margin < 0) return 600 + -margin * 2;
    return (200 - margin) * (200 - margin) / 80;
  }

  private scoreCandidate(start: SimSnapshot, end: SimSnapshot, totalTicks: number, waitTicks: number): number {
    if (end.blob.state === BLOB_STATE_DEAD || end.ending || end.ended) return -1_000_000;

    const startWheel = start.blob.cwIdx >= 0 ? start.blob.cwIdx : 0;
    const endWheel = end.blob.cwIdx >= 0 ? end.blob.cwIdx : 0;
    const wheelGain = Math.max(0, endWheel - startWheel);
    const heightGain = end.maxHeight - start.maxHeight;
    const yGain = start.blob.y - end.blob.y;
    const waterMargin = end.waterY - end.blob.y;
    const waterPenalty = waterMargin < WATER_SAFETY_MARGIN
      ? (WATER_SAFETY_MARGIN - waterMargin) * 30
      : 0;
    const stateBonus =
      end.blob.state === BLOB_STATE_GRAB ? 800 :
        end.blob.state === BLOB_STATE_WALL ? 500 :
          -1_000;
    const backtrackPenalty = end.blob.y > start.blob.y + 20
      ? (end.blob.y - start.blob.y) * 25
      : 0;

    return (
      end.maxHeight +
      heightGain * 9 +
      yGain * 4 +
      wheelGain * 900 +
      endWheel * 10 +
      stateBonus -
      totalTicks * 4 -
      waitTicks * 1.5 -
      waterPenalty -
      backtrackPenalty
    );
  }
}
