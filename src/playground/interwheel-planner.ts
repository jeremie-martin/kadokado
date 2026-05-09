import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  BLOB_STATE_GRAB,
  BLOB_STATE_WALL,
  InterwheelSim as ScratchInterwheelSim,
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
// Multiplier coupling water urgency to climb. Hidden contextual modulator:
// as water rises, urgency → 1 and climb scales by (1 + 1.2).
const WATER_CLIMB_BOOST = 1.2;
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

// === Signal normalization ===
// The current live policy is deliberately small: climb is the base objective,
// wall is an optional style/objective term. Pastille capture, pace, detour,
// patience, and focus were removed from the live score because their previous
// forms did not produce controllable behavior. Reintroduce future metrics only
// as independent signals with first-class responsiveness studies.
const CLIMB_NORMALIZE   = 1;            // reference: pathHeight is the gauge
// Climb efficiency uses the validated time-cost metric by default. The legacy
// and wait-cost modes remain available for study comparisons.
const CLIMB_METRIC_MODES = ['legacy', 'time-cost', 'wait-cost'] as const;
const CLIMB_METRIC_MODE_DEFAULT: ClimbMetricMode = 'time-cost';
const CLIMB_TICK_COST_DEFAULT = 3;
const CLIMB_WAIT_COST_DEFAULT = 0;
// Wall signal has two parts:
//   • WALL_LANDING_BONUS: per-edge categorical bonus for the canonical
//     wall-jump-and-land event (started off the wall, touched it during the
//     edge, ended on it). Restores the discrete tier of the pre-orthogonal
//     wallRouteValue (commit 8b65c5b: +450 for "endedOnWall"). Anchors the
//     "this is a wall-jump-class route" preference.
//   • WALL_NORMALIZE: continuous per-tick weight on path-cumulative wall
//     contact. Lower than the old single-term value because most of the
//     gradient now lives in the categorical landing bonus.
// Together: a one-jump wall-launch-and-land scores ≈ 300 + ~10×5 = 350,
// vs a same-height grab→grab path getting 0 from the wall term.
const WALL_LANDING_BONUS = 300;
const WALL_NORMALIZE     = 5;

type CollectReward = {
  /** Set of pastille keys physically grabbed during the rollout (live-game
   *  pickup geometry: `distance(blob, pastille) < 70` per sim.ts:800). */
  collectedKeys: Set<string>;
  /** Count of sparks (chasing-pastille trails) collected during the rollout. */
  sparkCount: number;
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
  pathReward: CollectReward;
  /** Highest y reached anywhere on this root-to-node path (min in screen coords). */
  pathApexY: number;
  /** Cumulative waiting-on-stable-surface ticks along the path. */
  pathWaitTicks: number;
  /** Sum-of-edge-integrals of perpendicular distance from each path sample to its edge's start→end chord. */
  pathOffAxis: number;
  /** Cumulative tick count where blob.state was BLOB_STATE_WALL across path edges. */
  pathWallTicks: number;
  /** Cumulative count of canonical wall-jump-and-land events along this path
   *  (edge started off the wall, touched it mid-edge, ended on it). */
  pathWallLandings: number;
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
  pathWaitTicks: number;
  pathOffAxis: number;
  pathWallTicks: number;
  pathWallLandings: number;
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
  // Per-knob contribution distribution across leaf edges. Steering diagnostic:
  // (max-min) per knob says which knob is differentiating route choice.
  leafScoreSpreads: LeafScoreSpreads;
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

const SPREAD_KEYS = [
  'climb', 'wall', 'stability', 'safety', 'backtrack', 'loop', 'total',
] as const satisfies ReadonlyArray<keyof CandidateScoreBreakdown>;

export function emptyLeafSpread(): LeafSpread {
  return { min: 0, max: 0, mean: 0, std: 0 };
}

export function emptyLeafScoreSpreads(): LeafScoreSpreads {
  const out = {} as LeafScoreSpreads;
  for (const key of SPREAD_KEYS) out[key] = emptyLeafSpread();
  return out;
}

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
    leafScoreSpreads: emptyLeafScoreSpreads(),
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
  metricParams?: Partial<PlannerMetricParams>;
};

export type PlannerPolicy = {
  /** How much to value path height (px climbed from root to leaf apex). */
  climb: number;
  /**
   * How much to value wall use, scoring `pathWallLandings × WALL_LANDING_BONUS
   * + pathWallTicks × WALL_NORMALIZE`. The landings term anchors a discrete
   * preference for canonical wall-jump-and-land routes (started off the wall,
   * touched it, ended on it); the ticks term softly rewards contact duration.
   */
  wall: number;
};

export type ClimbMetricMode = typeof CLIMB_METRIC_MODES[number];

export type PlannerMetricParams = {
  /**
   * Study-only climb metric shape. `legacy` is the old apex-height signal.
   * The other modes test urgency without adding another live policy knob.
   */
  climbMode: ClimbMetricMode;
  /**
   * Score cost per path tick charged inside the climb metric. This makes
   * equally high routes prefer the one that reaches its stable leaf sooner.
   */
  climbTickCost: number;
  /**
   * Score cost per stable waiting tick. This targets slow wheel timing without
   * penalizing necessary flight/landing time.
   */
  climbWaitCost: number;
  /**
   * Score added for each canonical wall-jump-and-land event. Study-only
   * parameter: changing it alters the wall metric's response curve without
   * adding another user-facing policy knob.
   */
  wallLandingBonus: number;
  /**
   * Score added per path tick spent on a wall. Study-only parameter paired
   * with wallLandingBonus to tune the wall metric's smoothness.
   */
  wallTickBonus: number;
};

export type CandidateScoreBreakdown = {
  // Knob-driven terms (one line per user knob, scaling one signal each).
  climb: number;
  wall: number;
  // Internal mechanisms (planner physics, not user-tunable).
  stability: number;
  safety: number;
  backtrack: number;
  loop: number;
  total: number;
};

// Per-knob distributional stats across all leaf candidates considered in a
// single plan step. Tells you how much each term *differentiates routes* —
// a knob whose contribution varies by 5000 across leaves is steering;
// one that varies by 2 is along for the ride.
export type LeafSpread = {
  min: number;
  max: number;
  mean: number;
  std: number;
};
export type LeafScoreSpreads = Record<keyof CandidateScoreBreakdown, LeafSpread>;

// Live operating point after removing non-controllable policy terms. Climb is
// the base objective; wall remains as the only optional non-climb objective
// until the next study framework can validate smoother responsiveness curves.
export const DEFAULT_PLANNER_POLICY: PlannerPolicy = {
  climb: 1.0,
  wall: 0.5,
};

export const DEFAULT_PLANNER_METRIC_PARAMS: PlannerMetricParams = {
  climbMode: CLIMB_METRIC_MODE_DEFAULT,
  climbTickCost: CLIMB_TICK_COST_DEFAULT,
  climbWaitCost: CLIMB_WAIT_COST_DEFAULT,
  wallLandingBonus: WALL_LANDING_BONUS,
  wallTickBonus: WALL_NORMALIZE,
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

export function resolvePlannerMetricParams(
  metricParams: Partial<PlannerMetricParams> = {},
): PlannerMetricParams {
  const resolved = {
    ...DEFAULT_PLANNER_METRIC_PARAMS,
    ...metricParams,
  };
  if (!(CLIMB_METRIC_MODES as readonly string[]).includes(resolved.climbMode)) {
    resolved.climbMode = CLIMB_METRIC_MODE_DEFAULT;
  }
  return resolved;
}

export function emptyScoreBreakdown(total = 0): CandidateScoreBreakdown {
  return {
    climb: 0,
    wall: 0,
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
  private readonly cfg: Required<Omit<PlannerConfig, 'policy' | 'metricParams'>> & {
    policy: PlannerPolicy;
    metricParams: PlannerMetricParams;
  };

  private lastResult: PlanResult | null = null;
  private knownWheelIdx = new Set<number>();
  private knownPastilleKeys = new Set<string>();
  private lastSeenTick = -1;
  private currentPerceived: PerceivedSnapshot | null = null;
  private currentPerceivedKeys: string[] = [];
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
      metricParams: resolvePlannerMetricParams(cfg.metricParams),
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
    // Root reward starts empty: pathReward.collectedKeys must reflect ONLY
    // pastilles physically grabbed during this plan's simulation. Pre-credit
    // here would over-claim: the blob has not actually grabbed anything yet.
    // Pastille telemetry remains recorded here, but it is not part of the
    // current score until the replacement capture objective is designed.
    const rootReward = this.emptyCollectReward();
    const rootScore = this.scoreCandidate(
      rootState,
      rootState,
      rootState,
      rootReward,
      rootState.blob.y,
      0,
      0,
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
      pathReward: rootReward,
      pathApexY: rootState.blob.y,
      pathWaitTicks: 0,
      pathOffAxis: 0,
      pathWallTicks: 0,
      pathWallLandings: 0,
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
          pathReward: edge.pathReward,
          pathApexY: edge.pathApexY,
          pathWaitTicks: edge.pathWaitTicks,
          pathOffAxis: edge.pathOffAxis,
          pathWallTicks: edge.pathWallTicks,
          pathWallLandings: edge.pathWallLandings,
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
    const prefixSegments: Segment[] = [];
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
        prefixSegments.push({
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

    const landingState = sim.clone();
    const isStableLanding =
      landingState.blob.state === BLOB_STATE_GRAB ||
      landingState.blob.state === BLOB_STATE_WALL;

    // Rendering needs the same future context while airborne that a stable root
    // has, but action selection must still remain passive until landing.
    if (this.cfg.collectSegments && isStableLanding) {
      const future = this.planStable({
        snap: landingState,
        perceivedWheels: perceived.perceivedWheels,
        perceivedPastilles: perceived.perceivedPastilles,
      });
      const prefixSupport = this.flightPrefixSupport(future.segments);
      const segments = [
        ...this.withFlightPrefixSupport(prefixSegments, prefixSupport, future.segments.length === 0),
        ...this.offsetFutureSegments(future.segments, 1, ticks),
      ];
      return {
        plan: [...plan, ...future.plan],
        segments,
        startBlobY: perceived.snap.blob.y,
        stats: {
          ...future.stats,
          mode: 'flight',
          perceivedWheels: perceived.perceivedWheels,
          perceivedPastilles: perceived.perceivedPastilles,
          segments: segments.length,
        },
      };
    }

    return {
      plan: plan.length > 0 ? plan : [false],
      segments: prefixSegments,
      startBlobY: perceived.snap.blob.y,
      stats: {
        mode: 'flight',
        planMs: 0,
        edgesEvaluated: 0,
        stableNodesExpanded: 0,
        perceivedWheels: perceived.perceivedWheels,
        perceivedPastilles: perceived.perceivedPastilles,
        segments: prefixSegments.length,
        bestScore: 0,
        bestScoreBreakdown: emptyScoreBreakdown(),
        diagnostics: emptyDiagnostics(),
      },
    };
  }

  private flightPrefixSupport(futureSegments: Segment[]): number {
    const rootSupportByEdge = new Map<number, number>();
    let maxSupport = 0;
    for (const segment of futureSegments) {
      if (segment.generation === 1) rootSupportByEdge.set(segment.edgeId, segment.support);
      if (segment.support > maxSupport) maxSupport = segment.support;
    }
    let totalRootSupport = 0;
    for (const support of rootSupportByEdge.values()) totalRootSupport += support;
    return Math.max(totalRootSupport * this.lineageDecay, maxSupport, 1);
  }

  private withFlightPrefixSupport(
    segments: Segment[],
    support: number,
    isLeaf: boolean,
  ): Segment[] {
    return segments.map((segment) => ({
      ...segment,
      support,
      onChosenChain: true,
      isLeaf,
      generation: 1,
    }));
  }

  private offsetFutureSegments(
    segments: Segment[],
    edgeOffset: number,
    depthOffset: number,
  ): Segment[] {
    return segments.map((segment) => ({
      ...segment,
      edgeId: segment.edgeId + edgeOffset,
      depth: segment.depth + depthOffset,
    }));
  }

  private evaluateEdge(rootState: SimSnapshot, parent: SearchNode, waitTicks: number, edgeId: number): SearchEdge {
    const sim = this.scratch;
    const plan: boolean[] = [];
    const segments: SegmentBody[] = [];
    const reward = this.emptyCollectReward();
    sim.restore(parent.state);

    let sx = sim.blob.x;
    let sy = sim.blob.y;
    const edgeStartX = sim.blob.x;
    const edgeStartY = sim.blob.y;
    // Edge-local accumulators. Tracking start position too gives the off-axis
    // integral and apex-min full path coverage including the resting state.
    let edgeApexY = sim.blob.y;
    const edgeStartsOnWall = sim.blob.state === BLOB_STATE_WALL;
    let edgeWallTicks = edgeStartsOnWall ? 1 : 0;
    let edgeWaitTicks = 0;
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
      edgeWaitTicks += 1;
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
    // sameStableTarget edges are scoops that landed back where they started.
    // Skip both the edge's pickups (would double-credit pastilles already
    // accessible from this wheel via a "real" landing) and the off-axis
    // diagnostic integral (it does not represent stable route progress). Keep
    // the apex because reaching a high arc on the way still happened.
    const effectiveReward = sameStableTarget ? this.emptyCollectReward() : reward;
    const pathReward = this.extendCollectReward(parent.pathReward, effectiveReward);
    const edgeOffAxis = sameStableTarget
      ? 0
      : this.edgeOffAxisIntegral(samplesX, samplesY, edgeStartX, edgeStartY, endState.blob.x, endState.blob.y);
    const pathApexY = Math.min(parent.pathApexY, edgeApexY);
    const pathTicks = parent.totalTicks + plan.length;
    const pathWaitTicks = parent.pathWaitTicks + edgeWaitTicks;
    const pathOffAxis = parent.pathOffAxis + edgeOffAxis;
    const pathWallTicks = parent.pathWallTicks + edgeWallTicks;
    // Wall-jump-and-land event: started off the wall, touched it during the
    // edge, ended on it. Categorical per-edge bonus restoring the discrete
    // tier signal of the pre-orthogonalization wallRouteValue.
    const edgeEndsOnWall = endState.blob.state === BLOB_STATE_WALL;
    const edgeWallLandings = !edgeStartsOnWall && edgeWallTicks > 0 && edgeEndsOnWall ? 1 : 0;
    const pathWallLandings = parent.pathWallLandings + edgeWallLandings;
    const scoreBreakdown = this.scoreCandidate(
      rootState,
      parent.state,
      endState,
      effectiveReward,
      pathApexY,
      pathTicks,
      pathWaitTicks,
      pathWallTicks,
      pathWallLandings,
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
      pathWaitTicks,
      pathOffAxis,
      pathWallTicks,
      pathWallLandings,
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

  private emptyCollectReward(): CollectReward {
    return {
      collectedKeys: new Set<string>(),
      sparkCount: 0,
    };
  }

  private extendCollectReward(parent: CollectReward, edge: CollectReward): CollectReward {
    const collectedKeys = new Set(parent.collectedKeys);
    for (const key of edge.collectedKeys) collectedKeys.add(key);
    return {
      collectedKeys,
      sparkCount: parent.sparkCount + edge.sparkCount,
    };
  }

  private collectStepReward(sim: ScratchInterwheelSim, reward: CollectReward): void {
    for (const pastille of sim.events.collectedPastilles) {
      this.creditPastilleReward(pastille, reward);
    }
    reward.sparkCount += sim.events.collectedSparks.length;
  }

  // Score formulation: each live policy knob scales one path-cumulative
  // signal, and planner physics (state bonus, water urgency,
  // backtrack/loop/safety) live as named constants distinct from policy.
  //
  //   total =
  //     + climb × (
  //         pathApexHeight × CLIMB_NORMALIZE × waterClimbBoost
  //         +/− climbMode-specific urgency shaping
  //       )
  //     + wall  × (pathWallLandings × WALL_LANDING_BONUS + pathWallTicks × WALL_NORMALIZE)
  //     + endStableBonus
  //     − endSafetyCost − endBacktrackCost − endLoopCost
  //
  // pathApexHeight = max(0, root.y - pathApexY) is the historical height
  // signal. Climb metric modes are study-only shapes for adding urgency
  // without adding another policy knob: total path-time cost, stable wait-time
  // cost.
  // Wall is a hybrid event+continuous signal: pathWallLandings counts the
  // canonical "started off the wall, touched it, ended on it" event per
  // edge along the path; pathWallTicks is the continuous wall-time
  // accumulator. The event term restores the discrete-tier preference of
  // the pre-orthogonalization wallRouteValue (commit 8b65c5b) for actual
  // wall-jumps over passive wall-clinging.
  private scoreCandidate(
    root: SimSnapshot,
    start: SimSnapshot,
    end: SimSnapshot,
    edgeReward: CollectReward,
    pathApexY: number,
    pathTicks: number,
    pathWaitTicks: number,
    pathWallTicks: number,
    pathWallLandings: number,
    sameStableTarget: boolean,
  ): CandidateScoreBreakdown {
    const policy = this.cfg.policy;
    const metricParams = this.cfg.metricParams;
    const waterMargin = end.waterY - end.blob.y;
    const waterUrgency = this.waterUrgency(waterMargin);
    const waterClimbBoost = 1 + waterUrgency * WATER_CLIMB_BOOST;

    const pathApexHeight = Math.max(0, root.blob.y - pathApexY);
    const baseClimbSignal = pathApexHeight * CLIMB_NORMALIZE * waterClimbBoost;
    let climbSignal = baseClimbSignal;
    if (metricParams.climbMode === 'time-cost') {
      climbSignal = baseClimbSignal - pathTicks * metricParams.climbTickCost;
    } else if (metricParams.climbMode === 'wait-cost') {
      climbSignal = baseClimbSignal - pathWaitTicks * metricParams.climbWaitCost;
    }
    // Wall: per-edge wall-jump-and-land event bonus + continuous wall-time
    // weight. The event term anchors "this is a wall-jump-class route";
    // the tick term provides a soft gradient on wall contact duration.
    const wallSignal = pathWallLandings * metricParams.wallLandingBonus
                     + pathWallTicks * metricParams.wallTickBonus;

    const climb        = policy.climb        * climbSignal;
    const wall         = policy.wall         * wallSignal;

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
        && edgeReward.collectedKeys.size === 0
        && edgeReward.sparkCount === 0
        && yGain < LOOP_GAIN_THRESH_PX
      ? LOOP_PENALTY
      : 0;

    if (this.isTerminal(end)) {
      const total = climb + wall - TERMINAL_DEATH_COST;
      return {
        ...emptyScoreBreakdown(),
        climb,
        wall,
        safety: TERMINAL_DEATH_COST,
        total,
      };
    }

    const total = climb + wall + stability - safety - backtrack - loop;
    return { climb, wall, stability, safety, backtrack, loop, total };
  }

  private creditPastilleReward(
    pastille: { x: number; y: number; type: number },
    reward: CollectReward,
  ): void {
    reward.collectedKeys.add(this.pastilleKey(pastille));
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
    // Search expansion ordering is not a score term. Keep a small internal
    // time bias so the frontier reaches promising stable states quickly while
    // the final leaf choice remains governed by scoreCandidate().
    return node.value + yGainTerm - node.totalTicks * 1.5;
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
      leafScoreSpreads: this.computeLeafScoreSpreads(leafEdges),
    };
  }

  // Per-knob distributional stats across the leaf-edge candidates the planner
  // actually picked between this step. Steering diagnostic — see LeafSpread.
  private computeLeafScoreSpreads(leafEdges: SearchEdge[]): LeafScoreSpreads {
    const out = emptyLeafScoreSpreads();
    if (leafEdges.length === 0) return out;
    for (const key of SPREAD_KEYS) {
      let min = Infinity;
      let max = -Infinity;
      let sum = 0;
      for (const edge of leafEdges) {
        const v = edge.scoreBreakdown[key];
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / leafEdges.length;
      let sqSum = 0;
      for (const edge of leafEdges) {
        const d = edge.scoreBreakdown[key] - mean;
        sqSum += d * d;
      }
      const std = Math.sqrt(sqSum / leafEdges.length);
      out[key] = { min, max, mean, std };
    }
    return out;
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
    if (waterMargin >= WATER_URGENCY_FAR) return 0;
    if (waterMargin <= WATER_SAFETY_MARGIN) return 1;
    return (WATER_URGENCY_FAR - waterMargin) / (WATER_URGENCY_FAR - WATER_SAFETY_MARGIN);
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
