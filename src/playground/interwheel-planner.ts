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
import type { InspectionCandidate, InspectionRecord } from './plan-inspector';
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

// Thoroughness signal: count of pastilles physically collected by the path
// (`pathReward.collectedKeys.size`) × per-pastille bonus. Pure positive
// reward, count-based, no value weighting, no miss penalty. The agent's
// incentive to detour for one pastille is bounded by THOROUGHNESS_PER_PASTILLE:
// at coefficient 1 with detour=1, ~12px of lateral detour for one pastille
// is breakeven.
//
// Note: this magnitude is intentionally smaller than the climb / pace /
// detour normalizations — at coefficient 1 the per-knob steering range
// from thoroughness scales with the *number of grabs* on a path (typical
// 0–10), whereas the others scale with continuous integrals (much larger
// natural magnitudes). To produce climb-comparable steering, coefficients
// up to ~4 may be needed. This is documented in the policy knob's range
// (slider 0–4).
const THOROUGHNESS_PER_PASTILLE = 30;

// === Signal normalization (continuous-integral signals only) ===
// Each path-cumulative continuous signal has a different intrinsic magnitude.
// Without these constants, coefficient=1 would mean different things per
// knob: pathOffAxis leaf-spreads measured ~9000 while pathHeight leaf-spreads
// measured ~460 (~20× ratio). After normalization, coefficient=1 yields
// comparable per-knob leaf-steering ranges (~500), so user-facing sliders
// behave as a true weighted average. Calibrated empirically from
// .tmp/interwheel-ratios/2026-05-08T17-42-47-440Z (climb=1 reference,
// climb steering range ≈ 460).
const CLIMB_NORMALIZE   = 1;            // reference: pathHeight is the gauge
const DETOUR_NORMALIZE  = 1 / 20;       // pathOffAxis spread ≈ 9500 → ÷20 ≈ 475
const PACE_NORMALIZE    = 2;            // pathTime spread ≈ 250 → ×2 ≈ 500
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

// --- Search-bias decay (not in scoreCandidate, but related) ---
const NODE_BIAS_DECAY_PX = 400;
const NODE_BIAS_FACTOR = 1.5;
// Orbit-tube radius used by `computeStableClaimableSet` for the patience
// mechanism: a pastille is "claimable from a higher wheel" when its
// distance from that wheel's orbit ring is within this radius. Geometric
// reasoning, not a pickup prediction — the live game's pickup is point-
// to-point `distance(blob, pastille) < 70` (sim.ts:800), not orbit-band.
const COLLECT_PICKUP_RADIUS = 70;

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
  collectibleBias: number;
  pathReward: CollectReward;
  /** Highest y reached anywhere on this root-to-node path (min in screen coords). */
  pathApexY: number;
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
  'climb', 'thoroughness', 'wall', 'pace', 'detour',
  'stability', 'safety', 'backtrack', 'loop', 'total',
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
};

export type PlannerPolicy = {
  /** How much to value path height (px climbed from root to leaf apex). */
  climb: number;
  /**
   * Positive reward for each pastille the path physically grabs (live-game
   * pickup geometry: blob comes within 70px of the pastille). Pure positive
   * count signal — the planner gets +THOROUGHNESS_PER_PASTILLE per grab
   * regardless of pastille type. Detour-for-pickup is naturally bounded by
   * the per-pastille magnitude. Range typically 0–4; higher values trade
   * altitude for capture rate (the agent waits longer on each wheel).
   */
  thoroughness: number;
  /**
   * How much to value wall use, scoring `pathWallLandings × WALL_LANDING_BONUS
   * + pathWallTicks × WALL_NORMALIZE`. The landings term anchors a discrete
   * preference for canonical wall-jump-and-land routes (started off the wall,
   * touched it, ended on it); the ticks term softly rewards contact duration.
   */
  wall: number;
  /** Per-tick time cost on the path. */
  pace: number;
  /** Per-pixel-tick cost of off-axis path travel (lateral wandering). */
  detour: number;
  /**
   * Defer-grab discount in [0, 1] applied to the thoroughness count. When
   * the path grabbed a pastille that is also reachable from any wheel above
   * the agent, scale that grab's contribution by (1 − patience). 0 = full
   * credit (grab it now); 1 = no credit for above-reachable grabs (trust
   * that the higher wheel will grab it later, climb instead). Composes
   * cleanly with thoroughness — at thoroughness=0, patience does nothing.
   */
  patience: number;
};

export type CandidateScoreBreakdown = {
  // Knob-driven terms (one line per user knob, scaling one signal each).
  climb: number;
  thoroughness: number;
  wall: number;
  pace: number;
  detour: number;
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

// Operating point post-orbit-claim-fix. The cleanest defaults are the
// pace+detour+wall combo (best in the balanced sweep at h=5129m / 183
// past/min vs climb-only's 4373m / 168, +18% / +9%). Thoroughness defaults
// to 0 because it intrinsically trades altitude for in-place harvest —
// even at 0.25, the cost (~-8% past/min) outweighs the marginal capture-%
// benefit. Users who want explicit "grab the pastilles" behavior can dial
// it up to 0.25–0.5; thor=4 is what it takes to get capture% above
// baseline, with a steep altitude cost. Patience defaults to 0 because
// its mechanism only fires when thoroughness > 0.
export const DEFAULT_PLANNER_POLICY: PlannerPolicy = {
  climb: 1.0,
  thoroughness: 0,
  wall: 0.5,
  pace: 1.5,
  detour: 1.0,
  patience: 0,
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
    thoroughness: 0,
    wall: 0,
    pace: 0,
    detour: 0,
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
  // Set once per plan in planStable() so `thoroughnessSignal` can look up
  // "is this pastille reachable from any wheel above the agent" without
  // re-scanning every pickup credit. Used by the patience knob to discount
  // grabs of pastilles the agent could reach later from a higher wheel.
  // Geometry note: this uses an orbit-band approximation (planner constants
  // header) which over-includes pastilles that are not reachable from any
  // single point on the ring; the discount is therefore mildly over-eager.
  private currentStableClaimable = new Set<string>();
  private lineageGamma = LINEAGE_DEFAULTS.gamma;
  private lineageDecay = LINEAGE_DEFAULTS.decay;
  // Inspector: when armed, the next planStable() call captures a full per-
  // candidate snapshot for offline analysis. One-shot, opt-in, off in
  // production. See plan-inspector.ts and scripts/interwheel/inspect-plan.mjs.
  private inspectorArmed = false;
  private lastInspectionRecord: InspectionRecord | null = null;

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

  armInspection(): void {
    this.inspectorArmed = true;
  }

  lastInspection(): InspectionRecord | null {
    return this.lastInspectionRecord;
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
    // Root reward starts empty: pathReward.collectedKeys must reflect ONLY
    // pastilles physically grabbed during this plan's simulation. Pre-credit
    // here would over-claim (the blob hasn't actually grabbed anything yet
    // at root). The orbit-tube `stableSurfaceCollectReward` path was removed
    // because its 70px orbit-band claim does not match the live game's 70px
    // blob-to-pastille distance pickup geometry — see scoreCandidate header.
    const rootReward = this.emptyCollectReward();
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
          collectibleBias: this.collectibleBias(edge.endState),
          pathReward: edge.pathReward,
          pathApexY: edge.pathApexY,
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
    if (this.inspectorArmed) {
      this.lastInspectionRecord = this.buildInspectionRecord(
        rootState,
        nodes,
        edges,
        targetNode,
        stableNodesExpanded,
        performance.now() - startTime,
        perceived,
      );
      this.inspectorArmed = false;
    }
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
    // integral (dominates detour without representing real progress). Keep
    // the apex because reaching a high arc on the way still happened.
    const effectiveReward = sameStableTarget ? this.emptyCollectReward() : reward;
    const pathReward = this.extendCollectReward(parent.pathReward, effectiveReward);
    const edgeOffAxis = sameStableTarget
      ? 0
      : this.edgeOffAxisIntegral(samplesX, samplesY, edgeStartX, edgeStartY, endState.blob.x, endState.blob.y);
    const pathApexY = Math.min(parent.pathApexY, edgeApexY);
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
      parent.totalTicks + plan.length,
      pathReward,
      effectiveReward,
      pathApexY,
      pathOffAxis,
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

  // Orthogonal score formulation: each user-facing knob scales exactly one
  // (normalized) path-cumulative signal, and planner physics (state bonus,
  // water urgency, backtrack/loop/safety) live as named constants distinct
  // from policy.
  //
  //   total =
  //     + climb        × pathHeight   × CLIMB_NORMALIZE × waterClimbBoost
  //     + thoroughness × thoroughnessSignal × THOROUGHNESS_PER_PASTILLE × waterCollectDamp
  //     + wall         × (pathWallLandings × WALL_LANDING_BONUS + pathWallTicks × WALL_NORMALIZE)
  //     − pace         × pathTime     × PACE_NORMALIZE
  //     − detour       × pathOffAxis  × DETOUR_NORMALIZE
  //     + endStableBonus
  //     − endSafetyCost − endBacktrackCost − endLoopCost
  //
  // *_NORMALIZE constants make coefficient=1 produce comparable per-knob
  // leaf-steering ranges (~500), so user-facing sliders behave as a true
  // weighted average for the continuous-integral signals (climb, pace,
  // detour). Thoroughness is intentionally on a different scale
  // (per-grab count, not continuous integral) — see THOROUGHNESS_PER_PASTILLE.
  //
  // pathHeight = max(0, root.y - pathApexY) is the single height signal.
  // Wall is a hybrid event+continuous signal: pathWallLandings counts the
  // canonical "started off the wall, touched it, ended on it" event per
  // edge along the path; pathWallTicks is the continuous wall-time
  // accumulator. The event term restores the discrete-tier preference of
  // the pre-orthogonalization wallRouteValue (commit 8b65c5b) for actual
  // wall-jumps over passive wall-clinging.
  // thoroughnessSignal is `pathReward.collectedKeys.size` — count of
  // pastilles physically grabbed during simulation (sim's 70px blob-distance
  // pickup geometry). Patience discounts grabs of pastilles also reachable
  // from a higher wheel.
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
    pathWallLandings: number,
    sameStableTarget: boolean,
  ): CandidateScoreBreakdown {
    const policy = this.cfg.policy;
    const waterMargin = end.waterY - end.blob.y;
    const waterUrgency = this.waterUrgency(waterMargin);
    const waterClimbBoost = 1 + waterUrgency * WATER_CLIMB_BOOST;
    const waterCollectDamp = 1 - waterUrgency * WATER_COLLECT_DAMP;

    // Knob terms — one signal each. Continuous-integral signals (climb,
    // pace, detour) are normalized so coefficient=1 produces comparable
    // leaf-steering ranges; thoroughness is count-based; wall is hybrid.
    const pathHeight = Math.max(0, root.blob.y - pathApexY);
    // Wall: per-edge wall-jump-and-land event bonus + continuous wall-time
    // weight. The event term anchors "this is a wall-jump-class route";
    // the tick term provides a soft gradient on wall contact duration.
    const wallSignal = pathWallLandings * WALL_LANDING_BONUS
                     + pathWallTicks * WALL_NORMALIZE;

    const climb        = policy.climb        * pathHeight  * CLIMB_NORMALIZE * waterClimbBoost;
    const thoroughness = policy.thoroughness * this.thoroughnessSignal(pathReward)
                                             * THOROUGHNESS_PER_PASTILLE * waterCollectDamp;
    const wall         = policy.wall         * wallSignal;
    const pace         = policy.pace         * totalTicks  * PACE_NORMALIZE;
    const detour       = policy.detour       * pathOffAxis * DETOUR_NORMALIZE;

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
      const total = climb + thoroughness + wall - pace - detour - TERMINAL_DEATH_COST;
      return {
        ...emptyScoreBreakdown(),
        climb, thoroughness, wall, pace, detour,
        safety: TERMINAL_DEATH_COST,
        total,
      };
    }

    const total = climb + thoroughness + wall + stability
                - pace - detour - safety - backtrack - loop;
    return { climb, thoroughness, wall, pace, detour, stability, safety, backtrack, loop, total };
  }

  private creditPastilleReward(
    pastille: { x: number; y: number; type: number },
    reward: CollectReward,
  ): void {
    reward.collectedKeys.add(this.pastilleKey(pastille));
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

  // Thoroughness signal: count of pastilles the path collected. Pure
  // positive reward — each pastille on the path adds 1. Patience discounts
  // pastilles also reachable from a higher wheel ("don't credit grabbing
  // this one if I could get it next plan from above either way").
  private thoroughnessSignal(reward: CollectReward): number {
    const patience = clamp(this.cfg.policy.patience, 0, 1);
    if (patience <= 0 || this.currentStableClaimable.size === 0) {
      return reward.collectedKeys.size;
    }
    let count = 0;
    for (const key of reward.collectedKeys) {
      const discount = this.currentStableClaimable.has(key) ? 1 - patience : 1;
      count += discount;
    }
    return count;
  }

  // Bias for how attractive a node is for further search expansion when the
  // policy weights collect. Decays exponentially with blob-to-pastille
  // distance, summed over still-uncollected perceived pastilles.
  // Search-expansion bias toward states near uncollected pastilles. Driven
  // by `policy.thoroughness` rather than a separate knob: when the user
  // values thoroughness, the search should also spend its budget exploring
  // pastille-rich regions.
  private collectibleBias(state: SimSnapshot): number {
    if (this.cfg.policy.thoroughness <= 0) return 0;
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
    return bias * this.cfg.policy.thoroughness * NODE_BIAS_FACTOR;
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

  private buildInspectionRecord(
    rootState: SimSnapshot,
    nodes: SearchNode[],
    edges: SearchEdge[],
    targetNode: SearchNode,
    stableNodesExpanded: number,
    planMs: number,
    perceived: PerceivedSnapshot,
  ): InspectionRecord {
    const leafSet = new Set(this.leafEdgeIds(edges).map((e) => e.id));
    const candidates: InspectionCandidate[] = edges.map((edge) => {
      const childNode = edge.childId >= 0 ? nodes[edge.childId] : null;
      const depth = childNode?.depth ?? 0;
      const parentNode = nodes[edge.parentId];
      const parentEdgeId = parentNode?.edgeId ?? -1;
      const actionChain = childNode ? this.planForNode(nodes, edges, childNode) : edge.plan.slice();
      const pathHeight = childNode ? Math.max(0, rootState.blob.y - childNode.pathApexY) : 0;
      return {
        edgeId: edge.id,
        parentEdgeId,
        childNodeId: edge.childId,
        depth,
        isLeaf: leafSet.has(edge.id),
        isStable: edge.isStable,
        isDead: edge.isDead,
        pathHeight,
        pathWallTicks: edge.pathWallTicks,
        pathWallLandings: edge.pathWallLandings,
        pathOffAxis: edge.pathOffAxis,
        totalTicks: childNode?.totalTicks ?? edge.plan.length,
        collectedKeys: Array.from(edge.pathReward.collectedKeys),
        score: { ...edge.scoreBreakdown },
        actionChain,
        endStateBlobX: edge.endState.blob.x,
        endStateBlobY: edge.endState.blob.y,
        endStateBlobState: edge.endState.blob.state,
      };
    });
    return {
      tick: rootState.tick,
      seed: null,
      policy: { ...this.cfg.policy },
      searchLimits: {
        maxStableDepth: this.cfg.maxStableDepth,
        maxEdgeRollouts: this.cfg.maxEdgeRollouts,
        budgetMs: this.cfg.budgetMs,
      },
      rootStateBlobX: rootState.blob.x,
      rootStateBlobY: rootState.blob.y,
      rootStateBlobState: rootState.blob.state,
      perceivedWheels: perceived.perceivedWheels,
      perceivedPastilles: perceived.perceivedPastilles,
      candidates,
      chosenEdgeId: targetNode.edgeId,
      chosenLeafNodeId: targetNode.id,
      edgesEvaluated: edges.length,
      stableNodesExpanded,
      planMs,
    };
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
