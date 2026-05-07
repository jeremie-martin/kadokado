import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  BLOB_STATE_GRAB,
  BLOB_STATE_WALL,
  InterwheelSim as ScratchInterwheelSim,
  SCORE_PASTILLE,
  STAGE_HEIGHT,
  type InterwheelSim,
  type SimSnapshot,
} from '../games/interwheel/sim';

// Constant RNG used during search. The simulator may consume an RNG draw for
// cosmetic-but-stateful parity cases, but search outcomes do not depend on the
// sampled value.
const constantRng = () => 0.5;

const MAX_GRAB_WAIT = 100;
const MAX_WALL_WAIT = 24;
const MAX_FLIGHT_TICKS = 260;
const WATER_SAFETY_MARGIN = 160;
const TRAJECTORY_SAMPLE_TICKS = 3;
const ROOT_GRAB_WAIT_STEP = 1;
const ROOT_WALL_WAIT_STEP = 1;
const DEEP_GRAB_WAIT_STEP = 4;
const DEEP_WALL_WAIT_STEP = 2;
const DEFAULT_WAIT_PENALTY = 0.75;
const DEFAULT_WAIT_GRACE_TICKS = 24;
const DEFAULT_LONG_WAIT_PENALTY = 0.08;
// "Miss" detection: how close does the trajectory get to an uncollected
// pastille before we count it as a foregone opportunity? Pickup radius is
// 70px, so anything <70 was either grabbed or barely missed; out to ~300
// covers what a different wait-tick choice could plausibly have reached.
const MISS_PROXIMITY_PX = 300;
const MISS_PROXIMITY_PX_SQ = MISS_PROXIMITY_PX * MISS_PROXIMITY_PX;
const MISS_PENALTY_FACTOR = 1.0;
const NODE_BIAS_DECAY_PX = 400;
const NODE_BIAS_FACTOR = 1.5;
const STATE_BONUS: Record<number, number> = {
  [BLOB_STATE_GRAB]: 850,
  [BLOB_STATE_WALL]: 600,
};
const STATE_BONUS_FALLBACK = -1_000;

type EdgeReward = {
  pickedValue: number;
  sparkScore: number;
  collectedKeys: Set<string>;
  // Parallel to currentPerceived.snap.pastilles; squared min distance from
  // any sampled blob position along the edge to that pastille. Used to
  // penalize routes that bypass nearby uncollected pastilles.
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
  reward: EdgeReward;
  scoreBreakdown: CandidateScoreBreakdown;
  segments: Omit<Segment, 'edgeId' | 'kind'>[];
};

export type SegmentKind = 'branch' | 'best' | 'dead';
export type SegmentPhase = 'flight' | 'launch' | 'terminal' | 'wait';

export type Segment = {
  edgeId: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  depth: number;
  localTick: number;
  kind: SegmentKind;
  phase: SegmentPhase;
  scoreGain?: number;
  value?: number;
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
};

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
  /** Prefer raw upward progress and max-height gain. Default preserves legacy scoring. */
  climb: number;
  /** Prefer pastilles/sparks. Default preserves legacy scoring. */
  collectibles: number;
  /** Add preference for routes that intentionally touch a wall from a wheel. */
  wallRoutes: number;
  /** Penalize long plans/waits. Default preserves legacy scoring. */
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
  climb: 1,
  collectibles: 1,
  wallRoutes: 0,
  pace: 1,
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

  constructor(sim: InterwheelSim, cfg: PlannerConfig = {}) {
    this.sim = sim;
    const maxEdgeRollouts = cfg.maxEdgeRollouts ?? cfg.maxNodes ?? 240;
    const maxStableDepth = cfg.maxStableDepth ?? cfg.maxDepth ?? 3;
    this.cfg = {
      budgetMs: cfg.budgetMs ?? 5,
      maxNodes: cfg.maxNodes ?? maxEdgeRollouts,
      maxDepth: cfg.maxDepth ?? maxStableDepth,
      maxEdgeRollouts,
      maxStableDepth,
      targetClimb: cfg.targetClimb ?? 400,
      scoreBias: cfg.scoreBias ?? 1,
      waitPenalty: cfg.waitPenalty ?? DEFAULT_WAIT_PENALTY,
      waitGraceTicks: cfg.waitGraceTicks ?? DEFAULT_WAIT_GRACE_TICKS,
      longWaitPenalty: cfg.longWaitPenalty ?? DEFAULT_LONG_WAIT_PENALTY,
      revealScreensAbove: cfg.revealScreensAbove ?? 1,
      memoryScreensBelow: cfg.memoryScreensBelow ?? 2,
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
      0,
      0,
      { pickedValue: 0, sparkScore: 0, collectedKeys: new Set<string>(), minDistSq: new Float64Array(0) },
      this.emptyRoute(rootState),
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
    };

    const nodes: SearchNode[] = [root];
    const edges: SearchEdge[] = [];
    const open: SearchNode[] = [root];
    let bestNode: SearchNode | null = null;
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
        };
        edge.childId = child.id;
        nodes.push(child);

        if (!edge.isDead && edge.isStable) {
          if (!bestNode || child.value > bestNode.value) bestNode = child;
          open.push(child);
        }
      }
    }

    const targetNode = bestNode ?? (fallbackEdge ? nodes[fallbackEdge.childId] : root);
    const bestEdgeIds = this.bestEdgeIds(nodes, targetNode);
    const plan = this.planForNode(nodes, edges, targetNode);
    const segments = this.cfg.collectSegments ? this.segmentsForEdges(edges, bestEdgeIds) : [];
    const bestScoreBreakdown = this.scoreBreakdownForNode(edges, targetNode) ?? rootScore;
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
        const dead = sim.ending || sim.ended || (sim.blob.state as number) === BLOB_STATE_DEAD;
        segments.push({
          edgeId: 0,
          x0: sx,
          y0: sy,
          x1: sim.blob.x,
          y1: sim.blob.y,
          depth: ticks,
          localTick: ticks,
          kind: dead ? 'dead' : 'best',
          phase: dead ? 'terminal' : 'flight',
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
      },
    };
  }

  private evaluateEdge(rootState: SimSnapshot, parent: SearchNode, waitTicks: number, edgeId: number): SearchEdge {
    const sim = this.scratch;
    const plan: boolean[] = [];
    const segments: Omit<Segment, 'edgeId' | 'kind'>[] = [];
    const perceivedPastilles = this.currentPerceived?.snap.pastilles ?? [];
    const minDistSq = new Float64Array(perceivedPastilles.length);
    for (let i = 0; i < minDistSq.length; i += 1) minDistSq[i] = Infinity;
    const reward: EdgeReward = {
      pickedValue: 0, sparkScore: 0,
      collectedKeys: new Set<string>(),
      minDistSq,
    };
    const route = this.emptyRoute(parent.state);
    sim.restore(parent.state);

    let sx = sim.blob.x;
    let sy = sim.blob.y;
    let launched = false;
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
          if (d2 < minDistSq[i]) minDistSq[i] = d2;
        }
      }
      if (!this.cfg.collectSegments) {
        if (press) launched = true;
        return;
      }
      const terminal = sim.blob.state !== BLOB_STATE_GRAB && sim.blob.state !== BLOB_STATE_WALL && sim.blob.state !== BLOB_STATE_FLY;
      const phase: SegmentPhase =
        terminal || sim.ending || sim.ended ? 'terminal' :
          press ? 'launch' :
            sim.blob.state === BLOB_STATE_FLY ? 'flight' :
              'wait';
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
          phase,
          scoreGain: reward.pickedValue + reward.sparkScore,
        });
        sx = sim.blob.x;
        sy = sim.blob.y;
      }
      if (press) launched = true;
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
        phase:
          this.isTerminal(endState) ? 'terminal' :
            endState.blob.state === BLOB_STATE_FLY ? 'flight' :
              'wait',
        scoreGain: reward.pickedValue + reward.sparkScore,
      });
    }

    const isDead = this.isTerminal(endState);
    const isStable = endState.blob.state === BLOB_STATE_GRAB || endState.blob.state === BLOB_STATE_WALL;
    route.endedOnWall = endState.blob.state === BLOB_STATE_WALL;
    const scoreBreakdown = this.scoreCandidate(
      rootState,
      endState,
      parent.totalTicks + plan.length,
      waitTicks,
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
      scoreBreakdown,
      segments,
    };
  }

  private collectStepReward(sim: ScratchInterwheelSim, reward: EdgeReward): void {
    for (const pastille of sim.events.collectedPastilles) {
      reward.pickedValue += SCORE_PASTILLE[pastille.type] ?? SCORE_PASTILLE[0];
      reward.collectedKeys.add(this.pastilleKey(pastille));
    }
    for (const spark of sim.events.collectedSparks) {
      reward.sparkScore += spark.score;
    }
  }

  private scoreCandidate(
    root: SimSnapshot,
    end: SimSnapshot,
    totalTicks: number,
    waitTicks: number,
    reward: EdgeReward,
    route: EdgeRoute,
    sameStableTarget: boolean,
  ): CandidateScoreBreakdown {
    const waitPenalty = this.waitPenalty(waitTicks);
    if (this.isTerminal(end)) {
      const collectibles = this.cfg.policy.collectibles * (reward.pickedValue * 1.5 + reward.sparkScore * 3);
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
    const yGain = root.blob.y - end.blob.y;
    const waterMargin = end.waterY - end.blob.y;
    const waterUrgency = this.waterUrgency(waterMargin);
    const waterPenalty = waterMargin < WATER_SAFETY_MARGIN
      ? (WATER_SAFETY_MARGIN - waterMargin) * 30
      : 0;
    const stateBonus = STATE_BONUS[end.blob.state] ?? STATE_BONUS_FALLBACK;
    const backtrackPenalty = end.blob.y > root.blob.y + 20
      ? (end.blob.y - root.blob.y) * 25
      : 0;
    const heightPolicy =
      end.maxHeight +
      heightGain * 9 +
      yGain * 4;
    const scorePolicy =
      reward.sparkScore * 3 +
      reward.pickedValue * 1.5;
    // Uncapped: collectibles term scales linearly with pickup value, so the
    // policy.collectibles knob has real magnitude authority vs height.
    const scoreTerm = scorePolicy * this.cfg.scoreBias * (1 - waterUrgency * 0.85);
    const loopPenalty = sameStableTarget && reward.pickedValue + reward.sparkScore <= 0 && yGain < 20 ? 650 : 0;
    const height = this.cfg.policy.climb * heightPolicy * (1 + waterUrgency * 1.2);
    const collectibles = this.cfg.policy.collectibles * scoreTerm;
    const missedCollect = this.cfg.policy.collectibles * this.missedCollectibleValue(reward) * MISS_PENALTY_FACTOR;
    const wallRoute = this.cfg.policy.wallRoutes * this.wallRouteValue(route);
    const stability = stateBonus;
    const paceCost = this.cfg.policy.pace * (totalTicks * 4 + waitPenalty);
    const safetyCost = waterPenalty;
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
      total: height + collectibles + wallRoute + stability - missedCollect - paceCost - safetyCost - backtrackCost - loopCost,
    };
  }

  // Sum perceived pastille values that the route passed within
  // MISS_PROXIMITY_PX of but did not collect. Linear proximity weight
  // (1 at the pastille, 0 at the threshold) keeps the signal smooth.
  private missedCollectibleValue(reward: EdgeReward): number {
    const perceived = this.currentPerceived?.snap.pastilles;
    if (!perceived || perceived.length === 0) return 0;
    let missed = 0;
    for (let i = 0; i < perceived.length; i += 1) {
      const p = perceived[i];
      if (reward.collectedKeys.has(this.pastilleKey(p))) continue;
      const d2 = reward.minDistSq[i];
      if (!Number.isFinite(d2) || d2 >= MISS_PROXIMITY_PX_SQ) continue;
      const proximity = 1 - Math.sqrt(d2) / MISS_PROXIMITY_PX;
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
    return node.value + Math.max(0, yGain) * 2 - node.totalTicks * 1.5 + node.collectibleBias;
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

  private segmentsForEdges(edges: SearchEdge[], bestEdgeIds: Set<number>): Segment[] {
    const out: Segment[] = [];
    for (const edge of edges) {
      const kind: SegmentKind = bestEdgeIds.has(edge.id) ? 'best' : edge.isDead ? 'dead' : 'branch';
      const scoreGain = edge.reward.pickedValue + edge.reward.sparkScore;
      for (const segment of edge.segments) {
        const s = segment as Segment;
        s.edgeId = edge.id;
        s.kind = kind;
        s.scoreGain = scoreGain;
        s.value = edge.value;
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
      },
    };
  }
}
