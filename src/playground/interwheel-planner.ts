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
const WATER_SAFETY_MARGIN = 160;
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
const DEFAULT_WAIT_PENALTY = 0.75;
const DEFAULT_WAIT_GRACE_TICKS = 24;
const DEFAULT_LONG_WAIT_PENALTY = 0.08;
// Defaults for the lineage-support pass; mirrored on the planner instance
// so the playground can override them at runtime via setLineage().
//
// gamma: leaf seed curve. Only leaf/frontier edges seed visual support, using
//   rank-of-value^gamma. Higher values mean only top reachable futures pull their
//   ancestors up; γ=1 makes mediocre futures contribute proportionally too.
// decay: fraction of a child's support a parent inherits in the bottom-up
//   pass. decay=0 makes only leaves visible as important; decay near 1
//   amplifies common prefixes that lead to many strong futures.
// claimAmp: optional per-pastille uniqueness amplifier for leaf seeds. This is
//   a debug/tuning lens, not part of the core planner objective: claimAmp=0
//   keeps lineage support purely path-value based.
export const LINEAGE_DEFAULTS: { gamma: number; decay: number; claimAmp: number } = {
  gamma: 4,
  decay: 0.65,
  claimAmp: 0,
};

// Temporary objective tweak kept as an A/B knob while tuning follow-up jumps.
// asymmetricYGain: in scoreCandidate, weight the local `yGain * 4` term
//   asymmetrically so going down hurts more than going up rewards.
//   Up keeps the existing weight (4); down multiplies by
//   ASYMMETRIC_DOWN_FACTOR. This should stay optional until wall-slide
//   collectible routes have been playtested against it.
const ASYMMETRIC_DOWN_FACTOR = 3;
// If a launch is still flying after MAX_FLIGHT_TICKS, the planner has no
// stable surface or terminal outcome to reason about. Treat it as an unresolved
// frontier, not as a high-value "went upward" candidate.
const UNRESOLVED_FLIGHT_PENALTY = 50_000;
export type ObjectiveFlags = {
  asymmetricYGain: boolean;
};
export const OBJECTIVE_DEFAULTS: ObjectiveFlags = {
  asymmetricYGain: false,
};
// "Miss" detection: how close does the trajectory get to an uncollected
// pastille before we count it as a foregone opportunity? Pickup radius is
// 70px, so anything <70 was either grabbed or barely missed; out to ~300
// covers what a different wait-tick choice could plausibly have reached.
const MISS_PROXIMITY_PX = 300;
const MISS_PROXIMITY_PX_SQ = MISS_PROXIMITY_PX * MISS_PROXIMITY_PX;
const MISS_PENALTY_FACTOR = 1.0;
// Cubic falloff on missed-pastille proximity weight: only paths that should
// plausibly have collected pay a meaningful penalty, instead of the prior
// linear weight which taxed almost every flight that came within 300px of
// any pastille and flattened the differentiating signal.
const MISS_PROXIMITY_EXP = 3;
const NODE_BIAS_DECAY_PX = 400;
const NODE_BIAS_FACTOR = 1.5;
const STATE_BONUS: Record<number, number> = {
  [BLOB_STATE_GRAB]: 850,
  [BLOB_STATE_WALL]: 600,
};
const STATE_BONUS_FALLBACK = -1_000;

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

type EdgeRoute = {
  startsOnWall: boolean;
  touchedWall: boolean;
  endedOnWall: boolean;
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
  // Number of unique pastille keys claimed across leaves (size of the
  // pastille-winner map). 0 when no leaf captured anything.
  totalClaimedPastilles: number;
  // How many leaves had any captured pastille at all.
  leavesWithCaptures: number;
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
    totalClaimedPastilles: 0,
    leavesWithCaptures: 0,
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
  targetClimb?: number;
  scoreBias?: number;
  waitPenalty?: number;
  waitGraceTicks?: number;
  longWaitPenalty?: number;
  revealScreensAbove?: number;
  memoryScreensBelow?: number;
  collectSegments?: boolean;
  policy?: Partial<PlannerPolicy>;
};

export type PlannerPolicy = {
  /** Prefer raw upward progress and max-height gain. */
  climb: number;
  /** Prefer pastilles/sparks. */
  collectibles: number;
  /** Add preference for routes that intentionally touch a wall from a wheel. */
  wallRoutes: number;
  /** Penalize long plans/waits. */
  pace: number;
};

export type CandidateScoreBreakdown = {
  height: number;
  collectibles: number;
  missedCollect: number;
  wallRoute: number;
  stability: number;
  paceCost: number;
  safetyCost: number;
  backtrackCost: number;
  loopCost: number;
  total: number;
};

export const DEFAULT_PLANNER_POLICY: PlannerPolicy = {
  climb: 1.08,
  collectibles: 1.2,
  wallRoutes: 0.65,
  pace: 1,
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
    height: 0,
    collectibles: 0,
    missedCollect: 0,
    wallRoute: 0,
    stability: 0,
    paceCost: 0,
    safetyCost: 0,
    backtrackCost: 0,
    loopCost: 0,
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
  private lineageGamma = LINEAGE_DEFAULTS.gamma;
  private lineageDecay = LINEAGE_DEFAULTS.decay;
  private lineageClaimAmp = LINEAGE_DEFAULTS.claimAmp;
  private objective: ObjectiveFlags = { ...OBJECTIVE_DEFAULTS };

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
      targetClimb: cfg.targetClimb ?? 400,
      scoreBias: cfg.scoreBias ?? 1,
      waitPenalty: cfg.waitPenalty ?? DEFAULT_WAIT_PENALTY,
      waitGraceTicks: cfg.waitGraceTicks ?? DEFAULT_WAIT_GRACE_TICKS,
      longWaitPenalty: cfg.longWaitPenalty ?? DEFAULT_LONG_WAIT_PENALTY,
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

  setLineage(params: { gamma?: number; decay?: number; claimAmp?: number }): void {
    if (params.gamma !== undefined) this.lineageGamma = Math.max(0.1, params.gamma);
    if (params.decay !== undefined) this.lineageDecay = clamp(params.decay, 0, 1);
    if (params.claimAmp !== undefined) this.lineageClaimAmp = Math.max(0, params.claimAmp);
    this.lastResult = null;
  }

  getLineage(): { gamma: number; decay: number; claimAmp: number } {
    return { gamma: this.lineageGamma, decay: this.lineageDecay, claimAmp: this.lineageClaimAmp };
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

  setObjectiveFlags(flags: Partial<ObjectiveFlags>): void {
    this.objective = { ...this.objective, ...flags };
    this.lastResult = null;
  }

  getObjectiveFlags(): ObjectiveFlags {
    return { ...this.objective };
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
    const rootScore = this.scoreCandidate(
      rootState,
      rootState,
      rootState,
      0,
      0,
      this.emptyCollectReward(0),
      this.emptyCollectReward(0),
      this.emptyRoute(rootState),
      false,
    );
    const rootReward = this.emptyCollectReward(this.currentPerceivedKeys.length);
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
    const route = this.emptyRoute(parent.state);
    sim.restore(parent.state);

    let sx = sim.blob.x;
    let sy = sim.blob.y;
    const recordStep = (press: boolean): void => {
      sim.step(press, constantRng);
      plan.push(press);
      this.collectStepReward(sim, reward);
      this.updateRoute(route, sim);
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
    route.endedOnWall = endState.blob.state === BLOB_STATE_WALL;
    const pathReward = this.extendCollectReward(parent.pathReward, reward);
    const scoreBreakdown = this.scoreCandidate(
      rootState,
      parent.state,
      endState,
      parent.totalTicks + plan.length,
      waitTicks,
      pathReward,
      reward,
      route,
      this.isSameStableTarget(parent.state, endState),
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
    };
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
      const key = this.pastilleKey(pastille);
      const value = SCORE_PASTILLE[pastille.type] ?? SCORE_PASTILLE[0];
      if (!reward.collectedKeys.has(key)) {
        reward.pickedValue += value;
        reward.collectedKeys.add(key);
        reward.pickedValuesByKey.set(key, value);
      }
    }
    for (const spark of sim.events.collectedSparks) {
      reward.sparkScore += spark.score;
    }
  }

  private scoreCandidate(
    root: SimSnapshot,
    start: SimSnapshot,
    end: SimSnapshot,
    totalTicks: number,
    waitTicks: number,
    pathReward: CollectReward,
    edgeReward: CollectReward,
    route: EdgeRoute,
    sameStableTarget: boolean,
  ): CandidateScoreBreakdown {
    const waitPenalty = this.waitPenalty(waitTicks);
    if (this.isTerminal(end)) {
      const collectibles = this.cfg.policy.collectibles * this.collectibleScorePolicy(pathReward);
      const paceCost = this.cfg.policy.pace * (totalTicks * 4 + waitPenalty);
      const safetyCost = 1_000_000;
      return {
        ...emptyScoreBreakdown(),
        collectibles,
        paceCost,
        safetyCost,
        total: collectibles - paceCost - safetyCost,
      };
    }

    const heightGain = end.maxHeight - root.maxHeight;
    // `heightGain` remains global: it rewards discovering a new run max from
    // the live root. Directional terms are local to this edge, so a third-gen
    // candidate that jumps down from a future upper wheel is scored as a local
    // backtrack instead of being rewarded just because it still ends above the
    // original live wheel.
    const yGain = start.blob.y - end.blob.y;
    const waterMargin = end.waterY - end.blob.y;
    const waterUrgency = this.waterUrgency(waterMargin);
    const waterPenalty = waterMargin < WATER_SAFETY_MARGIN
      ? (WATER_SAFETY_MARGIN - waterMargin) * 30
      : 0;
    const stateBonus = STATE_BONUS[end.blob.state] ?? STATE_BONUS_FALLBACK;
    const backtrackPenalty = end.blob.y > start.blob.y + 20
      ? (end.blob.y - start.blob.y) * 25
      : 0;
    const yGainWeight = this.objective.asymmetricYGain && yGain < 0
      ? 4 * ASYMMETRIC_DOWN_FACTOR
      : 4;
    const heightPolicy =
      end.maxHeight +
      heightGain * 9 +
      yGain * yGainWeight;
    const scorePolicy = this.collectibleScorePolicy(pathReward);
    const scoreTerm = scorePolicy * this.cfg.scoreBias * (1 - waterUrgency * 0.85);
    const loopPenalty = sameStableTarget && edgeReward.pickedValue + edgeReward.sparkScore <= 0 && yGain < 20 ? 650 : 0;
    const height = this.cfg.policy.climb * heightPolicy * (1 + waterUrgency * 1.2);
    const collectibles = this.cfg.policy.collectibles * scoreTerm;
    // Same waterUrgency dampening as `collectibles` reward above so the miss
    // penalty doesn't keep full strength while the corresponding pickup
    // reward is being quenched near the water.
    const missedCollect = this.cfg.policy.collectibles
      * this.missedCollectibleValue(pathReward)
      * MISS_PENALTY_FACTOR
      * (1 - waterUrgency * 0.85);
    const wallRoute = this.cfg.policy.wallRoutes * this.wallRouteValue(route);
    const stability = stateBonus;
    const paceCost = this.cfg.policy.pace * (totalTicks * 4 + waitPenalty);
    const unresolvedFlightPenalty = end.blob.state === BLOB_STATE_FLY
      ? UNRESOLVED_FLIGHT_PENALTY
      : 0;
    const safetyCost = waterPenalty + unresolvedFlightPenalty;
    const backtrackCost = backtrackPenalty;
    const loopCost = loopPenalty;
    return {
      height,
      collectibles,
      missedCollect,
      wallRoute,
      stability,
      paceCost,
      safetyCost,
      backtrackCost,
      loopCost,
      total: height + collectibles + wallRoute + stability
        - missedCollect - paceCost - safetyCost - backtrackCost - loopCost,
    };
  }

  private collectibleScorePolicy(reward: CollectReward): number {
    return reward.sparkScore * 3 + reward.pickedValue * 1.5;
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
  // policy weights collectibles. Decays exponentially with blob-to-pastille
  // distance, summed over still-uncollected perceived pastilles.
  private collectibleBias(state: SimSnapshot): number {
    if (this.cfg.policy.collectibles <= 0) return 0;
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
    return bias * this.cfg.policy.collectibles * NODE_BIAS_FACTOR;
  }

  private emptyRoute(start: SimSnapshot): EdgeRoute {
    const startsOnWall = start.blob.state === BLOB_STATE_WALL;
    return {
      startsOnWall,
      touchedWall: startsOnWall,
      endedOnWall: startsOnWall,
    };
  }

  private updateRoute(route: EdgeRoute, sim: ScratchInterwheelSim): void {
    if (sim.blob.state === BLOB_STATE_WALL) route.touchedWall = true;
  }

  private wallRouteValue(route: EdgeRoute): number {
    if (route.startsOnWall) return 0;
    if (route.touchedWall && route.endedOnWall) return 450;
    if (route.touchedWall) return 300;
    return 0;
  }

  private waitPenalty(waitTicks: number): number {
    const overstay = Math.max(0, waitTicks - this.cfg.waitGraceTicks);
    const acceleration = 1 + overstay / Math.max(1, this.cfg.waitGraceTicks);
    return waitTicks * this.cfg.waitPenalty + overstay * overstay * acceleration * this.cfg.longWaitPenalty;
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
    totalClaimedPastilles: number;
    leavesWithCaptures: number;
  } {
    if (edges.length === 0) {
      return { support: [], leafEdges: [], leafIdsSorted: [], totalClaimedPastilles: 0, leavesWithCaptures: 0 };
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

    // Optional per-pastille claim: assign each captured pastille to the
    // highest-valued leaf that captured it. This is only a support-shaping
    // debug/tuning multiplier when lineageClaimAmp > 0; diagnostics are
    // computed regardless.
    const claim = new Map<number, number>();
    let totalClaimedPastilles = 0;
    let leavesWithCaptures = 0;
    const leafCaptures = new Map<number, Set<string>>();
    for (const leaf of leafEdges) {
      const captured = new Set(nodes[leaf.childId]?.pathReward.collectedKeys ?? []);
      leafCaptures.set(leaf.id, captured);
      if (captured.size > 0) leavesWithCaptures += 1;
    }
    const winner = new Map<string, number>();
    for (let i = leafIds.length - 1; i >= 0; i -= 1) {
      const id = leafIds[i];
      const captured = leafCaptures.get(id);
      if (!captured) continue;
      for (const k of captured) {
        if (!winner.has(k)) winner.set(k, id);
      }
    }
    totalClaimedPastilles = winner.size;
    if (this.lineageClaimAmp > 0 && leafIds.length > 1) {
      for (const id of winner.values()) claim.set(id, (claim.get(id) ?? 0) + 1);
    }

    const claimDenom = Math.max(1, totalClaimedPastilles);
    const denom = Math.max(1, leafIds.length - 1);
    for (let i = 0; i < leafIds.length; i += 1) {
      const id = leafIds[i];
      const rank = leafIds.length <= 1 ? 1 : i / denom;
      const rankSeed = Math.pow(rank, this.lineageGamma);
      const claimBoost = (claim.get(id) ?? 0) / claimDenom;
      support[id] = rankSeed * (1 + this.lineageClaimAmp * claimBoost);
    }

    for (let i = edges.length - 1; i >= 0; i -= 1) {
      const parentEdgeId = nodes[edges[i].parentId]?.edgeId ?? -1;
      if (parentEdgeId >= 0) support[parentEdgeId] += support[edges[i].id] * this.lineageDecay;
    }
    return { support, leafEdges, leafIdsSorted: leafIds, totalClaimedPastilles, leavesWithCaptures };
  }

  private computeDiagnostics(
    nodes: SearchNode[],
    edges: SearchEdge[],
    supportResult: ReturnType<typeof this.lineageSupportForEdges>,
    chosenEdgeIds: Set<number>,
  ): PlannerDiagnostics {
    const { support, leafEdges, leafIdsSorted, totalClaimedPastilles, leavesWithCaptures } = supportResult;
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
      totalClaimedPastilles,
      leavesWithCaptures,
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
