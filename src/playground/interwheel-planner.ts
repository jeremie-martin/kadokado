import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  BLOB_STATE_GRAB,
  BLOB_STATE_WALL,
  InterwheelSim as ScratchInterwheelSim,
  SCORE_PASTILLE,
  STAGE_HEIGHT,
  clamp,
  type InterwheelSim,
  type SimSnapshot,
} from '../games/interwheel/sim';
import { renderedGenerationLimitForSearchDepth } from './trajectory-rendering';

// Constant RNG used during search. The simulator may consume an RNG draw for
// cosmetic-but-stateful parity cases, but search outcomes do not depend on the
// sampled value.
const constantRng = () => 0.5;

const MAX_GRAB_WAIT = 100;
const MAX_WALL_WAIT = 24;
const MAX_FLIGHT_TICKS = 260;
// The overlay is redrawn from a fresh plan every live tick. If trajectory
// samples are sparse, the final chord into a stable launch/landing endpoint
// changes phase each frame (`remainingTicks % samplePeriod`), which looks like
// endpoint flicker even when the contact point itself is unchanged. Keep
// display trajectories tick-accurate; this is playground-only debug data.
const TRAJECTORY_SAMPLE_TICKS = 1;
const ROOT_GRAB_WAIT_STEP = 1;
const ROOT_WALL_WAIT_STEP = 1;
const DEEP_GRAB_WAIT_STEP = 4;
const DEEP_WALL_WAIT_STEP = 2;
// Defaults for the lineage-support pass; mirrored on the planner instance
// so the playground can override them at runtime via setLineage().
//
// gamma: leaf seed curve. Only leaf/frontier edges seed visual support, using
//   rank-of-value^gamma. Higher values mean only top reachable futures pull their
//   ancestors up; γ=1 makes mediocre futures contribute proportionally too.
// decay: fraction of a child's support a parent inherits in the bottom-up
//   pass. decay=0 makes only leaves visible as important; decay near 1
//   amplifies common prefixes that lead to many strong futures.
export const LINEAGE_DEFAULTS: { gamma: number; decay: number } = {
  gamma: 4,
  decay: 0.65,
};

// === Planner physics constants (named, not user-tunable) ===
// These shape "what the planner believes about the world" — distinct from
// user policy weights. They appear in `scoreCandidate()` as named constants
// rather than inline magic numbers.

// --- Frontier / safety ---
// Death (terminal blob state) score cost. So large it always dominates.
const TERMINAL_DEATH_COST = 1_000_000;
// Score cost when the blob is still in flight at the search horizon: the
// planner can't reason about an unresolved trajectory, so treat it as worse
// than any stable landing.
const UNRESOLVED_FLIGHT_PENALTY = 50_000;
// Per-pixel score cost when the blob is below the water-safety margin.
const WATER_DEFICIT_GRADIENT = 30;
// Minimum px above water before water-safety penalty kicks in.
const WATER_SAFETY_MARGIN = 160;
// Px above water at which water urgency drops to zero (no influence on
// climb/collect modulation). Between SAFETY and FAR, urgency lerps 1 → 0.
const WATER_URGENCY_FAR = 320;
// Multiplier coupling water urgency to climb (boost) and collect/miss
// (damp). Hidden contextual modulator: as water rises, urgency → 1, climb
// scales by (1 + 1.2), collect scales by (1 - 0.85). Documented physics.
const WATER_CLIMB_BOOST = 1.2;
const WATER_COLLECT_DAMP = 0.85;
// Per-state stability bonus added to the leaf score. GRAB > WALL > FALLBACK.
// Independent of policy: encourages the planner to land on stable surfaces.
const STATE_BONUS: Record<number, number> = {
  [BLOB_STATE_GRAB]: 850,
  [BLOB_STATE_WALL]: 600,
};
const STATE_BONUS_FALLBACK = -1_000;

// --- Edge-local quality penalties ---
// Backtrack: edges that end significantly below their start are penalized
// per-pixel of lost height (scaled by GRADIENT). Uses a small grace zone so
// minor pendulum-down arcs don't get charged.
const BACKTRACK_GRACE_PX = 20;
const BACKTRACK_GRADIENT = 25;
// Loop: same-stable-target edge with no pickup and minimal y-gain is a wasted
// scoop. Flat penalty.
const LOOP_PENALTY = 650;
const LOOP_GAIN_THRESH_PX = 20;

// --- Game scoring rules (inherent to pastille/spark values) ---
// Per-pastille and per-spark internal weighting in the collect signal.
// Pastille values are 250 / 1000 / 5000 (green/blue/gold); sparks have
// per-event scores. These weights ensure spark-density routes and pastille-
// density routes are valued comparably.
const PASTILLE_VALUE_WEIGHT = 1.5;
const SPARK_VALUE_WEIGHT = 3;
// Proximity-bounded miss penalty: only count uncollected pastilles the path
// passed within MISS_PROXIMITY_PX of, with cubic falloff. Anything farther
// is unreachable from the chosen route; charging it would over-broaden the
// signal. Cubic exponent peaks the penalty for "barely missed" cases.
const MISS_PROXIMITY_PX = 300;
const MISS_PROXIMITY_PX_SQ = MISS_PROXIMITY_PX * MISS_PROXIMITY_PX;
const MISS_PROXIMITY_EXP = 3;
// Internal default: missWeight = collect × FIXED_MISS_RATIO. Couples the
// existing "miss penalty proportional to collect reward" semantics from the
// old `policy.collectibles` arm. Power users could decouple by exposing a
// separate `miss` weight; not exposed today.
const FIXED_MISS_RATIO = 1.0;

// --- Search-bias decay (not in scoreCandidate, but related) ---
const NODE_BIAS_DECAY_PX = 400;
const NODE_BIAS_FACTOR = 1.5;
// Tube-claim mechanism (currently dormant: claimRadius defaulted to 0 and
// dropped from UI per the audit; mechanism kept in code for future use).
const COLLECT_PICKUP_RADIUS = 70;

type CollectReward = {
  pickedValue: number;
  sparkScore: number;
  collectedKeys: Set<string>;
  pickedValuesByKey: Map<string, number>;
  // Parallel to currentPerceived.snap.pastilles; squared min distance from
  // sampled blob positions to that pastille. Edge rewards track one edge;
  // node path rewards track the whole root-to-node path.
  minDistSq: Float64Array;
};

type PerceivedSnapshot = {
  snap: SimSnapshot;
  perceivedWheels: number;
  perceivedPastilles: number;
};

type SearchNode = {
  id: number;
  parentId: number;
  edgeId: number;
  state: SimSnapshot;
  depth: number;
  totalTicks: number;
  value: number;
  collectibleBias: number;
  pathReward: CollectReward;
  /** Highest y reached anywhere on this root-to-node path (min in screen coords). */
  pathApexY: number;
  /** Sum-of-edge-integrals of perpendicular distance from each path sample to its edge's start→end chord. */
  pathOffAxis: number;
  /** Cumulative tick count where blob.state was BLOB_STATE_WALL across path edges. */
  pathWallTicks: number;
};

type SearchEdge = {
  id: number;
  parentId: number;
  childId: number;
  waitTicks: number;
  plan: boolean[];
  endState: SimSnapshot;
  isDead: boolean;
  isStable: boolean;
  value: number;
  reward: CollectReward;
  pathReward: CollectReward;
  scoreBreakdown: CandidateScoreBreakdown;
  segments: SegmentBody[];
  pathApexY: number;
  pathOffAxis: number;
  pathWallTicks: number;
};

export type Segment = {
  edgeId: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  depth: number;
  localTick: number;
  support: number;
  onChosenChain: boolean;
  isLeaf: boolean;
  // Search-tree depth of this edge's child node. 1 = first jump from root,
  // 2 = second jump, etc. Used by generation color, render capping, and
  // generation width weights.
  generation: number;
};

type SegmentBody = Omit<Segment, 'edgeId' | 'support' | 'onChosenChain' | 'isLeaf' | 'generation'>;

export type PlannerDiagnostics = {
  // Leaves (frontier edges) of the search tree.
  leafCount: number;
  // leafDepthCounts[d] = number of leaves at depth d. Index 0 is unused.
  leafDepthCounts: number[];
  // Leaf-edge value distribution. p10/p25/p50/p75/p90 are sample percentiles.
  leafValueMin: number;
  leafValueP10: number;
  leafValueP25: number;
  leafValueP50: number;
  leafValueP75: number;
  leafValueP90: number;
  leafValueMax: number;
  // Post-propagation support distribution across all rendered edges. Useful
  // to test whether one chain visibly dominates: a sharp tree has high
  // top-share, a flat fan has low top-share.
  supportTopShare: number;
  supportTop3Share: number;
  supportChosenShare: number;
  supportTotal: number;
};

export type PlannerStats = {
  mode: 'dead' | 'flight' | 'idle' | 'stable';
  planMs: number;
  edgesEvaluated: number;
  stableNodesExpanded: number;
  perceivedWheels: number;
  perceivedPastilles: number;
  segments: number;
  bestScore: number;
  bestScoreBreakdown: CandidateScoreBreakdown;
  diagnostics: PlannerDiagnostics;
};

export function emptyDiagnostics(): PlannerDiagnostics {
  return {
    leafCount: 0,
    leafDepthCounts: [],
    leafValueMin: 0,
    leafValueP10: 0,
    leafValueP25: 0,
    leafValueP50: 0,
    leafValueP75: 0,
    leafValueP90: 0,
    leafValueMax: 0,
    supportTopShare: 0,
    supportTop3Share: 0,
    supportChosenShare: 0,
    supportTotal: 0,
  };
}

export type PlanResult = {
  plan: boolean[];
  segments: Segment[];
  startBlobY: number;
  stats: PlannerStats;
};

export type PlannerConfig = {
  budgetMs?: number;
  maxNodes?: number;
  maxDepth?: number;
  maxEdgeRollouts?: number;
  maxStableDepth?: number;
  revealScreensAbove?: number;
  memoryScreensBelow?: number;
  collectSegments?: boolean;
  policy?: Partial<PlannerPolicy>;
};

export type PlannerPolicy = {
  /** How much to value path height (px climbed from root to leaf apex). */
  climb: number;
  /** How much to value claimed collectibles (pastilles + sparks, path-cumulative). */
  collect: number;
  /** How much to value time spent on a wall (path-cumulative tick count). */
  wall: number;
  /** Per-tick time cost on the path. */
  pace: number;
  /** Per-pixel-tick cost of off-axis path travel (lateral wandering). */
  detour: number;
  /**
   * Defer-grab discount in [0, 1]. When an edge realizes a pickup whose
   * pastille is also reachable via any other perceived wheel's orbit above
   * the agent, discount the realized contribution by this fraction. 0 = off.
   */
  patience: number;
};

export type CandidateScoreBreakdown = {
  // Knob-driven terms (one line per user knob, scaling one signal each).
  climb: number;
  collect: number;
  wall: number;
  pace: number;
  detour: number;
  // Internal mechanisms (planner physics, not user-tunable).
  miss: number;
  stability: number;
  safety: number;
  backtrack: number;
  loop: number;
  total: number;
};

// Operating point set by the Phase 2 confirmation sweep
// (docs/interwheel-policy-audit.md, .tmp/interwheel-knobs/2026-05-08T14-23-02-163Z).
// climb=1.0, collect=1.0, detour=0.5, patience=0.65 beats the prior default
// (climb=1.08, collect=1.2, detour=0, patience=0) by +231m / +27% score
// at default planner config.
export const DEFAULT_PLANNER_POLICY: PlannerPolicy = {
  climb: 1.0,
  collect: 1.0,
  wall: 0.65,
  pace: 1.0,
  detour: 0.5,
  patience: 0.65,
};

export const PLANNER_PERCEPTION_DEFAULTS = {
  revealScreensAbove: 0.5,
  memoryScreensBelow: 2,
};

export const PLANNER_SEARCH_DEFAULTS = {
  budgetMs: 5,
  maxEdgeRollouts: 360,
  maxStableDepth: 4,
};

export function resolvePlannerPolicy(policy: Partial<PlannerPolicy> = {}): PlannerPolicy {
  return {
    ...DEFAULT_PLANNER_POLICY,
    ...policy,
  };
}

export function emptyScoreBreakdown(total = 0): CandidateScoreBreakdown {
  return {
    climb: 0,
    collect: 0,
    wall: 0,
    pace: 0,
    detour: 0,
    miss: 0,
    stability: 0,
    safety: 0,
    backtrack: 0,
    loop: 0,
    total,
  };
}

export class InterwheelPlanner {
  private readonly sim: InterwheelSim;
  private readonly scratch = new ScratchInterwheelSim();
  private readonly cfg: Required<Omit<PlannerConfig, 'policy'>> & { policy: PlannerPolicy };

  private lastResult: PlanResult | null = null;
  private knownWheelIdx = new Set<number>();
  private knownPastilleKeys = new Set<string>();
  private lastSeenTick = -1;
  private currentPerceived: PerceivedSnapshot | null = null;
  private currentPerceivedKeys: string[] = [];
  // Set once per plan in planStable() so the patienceDiscount path can look up
  // "is this pastille reachable from a higher wheel" without re-scanning every
  // pickup credit.
  private currentStableClaimable = new Set<string>();
  private lineageGamma = LINEAGE_DEFAULTS.gamma;
  private lineageDecay = LINEAGE_DEFAULTS.decay;

  constructor(sim: InterwheelSim, cfg: PlannerConfig = {}) {
    this.sim = sim;
    const maxEdgeRollouts = cfg.maxEdgeRollouts ?? cfg.maxNodes ?? PLANNER_SEARCH_DEFAULTS.maxEdgeRollouts;
    const maxStableDepth = cfg.maxStableDepth ?? cfg.maxDepth ?? PLANNER_SEARCH_DEFAULTS.maxStableDepth;
    this.cfg = {
      budgetMs: cfg.budgetMs ?? PLANNER_SEARCH_DEFAULTS.budgetMs,
      maxNodes: cfg.maxNodes ?? maxEdgeRollouts,
      maxDepth: cfg.maxDepth ?? maxStableDepth,
      maxEdgeRollouts,
      maxStableDepth,
      revealScreensAbove: cfg.revealScreensAbove ?? PLANNER_PERCEPTION_DEFAULTS.revealScreensAbove,
      memoryScreensBelow: cfg.memoryScreensBelow ?? PLANNER_PERCEPTION_DEFAULTS.memoryScreensBelow,
      collectSegments: cfg.collectSegments ?? true,
      policy: resolvePlannerPolicy(cfg.policy),
    };
  }

  step(): { press: boolean; result: PlanResult | null } {
    const t0 = performance.now();
    const result = this.plan();
    result.stats.planMs = performance.now() - t0;
    result.stats.segments = result.segments.length;
    this.lastResult = result;
    return { press: result.plan[0] ?? false, result };
  }

  lastSegments(): Segment[] {
    return this.lastResult?.segments ?? [];
  }

  lastStats(): PlannerStats | null {
    return this.lastResult?.stats ?? null;
  }

  policy(): PlannerPolicy {
    return { ...this.cfg.policy };
  }

  setPolicy(policy: Partial<PlannerPolicy>): void {
    this.cfg.policy = resolvePlannerPolicy(policy);
    this.lastResult = null;
  }

  setLineage(params: { gamma?: number; decay?: number }): void {
    if (params.gamma !== undefined) this.lineageGamma = Math.max(0.1, params.gamma);
    if (params.decay !== undefined) this.lineageDecay = clamp(params.decay, 0, 1);
    this.lastResult = null;
  }

  getLineage(): { gamma: number; decay: number } {
    return { gamma: this.lineageGamma, decay: this.lineageDecay };
  }

  setRevealScreensAbove(screens: number): void {
    this.cfg.revealScreensAbove = clamp(screens, 0, 4);
    this.invalidate();
  }

  getRevealScreensAbove(): number {
    return this.cfg.revealScreensAbove;
  }

  setSearchLimits(params: { maxStableDepth?: number; maxEdgeRollouts?: number; budgetMs?: number }): void {
    if (params.maxStableDepth !== undefined) {
      const depth = Math.round(clamp(params.maxStableDepth, 1, 8));
      this.cfg.maxStableDepth = depth;
      this.cfg.maxDepth = depth;
    }
    if (params.maxEdgeRollouts !== undefined) {
      const rollouts = Math.round(clamp(params.maxEdgeRollouts, 16, 2_000));
      this.cfg.maxEdgeRollouts = rollouts;
      this.cfg.maxNodes = rollouts;
    }
    if (params.budgetMs !== undefined) {
      this.cfg.budgetMs = clamp(params.budgetMs, 1, 50);
    }
    this.lastResult = null;
  }

  getSearchLimits(): { maxStableDepth: number; maxEdgeRollouts: number; budgetMs: number } {
    return {
      maxStableDepth: this.cfg.maxStableDepth,
      maxEdgeRollouts: this.cfg.maxEdgeRollouts,
      budgetMs: this.cfg.budgetMs,
    };
  }

  invalidate(): void {
    this.lastResult = null;
    this.knownWheelIdx.clear();
    this.knownPastilleKeys.clear();
    this.lastSeenTick = -1;
  }

  /** Number of unique pastilles that have entered perception over this planner's lifetime. */
  uniquePerceivedPastilles(): number {
    return this.knownPastilleKeys.size;
  }

  private plan(): PlanResult {
    const fullSnap = this.sim.clone();
    if (fullSnap.tick < this.lastSeenTick) this.invalidate();
    this.lastSeenTick = fullSnap.tick;
    this.updatePerception(fullSnap);
    const perceived = this.buildPerceivedSnapshot(fullSnap);
    this.currentPerceived = perceived;
    this.currentPerceivedKeys = perceived.snap.pastilles.map((p) => this.pastilleKey(p));

    if (fullSnap.blob.state === BLOB_STATE_DEAD || fullSnap.ending || fullSnap.ended) {
      return this.emptyResult(fullSnap.blob.y, perceived, 'dead');
    }

    if (perceived.snap.blob.state === BLOB_STATE_FLY) {
      return this.planPassiveFlight(perceived);
    }

    if (perceived.snap.blob.state !== BLOB_STATE_GRAB && perceived.snap.blob.state !== BLOB_STATE_WALL) {
      return this.emptyResult(fullSnap.blob.y, perceived, 'idle');
    }

    return this.planStable(perceived);
  }

  private planStable(perceived: PerceivedSnapshot): PlanResult {
    const rootState = perceived.snap;
    const startTime = performance.now();
    this.currentStableClaimable = this.computeStableClaimableSet(rootState);
    const emptyRootReward = this.emptyCollectReward(this.currentPerceivedKeys.length);
    const rootReward = this.extendCollectReward(
      emptyRootReward,
      this.stableSurfaceCollectReward(rootState, emptyRootReward),
    );
    const rootScore = this.scoreCandidate(
      rootState,
      rootState,
      rootState,
      0,
      rootReward,
      rootReward,
      rootState.blob.y,
      0,
      0,
      false,
    );
    const root: SearchNode = {
      id: 0,
      parentId: -1,
      edgeId: -1,
      state: rootState,
      depth: 0,
      totalTicks: 0,
      value: rootScore.total,
      collectibleBias: this.collectibleBias(rootState),
      pathReward: rootReward,
      pathApexY: rootState.blob.y,
      pathOffAxis: 0,
      pathWallTicks: 0,
    };

    const nodes: SearchNode[] = [root];
    const edges: SearchEdge[] = [];
    const open: SearchNode[] = [root];
    let fallbackEdge: SearchEdge | null = null;
    let stableNodesExpanded = 0;

    while (open.length > 0 && edges.length < this.cfg.maxEdgeRollouts) {
      if ((edges.length & 15) === 0 && performance.now() - startTime > this.cfg.budgetMs) break;
      const node = this.popBestNode(open, rootState);
      if (node.depth >= this.cfg.maxStableDepth) continue;
      stableNodesExpanded += 1;

      for (const waitTicks of this.waitSamples(node.state, node.depth)) {
        if (edges.length >= this.cfg.maxEdgeRollouts) break;
        const edge = this.evaluateEdge(rootState, node, waitTicks, edges.length);
        edges.push(edge);
        if (!fallbackEdge || edge.value > fallbackEdge.value) fallbackEdge = edge;

        const child: SearchNode = {
          id: nodes.length,
          parentId: node.id,
          edgeId: edge.id,
          state: edge.endState,
          depth: node.depth + 1,
          totalTicks: node.totalTicks + edge.plan.length,
          value: edge.value,
          collectibleBias: this.collectibleBias(edge.endState),
          pathReward: edge.pathReward,
          pathApexY: edge.pathApexY,
          pathOffAxis: edge.pathOffAxis,
          pathWallTicks: edge.pathWallTicks,
        };
        edge.childId = child.id;
        nodes.push(child);

        if (!edge.isDead && edge.isStable) {
          open.push(child);
        }
      }
    }

    const targetNode = this.bestStableLeafNode(nodes, edges)
      ?? this.bestStableNode(nodes, edges)
      ?? (fallbackEdge ? nodes[fallbackEdge.childId] : root);
    const bestEdgeIds = this.bestEdgeIds(nodes, targetNode);
    const plan = this.planForNode(nodes, edges, targetNode);
    const supportResult = this.lineageSupportForEdges(nodes, edges);
    const segments = this.cfg.collectSegments ? this.segmentsForEdges(edges, bestEdgeIds, supportResult.support, nodes) : [];
    const bestScoreBreakdown = this.scoreBreakdownForNode(edges, targetNode) ?? rootScore;
    const diagnostics = this.computeDiagnostics(nodes, edges, supportResult, bestEdgeIds);
    return {
      plan: plan.length > 0 ? plan : [false],
      segments,
      startBlobY: rootState.blob.y,
      stats: {
        mode: 'stable',
        planMs: 0,
        edgesEvaluated: edges.length,
        stableNodesExpanded,
        perceivedWheels: perceived.perceivedWheels,
        perceivedPastilles: perceived.perceivedPastilles,
        segments: segments.length,
        bestScore: targetNode.value,
        bestScoreBreakdown,
        diagnostics,
      },
    };
  }

  private planPassiveFlight(perceived: PerceivedSnapshot): PlanResult {
    const sim = this.scratch;
    const plan: boolean[] = [];
    const segments: Segment[] = [];
    sim.restore(perceived.snap);

    let ticks = 0;
    let sx = sim.blob.x;
    let sy = sim.blob.y;
    while (
      sim.blob.state === BLOB_STATE_FLY &&
      !sim.ending &&
      !sim.ended &&
      ticks < MAX_FLIGHT_TICKS
    ) {
      sim.step(false, constantRng);
      plan.push(false);
      ticks += 1;
      if (this.cfg.collectSegments && ((ticks % TRAJECTORY_SAMPLE_TICKS) === 0 || sim.blob.state !== BLOB_STATE_FLY)) {
        segments.push({
          edgeId: 0,
          x0: sx,
          y0: sy,
          x1: sim.blob.x,
          y1: sim.blob.y,
          depth: ticks,
          localTick: ticks,
          support: 0,
          onChosenChain: true,
          isLeaf: true,
          generation: 1,
        });
        sx = sim.blob.x;
        sy = sim.blob.y;
      }
    }

    return {
      plan: plan.length > 0 ? plan : [false],
      segments,
      startBlobY: perceived.snap.blob.y,
      stats: {
        mode: 'flight',
        planMs: 0,
        edgesEvaluated: 0,
        stableNodesExpanded: 0,
        perceivedWheels: perceived.perceivedWheels,
        perceivedPastilles: perceived.perceivedPastilles,
        segments: segments.length,
        bestScore: 0,
        bestScoreBreakdown: emptyScoreBreakdown(),
        diagnostics: emptyDiagnostics(),
      },
    };
  }

  private evaluateEdge(rootState: SimSnapshot, parent: SearchNode, waitTicks: number, edgeId: number): SearchEdge {
    const sim = this.scratch;
    const plan: boolean[] = [];
    const segments: SegmentBody[] = [];
    const perceivedPastilles = this.currentPerceived?.snap.pastilles ?? [];
    const reward = this.emptyCollectReward(perceivedPastilles.length);
    sim.restore(parent.state);

    let sx = sim.blob.x;
    let sy = sim.blob.y;
    const edgeStartX = sim.blob.x;
    const edgeStartY = sim.blob.y;
    // Edge-local accumulators. Tracking start position too gives the off-axis
    // integral and apex-min full path coverage including the resting state.
    let edgeApexY = sim.blob.y;
    let edgeWallTicks = sim.blob.state === BLOB_STATE_WALL ? 1 : 0;
    const samplesX: number[] = [edgeStartX];
    const samplesY: number[] = [edgeStartY];
    const recordStep = (press: boolean): void => {
      sim.step(press, constantRng);
      plan.push(press);
      this.collectStepReward(sim, reward);
      samplesX.push(sim.blob.x);
      samplesY.push(sim.blob.y);
      if (sim.blob.y < edgeApexY) edgeApexY = sim.blob.y;
      if (sim.blob.state === BLOB_STATE_WALL) edgeWallTicks += 1;
      if (perceivedPastilles.length > 0) {
        const bx = sim.blob.x, by = sim.blob.y;
        for (let i = 0; i < perceivedPastilles.length; i += 1) {
          const p = perceivedPastilles[i];
          const dx = p.x - bx, dy = p.y - by;
          const d2 = dx * dx + dy * dy;
          if (d2 < reward.minDistSq[i]) reward.minDistSq[i] = d2;
        }
      }
      if (!this.cfg.collectSegments) return;
      const terminal = sim.blob.state !== BLOB_STATE_GRAB && sim.blob.state !== BLOB_STATE_WALL && sim.blob.state !== BLOB_STATE_FLY;
      const shouldRecord =
        press ||
        terminal ||
        sim.ending ||
        sim.ended ||
        (plan.length % TRAJECTORY_SAMPLE_TICKS) === 0 ||
        (sim.blob.state !== BLOB_STATE_GRAB && sim.blob.state !== BLOB_STATE_WALL && plan[plan.length - 2] === true);
      if (shouldRecord) {
        segments.push({
          x0: sx,
          y0: sy,
          x1: sim.blob.x,
          y1: sim.blob.y,
          depth: parent.totalTicks + plan.length,
          localTick: plan.length,
        });
        sx = sim.blob.x;
        sy = sim.blob.y;
      }
    };

    for (let i = 0; i < waitTicks; i += 1) {
      recordStep(false);
      if (this.isTerminal(sim)) break;
    }

    if (!this.isTerminal(sim) && (sim.blob.state === BLOB_STATE_GRAB || sim.blob.state === BLOB_STATE_WALL)) {
      recordStep(true);
    }

    let flightTicks = 0;
    while (
      sim.blob.state === BLOB_STATE_FLY &&
      !sim.ending &&
      !sim.ended &&
      flightTicks < MAX_FLIGHT_TICKS
    ) {
      recordStep(false);
      flightTicks += 1;
    }

    const endState = sim.clone();
    if (this.cfg.collectSegments && (segments.length === 0 || segments[segments.length - 1].x1 !== endState.blob.x || segments[segments.length - 1].y1 !== endState.blob.y)) {
      segments.push({
        x0: sx,
        y0: sy,
        x1: endState.blob.x,
        y1: endState.blob.y,
        depth: parent.totalTicks + plan.length,
        localTick: plan.length,
      });
    }

    const isDead = this.isTerminal(endState);
    const isStable = endState.blob.state === BLOB_STATE_GRAB || endState.blob.state === BLOB_STATE_WALL;
    const sameStableTarget = this.isSameStableTarget(parent.state, endState);
    const effectiveReward = sameStableTarget
      ? this.emptyCollectReward(perceivedPastilles.length)
      : reward;
    let pathReward = this.extendCollectReward(parent.pathReward, effectiveReward);
    if (isStable) pathReward = this.extendCollectReward(pathReward, this.stableSurfaceCollectReward(endState, pathReward));
    // sameStableTarget edges are scoops that landed back where they started;
    // their off-axis integral would dominate detour penalties without
    // representing real path progress. Skip the integral but keep the apex
    // because reaching a high arc on the way still happened.
    const edgeOffAxis = sameStableTarget
      ? 0
      : this.edgeOffAxisIntegral(samplesX, samplesY, edgeStartX, edgeStartY, endState.blob.x, endState.blob.y);
    const pathApexY = Math.min(parent.pathApexY, edgeApexY);
    const pathOffAxis = parent.pathOffAxis + edgeOffAxis;
    const pathWallTicks = parent.pathWallTicks + edgeWallTicks;
    const scoreBreakdown = this.scoreCandidate(
      rootState,
      parent.state,
      endState,
      parent.totalTicks + plan.length,
      pathReward,
      effectiveReward,
      pathApexY,
      pathOffAxis,
      pathWallTicks,
      sameStableTarget,
    );
    const value = scoreBreakdown.total;
    return {
      id: edgeId,
      parentId: parent.id,
      childId: -1,
      waitTicks,
      plan,
      endState,
      isDead,
      isStable,
      value,
      reward,
      pathReward,
      scoreBreakdown,
      segments,
      pathApexY,
      pathOffAxis,
      pathWallTicks,
    };
  }

  private edgeOffAxisIntegral(
    samplesX: number[],
    samplesY: number[],
    sxEdge: number,
    syEdge: number,
    exEdge: number,
    eyEdge: number,
  ): number {
    const dx = exEdge - sxEdge;
    const dy = eyEdge - syEdge;
    const chordLen = Math.sqrt(dx * dx + dy * dy);
    if (chordLen < 1e-6 || samplesX.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < samplesX.length; i += 1) {
      const px = samplesX[i] - sxEdge;
      const py = samplesY[i] - syEdge;
      sum += Math.abs(dx * py - dy * px) / chordLen;
    }
    return sum;
  }

  private emptyCollectReward(pastilleCount: number): CollectReward {
    const minDistSq = new Float64Array(pastilleCount);
    for (let i = 0; i < minDistSq.length; i += 1) minDistSq[i] = Infinity;
    return {
      pickedValue: 0,
      sparkScore: 0,
      collectedKeys: new Set<string>(),
      pickedValuesByKey: new Map<string, number>(),
      minDistSq,
    };
  }

  private extendCollectReward(parent: CollectReward, edge: CollectReward): CollectReward {
    const pickedValuesByKey = new Map(parent.pickedValuesByKey);
    const collectedKeys = new Set(parent.collectedKeys);
    let pickedValue = parent.pickedValue;

    for (const [key, value] of edge.pickedValuesByKey) {
      if (collectedKeys.has(key)) continue;
      collectedKeys.add(key);
      pickedValuesByKey.set(key, value);
      pickedValue += value;
    }

    const n = Math.max(parent.minDistSq.length, edge.minDistSq.length);
    const minDistSq = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      const parentDist = i < parent.minDistSq.length ? parent.minDistSq[i] : Infinity;
      const edgeDist = i < edge.minDistSq.length ? edge.minDistSq[i] : Infinity;
      minDistSq[i] = Math.min(parentDist, edgeDist);
    }

    return {
      pickedValue,
      sparkScore: parent.sparkScore + edge.sparkScore,
      collectedKeys,
      pickedValuesByKey,
      minDistSq,
    };
  }

  private collectStepReward(sim: ScratchInterwheelSim, reward: CollectReward): void {
    for (const pastille of sim.events.collectedPastilles) {
      this.creditPastilleReward(pastille, reward, true);
    }
    for (const spark of sim.events.collectedSparks) {
      reward.sparkScore += spark.score;
    }
  }

  // Orthogonal score formulation: each user-facing knob scales exactly one
  // path-cumulative signal, and planner physics (state bonus, water urgency,
  // backtrack/loop/safety) live as named constants distinct from policy.
  //
  //   total =
  //     + climb    × pathHeight     × waterClimbBoost
  //     + collect  × (pathClaim×PASTILLE_VALUE_WEIGHT + pathSpark×SPARK_VALUE_WEIGHT)
  //                                  × waterCollectDamp
  //     + wall     × pathWallTicks
  //     − pace     × pathTime
  //     − detour   × pathOffAxis
  //     − miss     × missProximity   × waterCollectDamp     (miss = collect × FIXED_MISS_RATIO)
  //     + endStableBonus
  //     − endSafetyCost − endBacktrackCost − endLoopCost
  //
  // pathHeight = max(0, root.y - pathApexY) is the single height signal.
  // No more 3-way mix of (maxHeight + heightGain×9 + yGain×4).
  // pathWallTicks is continuous (per-step accumulator); no tier function.
  // pace is linear (no ×4 magic, no nonlinear wait penalty).
  private scoreCandidate(
    root: SimSnapshot,
    start: SimSnapshot,
    end: SimSnapshot,
    totalTicks: number,
    pathReward: CollectReward,
    edgeReward: CollectReward,
    pathApexY: number,
    pathOffAxis: number,
    pathWallTicks: number,
    sameStableTarget: boolean,
  ): CandidateScoreBreakdown {
    const policy = this.cfg.policy;
    const waterMargin = end.waterY - end.blob.y;
    const waterUrgency = this.waterUrgency(waterMargin);
    const waterClimbBoost = 1 + waterUrgency * WATER_CLIMB_BOOST;
    const waterCollectDamp = 1 - waterUrgency * WATER_COLLECT_DAMP;

    // Knob terms — one signal each.
    const pathHeight = Math.max(0, root.blob.y - pathApexY);
    const pathClaim = pathReward.pickedValue * PASTILLE_VALUE_WEIGHT
                    + pathReward.sparkScore  * SPARK_VALUE_WEIGHT;
    const climb   = policy.climb   * pathHeight * waterClimbBoost;
    const collect = policy.collect * pathClaim  * waterCollectDamp;
    const wall    = policy.wall    * pathWallTicks;
    const pace    = policy.pace    * totalTicks;
    const detour  = policy.detour  * pathOffAxis;

    // Miss penalty: same proximity-bounded mechanism as before, but with its
    // own coefficient. Default-coupled to collect via FIXED_MISS_RATIO so
    // existing behavior is preserved when only `collect` is dialed; future
    // work could expose a separate `miss` knob.
    const missCoeff = policy.collect * FIXED_MISS_RATIO;
    const miss = missCoeff * this.missedCollectibleValue(pathReward) * waterCollectDamp;

    // Frontier physics — leaf state shapes the score independent of policy.
    const stability = STATE_BONUS[end.blob.state] ?? STATE_BONUS_FALLBACK;
    const waterPenalty = waterMargin < WATER_SAFETY_MARGIN
      ? (WATER_SAFETY_MARGIN - waterMargin) * WATER_DEFICIT_GRADIENT
      : 0;
    const flightPenalty = end.blob.state === BLOB_STATE_FLY ? UNRESOLVED_FLIGHT_PENALTY : 0;
    const safety = waterPenalty + flightPenalty;

    // Edge-local penalties (planner physics).
    const yGain = start.blob.y - end.blob.y;
    const backtrack = end.blob.y > start.blob.y + BACKTRACK_GRACE_PX
      ? (end.blob.y - start.blob.y) * BACKTRACK_GRADIENT
      : 0;
    const loop = sameStableTarget
        && edgeReward.pickedValue + edgeReward.sparkScore <= 0
        && yGain < LOOP_GAIN_THRESH_PX
      ? LOOP_PENALTY
      : 0;

    if (this.isTerminal(end)) {
      const total = climb + collect + wall - pace - detour - miss
                  - TERMINAL_DEATH_COST;
      return {
        ...emptyScoreBreakdown(),
        climb, collect, wall, pace, detour, miss,
        safety: TERMINAL_DEATH_COST,
        total,
      };
    }

    const total = climb + collect + wall + stability
                - pace - detour - miss - safety - backtrack - loop;
    return { climb, collect, wall, pace, detour, miss, stability, safety, backtrack, loop, total };
  }

  // Reaching a wheel claims pastilles on its orbit. The live agent replans
  // every tick, so the important path fact is access to the natural pickup
  // route, not whether this rollout already waited long enough to bank it.
  // Path-cumulative: claims merge into pathReward so descendants inherit them.
  private stableSurfaceCollectReward(state: SimSnapshot, prior: CollectReward): CollectReward {
    const reward = this.emptyCollectReward(this.currentPerceivedKeys.length);
    if (state.blob.state !== BLOB_STATE_GRAB || state.blob.cwIdx < 0) return reward;

    const wheel = state.wheels[state.blob.cwIdx];
    if (!wheel || wheel.destroyed) return reward;
    for (const pastille of state.pastilles) {
      if (prior.collectedKeys.has(this.pastilleKey(pastille))) continue;
      const dx = pastille.x - wheel.x;
      const dy = pastille.y - wheel.y;
      const orbitDistance = Math.abs(Math.sqrt(dx * dx + dy * dy) - wheel.ray);
      if (orbitDistance < COLLECT_PICKUP_RADIUS) this.creditPastilleReward(pastille, reward);
    }
    return reward;
  }

  private creditPastilleReward(
    pastille: { x: number; y: number; type: number },
    reward: CollectReward,
    isRealPickup = false,
  ): void {
    const key = this.pastilleKey(pastille);
    if (reward.collectedKeys.has(key)) return;
    let value = SCORE_PASTILLE[pastille.type] ?? SCORE_PASTILLE[0];
    if (
      isRealPickup
      && this.cfg.policy.patience > 0
      && this.currentStableClaimable.has(key)
    ) {
      value *= clamp(1 - this.cfg.policy.patience, 0, 1);
    }
    reward.pickedValue += value;
    reward.collectedKeys.add(key);
    reward.pickedValuesByKey.set(key, value);
  }

  private computeStableClaimableSet(rootState: SimSnapshot): Set<string> {
    const set = new Set<string>();
    if (this.cfg.policy.patience <= 0) return set;
    const wheels = rootState.wheels;
    for (const pastille of rootState.pastilles) {
      for (const wheel of wheels) {
        if (wheel.destroyed) continue;
        // Only wheels strictly above the agent count — a "later, easier"
        // claim is one the route would normally reach by climbing.
        if (wheel.y >= rootState.blob.y) continue;
        const dx = pastille.x - wheel.x;
        const dy = pastille.y - wheel.y;
        const orbitDistance = Math.abs(Math.sqrt(dx * dx + dy * dy) - wheel.ray);
        if (orbitDistance < COLLECT_PICKUP_RADIUS) {
          set.add(this.pastilleKey(pastille));
          break;
        }
      }
    }
    return set;
  }

  // Sum perceived pastille values that the route passed within
  // MISS_PROXIMITY_PX of but did not collect. Cubic proximity weight: only
  // path samples that came close enough to plausibly collect pay a meaningful
  // penalty. The prior linear weight made almost every
  // flight that came within 300px of any pastille pay something, which
  // distributed the cost broadly and flattened the collect signal.
  private missedCollectibleValue(reward: CollectReward): number {
    const perceived = this.currentPerceived?.snap.pastilles;
    if (!perceived || perceived.length === 0) return 0;
    const keys = this.currentPerceivedKeys;
    let missed = 0;
    for (let i = 0; i < perceived.length; i += 1) {
      if (reward.collectedKeys.has(keys[i])) continue;
      const d2 = reward.minDistSq[i];
      if (!Number.isFinite(d2) || d2 >= MISS_PROXIMITY_PX_SQ) continue;
      const p = perceived[i];
      const linear = 1 - Math.sqrt(d2) / MISS_PROXIMITY_PX;
      const proximity = Math.pow(linear, MISS_PROXIMITY_EXP);
      missed += (SCORE_PASTILLE[p.type] ?? SCORE_PASTILLE[0]) * proximity;
    }
    return missed;
  }

  // Bias for how attractive a node is for further search expansion when the
  // policy weights collect. Decays exponentially with blob-to-pastille
  // distance, summed over still-uncollected perceived pastilles.
  private collectibleBias(state: SimSnapshot): number {
    if (this.cfg.policy.collect <= 0) return 0;
    const pastilles = state.pastilles;
    if (pastilles.length === 0) return 0;
    let bias = 0;
    const bx = state.blob.x, by = state.blob.y;
    for (const p of pastilles) {
      const dx = p.x - bx, dy = p.y - by;
      const d = Math.sqrt(dx * dx + dy * dy);
      const decay = Math.exp(-d / NODE_BIAS_DECAY_PX);
      bias += (SCORE_PASTILLE[p.type] ?? SCORE_PASTILLE[0]) * decay;
    }
    return bias * this.cfg.policy.collect * NODE_BIAS_FACTOR;
  }

  private waitSamples(snap: SimSnapshot, depth: number): number[] {
    const limit = snap.blob.state === BLOB_STATE_WALL ? MAX_WALL_WAIT : MAX_GRAB_WAIT;
    const step = snap.blob.state === BLOB_STATE_WALL
      ? (depth === 0 ? ROOT_WALL_WAIT_STEP : DEEP_WALL_WAIT_STEP)
      : (depth === 0 ? ROOT_GRAB_WAIT_STEP : DEEP_GRAB_WAIT_STEP);
    const out: number[] = [];
    for (let wait = 0; wait <= limit; wait += step) out.push(wait);
    if (out[out.length - 1] !== limit) out.push(limit);
    return out;
  }

  private popBestNode(open: SearchNode[], root: SimSnapshot): SearchNode {
    let bestIdx = 0;
    let bestPriority = this.nodePriority(open[0], root);
    for (let i = 1; i < open.length; i += 1) {
      const priority = this.nodePriority(open[i], root);
      if (priority > bestPriority) {
        bestIdx = i;
        bestPriority = priority;
      }
    }
    const node = open[bestIdx];
    open[bestIdx] = open[open.length - 1];
    open.pop();
    return node;
  }

  private nodePriority(node: SearchNode, root: SimSnapshot): number {
    const yGain = root.blob.y - node.state.blob.y;
    const yGainTerm = Math.max(0, yGain) * 2;
    return node.value + yGainTerm - node.totalTicks * 1.5 + node.collectibleBias;
  }

  private bestStableLeafNode(nodes: SearchNode[], edges: SearchEdge[]): SearchNode | null {
    let best: SearchNode | null = null;
    for (const edge of this.leafEdgeIds(edges)) {
      if (edge.isDead || !edge.isStable || edge.childId < 0) continue;
      const node = nodes[edge.childId];
      if (!best || node.value > best.value) best = node;
    }
    return best;
  }

  private bestStableNode(nodes: SearchNode[], edges: SearchEdge[]): SearchNode | null {
    let best: SearchNode | null = null;
    for (const edge of edges) {
      if (edge.isDead || !edge.isStable || edge.childId < 0) continue;
      const node = nodes[edge.childId];
      if (!best || node.value > best.value) best = node;
    }
    return best;
  }

  private bestEdgeIds(nodes: SearchNode[], target: SearchNode): Set<number> {
    const ids = new Set<number>();
    let node = target;
    while (node.edgeId >= 0) {
      ids.add(node.edgeId);
      node = nodes[node.parentId];
    }
    return ids;
  }

  private planForNode(nodes: SearchNode[], edges: SearchEdge[], target: SearchNode): boolean[] {
    const chunks: boolean[][] = [];
    let node = target;
    while (node.edgeId >= 0) {
      chunks.push(edges[node.edgeId].plan);
      node = nodes[node.parentId];
    }
    const plan: boolean[] = [];
    for (let i = chunks.length - 1; i >= 0; i -= 1) plan.push(...chunks[i]);
    return plan;
  }

  private scoreBreakdownForNode(
    edges: SearchEdge[],
    target: SearchNode,
  ): CandidateScoreBreakdown | null {
    if (target.edgeId < 0) return null;
    return edges[target.edgeId].scoreBreakdown;
  }

  private lineageSupportForEdges(nodes: SearchNode[], edges: SearchEdge[]): {
    support: number[];
    leafEdges: SearchEdge[];
    leafIdsSorted: number[];
  } {
    if (edges.length === 0) {
      return { support: [], leafEdges: [], leafIdsSorted: [] };
    }

    // Visual decision-space support, separate from planner score. Only
    // leaf/frontier edges seed support from their outcome value; internal edges
    // become important only when good descendant futures flow through them.
    //
    // Bottom-up by reverse insertion order is sound: A* expands best-first,
    // and a child edge can only be created after its parent node has been
    // popped, so a parent edge always precedes any child edge in `edges`.
    const support = new Array<number>(edges.length).fill(0);
    const leafEdges = this.leafEdgeIds(edges);
    const leafIds = leafEdges
      .map((edge) => edge.id)
      .sort((a, b) => edges[a].value - edges[b].value || a - b);

    const denom = Math.max(1, leafIds.length - 1);
    for (let i = 0; i < leafIds.length; i += 1) {
      const id = leafIds[i];
      const rank = leafIds.length <= 1 ? 1 : i / denom;
      support[id] = Math.pow(rank, this.lineageGamma);
    }

    for (let i = edges.length - 1; i >= 0; i -= 1) {
      const parentEdgeId = nodes[edges[i].parentId]?.edgeId ?? -1;
      if (parentEdgeId >= 0) support[parentEdgeId] += support[edges[i].id] * this.lineageDecay;
    }
    return { support, leafEdges, leafIdsSorted: leafIds };
  }

  private computeDiagnostics(
    nodes: SearchNode[],
    edges: SearchEdge[],
    supportResult: ReturnType<typeof this.lineageSupportForEdges>,
    chosenEdgeIds: Set<number>,
  ): PlannerDiagnostics {
    const { support, leafEdges, leafIdsSorted } = supportResult;
    if (edges.length === 0 || support.length === 0) return emptyDiagnostics();

    const leafDepthCounts: number[] = [];
    for (const leaf of leafEdges) {
      const depth = leaf.childId >= 0 ? nodes[leaf.childId].depth : 1;
      leafDepthCounts[depth] = (leafDepthCounts[depth] ?? 0) + 1;
    }

    const sortedValues = leafIdsSorted.map((id) => edges[id].value);
    const pct = (p: number): number => {
      if (sortedValues.length === 0) return 0;
      const idx = Math.min(sortedValues.length - 1, Math.max(0, Math.floor(p * sortedValues.length)));
      return sortedValues[idx];
    };
    const leafValueMin = sortedValues.length > 0 ? sortedValues[0] : 0;
    const leafValueMax = sortedValues.length > 0 ? sortedValues[sortedValues.length - 1] : 0;

    let supportTotal = 0;
    for (const s of support) supportTotal += s;
    const sortedSupports = support.slice().sort((a, b) => b - a);
    const top1 = sortedSupports[0] ?? 0;
    const top3 = (sortedSupports[0] ?? 0) + (sortedSupports[1] ?? 0) + (sortedSupports[2] ?? 0);
    let chosenSum = 0;
    for (const id of chosenEdgeIds) chosenSum += support[id] ?? 0;
    const totalSafe = Math.max(1e-9, supportTotal);

    return {
      leafCount: leafEdges.length,
      leafDepthCounts,
      leafValueMin,
      leafValueP10: pct(0.1),
      leafValueP25: pct(0.25),
      leafValueP50: pct(0.5),
      leafValueP75: pct(0.75),
      leafValueP90: pct(0.9),
      leafValueMax,
      supportTopShare: top1 / totalSafe,
      supportTop3Share: top3 / totalSafe,
      supportChosenShare: chosenSum / totalSafe,
      supportTotal,
    };
  }

  private leafEdgeIds(edges: SearchEdge[]): SearchEdge[] {
    const expandedNodeIds = new Set<number>();
    for (const edge of edges) expandedNodeIds.add(edge.parentId);
    return edges.filter((edge) => !expandedNodeIds.has(edge.childId));
  }

  private segmentsForEdges(
    edges: SearchEdge[],
    bestEdgeIds: Set<number>,
    support: number[],
    nodes: SearchNode[],
  ): Segment[] {
    const out: Segment[] = [];
    const leafIds = new Set(this.leafEdgeIds(edges).map((edge) => edge.id));
    const renderGenerationLimit = renderedGenerationLimitForSearchDepth(this.cfg.maxStableDepth);
    for (const edge of edges) {
      const onChosenChain = bestEdgeIds.has(edge.id);
      const generation = edge.childId >= 0 ? nodes[edge.childId].depth : 1;
      if (generation > renderGenerationLimit) continue;
      // The search intentionally runs one generation past the overlay. Treat
      // the visible depth cap as a render frontier so inherited descendant
      // support still normalizes against the last shown branches.
      const isLeaf = leafIds.has(edge.id) || generation >= renderGenerationLimit;
      for (const segment of edge.segments) {
        const s = segment as Segment;
        s.edgeId = edge.id;
        s.support = support[edge.id] ?? 0;
        s.onChosenChain = onChosenChain;
        s.isLeaf = isLeaf;
        s.generation = generation;
        out.push(s);
      }
    }
    return out;
  }

  private updatePerception(snap: SimSnapshot): void {
    const viewTop = -snap.mapY;
    const viewBottom = viewTop + STAGE_HEIGHT;
    const revealTop = viewTop - STAGE_HEIGHT * this.cfg.revealScreensAbove;
    const revealBottom = viewBottom;
    for (let i = 0; i < snap.wheels.length; i += 1) {
      const wheel = snap.wheels[i];
      if (this.intersectsY(wheel.y, wheel.ray, revealTop, revealBottom)) this.knownWheelIdx.add(i);
    }
    for (const pastille of snap.pastilles) {
      if (this.intersectsY(pastille.y, pastille.ray, revealTop, revealBottom)) {
        this.knownPastilleKeys.add(this.pastilleKey(pastille));
      }
    }
    if (snap.blob.cwIdx >= 0) this.knownWheelIdx.add(snap.blob.cwIdx);
  }

  private buildPerceivedSnapshot(full: SimSnapshot): PerceivedSnapshot {
    const viewTop = -full.mapY;
    const viewBottom = viewTop + STAGE_HEIGHT;
    const planningTop = viewTop - STAGE_HEIGHT * this.cfg.revealScreensAbove;
    const planningBottom = viewBottom + STAGE_HEIGHT * this.cfg.memoryScreensBelow;
    const wheelIndices: number[] = [];

    for (let i = 0; i < full.wheels.length; i += 1) {
      const wheel = full.wheels[i];
      if (
        (this.knownWheelIdx.has(i) && this.intersectsY(wheel.y, wheel.ray, planningTop, planningBottom)) ||
        i === full.blob.cwIdx
      ) {
        wheelIndices.push(i);
      }
    }

    const wheelIdxMap = new Map<number, number>();
    const wheels = wheelIndices.map((idx, localIdx) => {
      wheelIdxMap.set(idx, localIdx);
      const wheel = full.wheels[idx];
      return { ...wheel, mines: wheel.mines.slice() };
    });
    const pastilles = full.pastilles
      .filter((p) => this.knownPastilleKeys.has(this.pastilleKey(p)) && this.intersectsY(p.y, p.ray, planningTop, planningBottom))
      .map((p) => ({ ...p }));
    const snap: SimSnapshot = {
      ...full,
      blob: {
        ...full.blob,
        cwIdx: full.blob.cwIdx >= 0 ? wheelIdxMap.get(full.blob.cwIdx) ?? -1 : -1,
      },
      wheels,
      pastilles,
      sparks: full.sparks.map((spark) => ({ ...spark })),
    };
    return { snap, perceivedWheels: wheels.length, perceivedPastilles: pastilles.length };
  }

  private intersectsY(y: number, ray: number, top: number, bottom: number): boolean {
    return y + ray >= top && y - ray <= bottom;
  }

  private pastilleKey(p: { x: number; y: number; type: number }): string {
    return `${p.type}:${p.x}:${p.y}`;
  }

  private isTerminal(s: { blob: { state: number }; ending: boolean; ended: boolean }): boolean {
    return s.blob.state === BLOB_STATE_DEAD || s.ending || s.ended;
  }

  private isSameStableTarget(start: SimSnapshot, end: SimSnapshot): boolean {
    if (start.blob.state !== end.blob.state) return false;
    if (start.blob.state === BLOB_STATE_GRAB) return start.blob.cwIdx >= 0 && start.blob.cwIdx === end.blob.cwIdx;
    if (start.blob.state === BLOB_STATE_WALL) return start.blob.wallSide !== 0 && start.blob.wallSide === end.blob.wallSide;
    return false;
  }

  private waterUrgency(waterMargin: number): number {
    if (waterMargin >= 320) return 0;
    if (waterMargin <= WATER_SAFETY_MARGIN) return 1;
    return (320 - waterMargin) / (320 - WATER_SAFETY_MARGIN);
  }

  private emptyResult(startBlobY: number, perceived: PerceivedSnapshot, mode: PlannerStats['mode']): PlanResult {
    return {
      plan: [false],
      segments: [],
      startBlobY,
      stats: {
        mode,
        planMs: 0,
        edgesEvaluated: 0,
        stableNodesExpanded: 0,
        perceivedWheels: perceived.perceivedWheels,
        perceivedPastilles: perceived.perceivedPastilles,
        segments: 0,
        bestScore: 0,
        bestScoreBreakdown: emptyScoreBreakdown(),
        diagnostics: emptyDiagnostics(),
      },
    };
  }
}
