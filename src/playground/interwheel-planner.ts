import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  type InterwheelSim,
  type SimSnapshot,
} from '../games/interwheel/index';

const BLOB_JUMP = 12; // mirrors BLOB_JUMP in interwheel
const DEATH_PENALTY = 1_000_000;
const ACTION_REPEAT = 2; // Mario's stepsPerSearch — apply each action for N ticks per node

// Constant RNG used during search — sim's `step` consumes one rng draw on
// destroyed-wheel ticks for cosmetic dust, but cosmetic outcomes don't
// affect blob trajectory. A constant function keeps planning fully
// deterministic without touching the live PRNG.
const constantRng = () => 0.5;

type Node = {
  state: SimSnapshot;
  parent: Node | null;
  action: boolean; // press from parent → here
  depth: number;
  isDead: boolean;
  blobX: number;
  blobY: number;
  parentX: number;
  parentY: number;
  g: number;
  h: number;
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
      this.replanIn = 2; // mirror Mario's replan-every-2-ticks cadence
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
      const startTime = performance.now();
      const startY = startSnap.blob.y;
      const goalY = startY - this.cfg.targetClimb;
      const startScore = startSnap.score;

      const root: Node = {
        state: startSnap,
        parent: null,
        action: false,
        depth: 0,
        isDead: startSnap.blob.state === BLOB_STATE_DEAD,
        blobX: startSnap.blob.x,
        blobY: startSnap.blob.y,
        parentX: startSnap.blob.x,
        parentY: startSnap.blob.y,
        g: 0,
        h: 0,
      };

      const open: Node[] = [root];
      const allNodes: Node[] = [];
      let best: Node = root;
      let bestF = Infinity;
      let nodeCount = 0;

      // Water-threat term — encourages the agent to move *up* away from
      // rising water rather than sit indefinitely on a wheel. h_water grows
      // sharply as the blob approaches the water line.
      const waterPenalty = (blobY: number, waterY: number): number => {
        const margin = waterY - blobY; // blob is above water => positive
        if (margin > 200) return 0;
        if (margin < 0) return 600 + -margin * 2; // already in water
        return (200 - margin) * (200 - margin) / 80;
      };

      while (open.length > 0 && nodeCount < this.cfg.maxNodes) {
        if ((nodeCount & 31) === 0 && performance.now() - startTime > this.cfg.budgetMs) break;

        // Pop lowest-f node (linear scan; node count stays modest).
        let minIdx = 0;
        let minF = open[0].g + open[0].h;
        for (let i = 1; i < open.length; i += 1) {
          const ff = open[i].g + open[i].h;
          if (ff < minF) {
            minF = ff;
            minIdx = i;
          }
        }
        const node = open[minIdx];
        open[minIdx] = open[open.length - 1];
        open.pop();

        if (node.isDead) continue;
        if (node.depth >= this.cfg.maxDepth) continue;

        // In Fly state the press button is ignored, so only one child is
        // unique. In Grab/Wall states we branch on both.
        const actions = node.state.blob.state === BLOB_STATE_FLY ? [false] : [false, true];

        for (const action of actions) {
          sim.restore(node.state);
          // Apply each action for N ticks (Mario's stepsPerSearch). We only
          // record the start+end of the multi-tick segment for visualization
          // — that's what the Mario agent does too.
          for (let r = 0; r < ACTION_REPEAT; r += 1) sim.step(action, constantRng);
          const childState = sim.clone();
          const isDead = childState.blob.state === BLOB_STATE_DEAD;
          const newDepth = node.depth + ACTION_REPEAT;
          const child: Node = {
            state: childState,
            parent: node,
            action,
            depth: newDepth,
            isDead,
            blobX: childState.blob.x,
            blobY: childState.blob.y,
            parentX: node.blobX,
            parentY: node.blobY,
            g: newDepth * 0.9 + (isDead ? DEATH_PENALTY : 0),
            // h combines: time-to-climb-target and water threat. Score
            // reward intentionally weighted at 0 by default — pilot
            // benchmarks showed any positive weight made the agent dive
            // into mines for pastilles. Reintroduce after better tuning.
            h: Math.max(0, childState.blob.y - goalY) / BLOB_JUMP
              + waterPenalty(childState.blob.y, childState.waterY),
          };
          allNodes.push(child);
          nodeCount += 1;
          if (!isDead) open.push(child);

          if (!isDead) {
            const f = child.g + child.h;
            if (f < bestF || (f === bestF && child.blobY < best.blobY)) {
              best = child;
              bestF = f;
            }
          }
        }
      }

      const onBest = new Set<Node>();
      let cur: Node | null = best;
      while (cur) {
        onBest.add(cur);
        cur = cur.parent;
      }

      const segments: Segment[] = allNodes.map((n) => ({
        x0: n.parentX,
        y0: n.parentY,
        x1: n.blobX,
        y1: n.blobY,
        depth: n.depth,
        kind: n.isDead ? 'dead' : onBest.has(n) ? 'best' : 'branch',
      }));

      const plan: boolean[] = [];
      cur = best;
      while (cur && cur.parent) {
        // Each search step covered ACTION_REPEAT live ticks of the same
        // press value — expand back to live-tick granularity.
        for (let r = 0; r < ACTION_REPEAT; r += 1) plan.unshift(cur.action);
        cur = cur.parent;
      }

      return { plan, segments, startBlobY: startY };
    } finally {
      sim.restore(startSnap);
    }
  }
}
