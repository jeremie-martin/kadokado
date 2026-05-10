import {
  BLOB_STATE_DEAD,
  BLOB_STATE_FLY,
  BLOB_STATE_GRAB,
  BLOB_STATE_WALL,
  InterwheelSim as ScratchInterwheelSim,
  STAGE_HEIGHT,
  STAGE_WIDTH,
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
// This is anti-drown physics, not a policy modulator — it stays.
const WATER_DEFICIT_GRADIENT = 30;
// Minimum px above water before water-safety penalty kicks in.
const WATER_SAFETY_MARGIN = 160;
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
// Phantom wheel: a virtual mid-size wheel injected into the perceived
// snapshot at every plan tick, sitting 0.25 screens above the reveal cone
// in the middle horizontally. The search's scratch sim treats it as a
// real landing target; existing stability + path-apex scoring naturally
// rewards plans that aim for it. Encodes "go up" as a heuristic that
// doesn't depend on perceiving a specific wheel above. Anchored to the
// root mapY so it's stable for the entire search invocation. Live game
// wheels are unchanged — the phantom is per-plan only.
const CLIMB_PHANTOM_WHEEL_ENABLED_DEFAULT = true;
// Vertical offset of the phantom above the reveal top, in screen-heights.
// 0.25 keeps it just past perception so an in-flight apex can plausibly
// reach it from a single jump.
const PHANTOM_WHEEL_Y_OFFSET_SCREENS = 0.25;
// Phantom wheel physical properties. Mid-size wheel so the search sim's
// collision check reliably catches the blob's flight without forcing
// awkward angles.
const PHANTOM_WHEEL_RAY = 20;
const PHANTOM_WHEEL_SPEED = 0.1;
const PHANTOM_WHEEL_FR = 2;
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
// Wall scoring modes:
//   • `event` (legacy): pathWallLandings × landingBonus + pathWallTicks ×
//     tickBonus. The standard sweep showed this produces a cliff in
//     wallJumps-per-minute around mix≈0.7–0.9 (1 → 20+ jumps for a 0.2 mix
//     change) and a passive-wall-hug pathology at high mix (wall%=35 with
//     wallJ/min collapsing because tick-bonus rewards sitting on walls).
//   • `productive` (new default): pathWallProductiveLift × productiveBonus,
//     where productiveLift accumulates max(0, edgeStartY − edgeEndY) over
//     edges that touched the wall. Oscillation (wall→wheel→wall→wheel) gains
//     no net height per cycle so the signal stays near zero — the agent
//     can't trade climb for raw wall-event count. Same-stable-target wall
//     scoops are zeroed out to mirror the existing loop guard.
const WALL_MODES = ['event', 'productive'] as const;
const WALL_MODE_DEFAULT: WallMode = 'productive';
// Per-pixel of productive wall-lift score in productive mode. Calibration
// chosen so the existing wall slider range 0..2 covers the useful response
// curve: at wall=0.5, ~3 wallJ/min (light); at wall=1, ~22 (moderate); at
// wall=2, ~41 (heavy). Lower bonus shifts the curve right (need higher mix
// to see walls); higher bonus saturates faster. Multiplicative with the
// `wall` knob, so bonus=N + wall=M behaves identically to bonus=1 + wall=N×M.
const WALL_PRODUCTIVE_BONUS_DEFAULT = 3.0;
// Pastille capture: rewards path-level "obligation satisfaction" for pastilles
// the planner currently perceives. A perceived pastille that the path
// physically grabs contributes 1.0 × bonus; in graded mode, an unsecured one
// contributes a continuous fraction based on the minimum distance from any
// flight sample on the root-to-leaf path to the pastille. Bounded per pastille
// so the signal can't blow up. Same-stable-target edges contribute neither
// pickups nor approach distance (mirrors existing loop guard at line ~914).
//
// `count` is the default because the standard sweep showed it strictly
// dominates the alternatives on the capture-vs-height frontier: 90.5% capture
// at h/min=1665 (mix=1), vs graded's 79% at h/min=1173 with the same mix.
// `graded` remains as an ablation knob for studying smoothness at very low
// mix; it converges to count behavior as `pastilleAttractScale → 0`.
const PASTILLE_MODES = ['count', 'graded'] as const;
const PASTILLE_MODE_DEFAULT: PastilleMode = 'count';
// Per-pastille bonus magnitude. Calibration: the pure climb signal at a
// 600 px arc is ~600 score; one secured pastille at bonus=200 is ≈ 1/3 of a
// jump's worth of climb credit. Mix coefficient scales the rest.
const PASTILLE_SECURE_BONUS_DEFAULT = 200;
// Distance scale (world px) over which graded credit decays from full at
// d=0 to 0 at d≥SCALE. Only used in graded mode. Default kept conservative
// because the param sweep showed lower scale strictly dominates higher scale
// on capture% (87.5% at scale=50 vs 69.5% at scale=600, fixed mix=1).
const PASTILLE_ATTRACT_SCALE_DEFAULT = 50;

// Shared empty distance buffer for plans where there are no perceived
// pastilles to score against; lets the rest of the search code skip the
// allocation path without branching on `obligations.length` everywhere.
const EMPTY_DIST_SQ = new Float64Array(0);

type CollectReward = {
  /** Set of pastille keys physically grabbed during the rollout (live-game
   *  pickup geometry: `distance(blob, pastille) < 70` per sim.ts:800). */
  collectedKeys: Set<string>;
  /** Count of sparks (chasing-pastille trails) collected during the rollout. */
  sparkCount: number;
};

/** Snapshot of pastille obligations taken once at the start of a plan: the
 *  pastilles the planner currently perceives, scored as a "don't leave behind"
 *  set. Each entry stores key + position so the search can compute graded
 *  approach distance against the same fixed set across all candidate paths. */
type PastilleObligation = {
  key: string;
  x: number;
  y: number;
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
  /** Cumulative height (px) gained on root-to-node edges that touched the wall.
   *  Wall-touching edges contribute `max(0, edgeStartY − edgeEndY)`. Same
   *  stable-target wall scoops are excluded (mirrors loop guard). Used by the
   *  productive wall mode to reward only wall use that actually lifts the
   *  agent — oscillation cycles net out to ~0 height gained. */
  pathWallProductiveLift: number;
  /** Min squared distance from any flight sample on the root-to-this-node path
   *  to each perceived pastille (keyed by obligation index). Used by the
   *  graded pastille mode for bounded approach credit. Squared for cheaper
   *  comparison; sqrt is taken once per pastille at score time. Same-target
   *  scoop edges do not lower these values (mirrors loop guard). */
  pathPastilleMinDistSq: Float64Array;
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
  pathWallProductiveLift: number;
  pathPastilleMinDistSq: Float64Array;
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
  'climb', 'wall', 'pastille', 'stability', 'safety', 'backtrack', 'loop', 'total',
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
  /** Reveal lookahead in screen-heights, evaluated every tick against the
   *  current camera mapY. */
  revealScreensAbove?: number;
  /** Planning-band depth below the viewport, in screen-heights. Crops the
   *  perceived snapshot every tick regardless of attached/flight state. */
  memoryScreensBelow?: number;
  collectSegments?: boolean;
  policy?: Partial<PlannerPolicy>;
  metricParams?: Partial<PlannerMetricParams>;
};

export type PlannerPolicy = {
  /** How much to value path height (px climbed from root to leaf apex). */
  climb: number;
  /**
   * How much to value wall use. The signal shape is selected by
   * `metricParams.wallMode`:
   *   - `event` (legacy): pathWallLandings × wallLandingBonus + pathWallTicks
   *     × wallTickBonus. Discrete-tier "this is a wall-jump-class route"
   *     preference + soft contact-duration bonus.
   *   - `productive` (default): pathWallProductiveLift × wallProductiveBonus,
   *     where productiveLift accumulates the height gained on wall-touching
   *     edges. Avoids the wallJumps-per-min cliff and the passive-wall-hug
   *     pathology of event mode.
   * `wall=0` is the no-wall baseline by construction.
   */
  wall: number;
  /**
   * How much to value satisfying the path's pastille-capture obligation. The
   * obligation set is the pastilles the planner perceives at the root of the
   * current plan. The signal shape is selected by `metricParams.pastilleMode`:
   *   - count  — bonus × |obligation ∩ pathReward.collectedKeys|
   *   - graded — per-pastille graded credit (1.0 if collected, else
   *              max(0, 1 − d_min/scale)) summed and scaled by bonus
   * Default mode is `count`; graded converges to count behavior at very small
   * `pastilleAttractScale` and is retained as an ablation knob. The mix knob
   * itself is monotone non-decreasing in capture rate; `pastille=0` is exactly
   * the climb-only baseline by construction.
   */
  pastille: number;
};

export type PastilleMode = typeof PASTILLE_MODES[number];

export type ClimbMetricMode = typeof CLIMB_METRIC_MODES[number];
export type WallMode = typeof WALL_MODES[number];

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
   * with wallLandingBonus to tune the wall metric's smoothness. Only used
   * by `wallMode='event'` — productive mode drops the per-tick term entirely
   * to avoid the passive-wall-hug pathology.
   */
  wallTickBonus: number;
  /**
   * Wall scoring shape — see `PlannerPolicy.wall` for what each mode does.
   */
  wallMode: WallMode;
  /**
   * Productive-mode score per pixel of path-cumulative wall-lift. Only used
   * by `wallMode='productive'`. Default 1.0 keeps the productive wall signal
   * dimensionally aligned with the climb signal: a wall-route that lifts
   * 200 px contributes 200 score per unit of `wall` knob.
   */
  wallProductiveBonus: number;
  /**
   * Inject a phantom wheel into the perceived snapshot above the
   * planner's reveal cone, in the middle horizontally. The search's
   * scratch sim treats it as a real landing target; existing stability +
   * path-apex scoring rewards plans that reach it. Encodes "go up" as a
   * principle that doesn't depend on perceiving an actual wheel above.
   * Default true — the planner is shaped around having this attractor.
   * Set to false to compare against the un-phantom shape in studies.
   */
  climbPhantomWheelEnabled: boolean;
  /**
   * Shape of the pastille capture signal. See `PlannerPolicy.pastille` for
   * the overall meaning; this knob selects between integer count, bounded
   * fraction, and graded approach modes for ablation studies.
   */
  pastilleMode: PastilleMode;
  /**
   * Per-pastille bonus magnitude that scales the capture signal in all
   * modes. Higher values pull harder on the search to detour for pastilles.
   */
  pastilleSecureBonus: number;
  /**
   * World-pixel scale at which graded mode's per-pastille approach credit
   * decays from 1.0 (at d=0) to 0.0 (at d≥scale). Only used in graded mode.
   */
  pastilleAttractScale: number;
};

export type CandidateScoreBreakdown = {
  // Knob-driven terms (one line per user knob, scaling one signal each).
  climb: number;
  wall: number;
  pastille: number;
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
  // Pastille capture default 0.5 in count mode is the sweet spot on the
  // capture-vs-height frontier: 82.5% capture at h/min ≈ 2070 (8 trials × 60s,
  // seeds 4200..4207), only ≈25% h/min loss vs climb-only. Higher mix buys
  // diminishing capture for steep h/min cost.
  pastille: 0.5,
};

export const DEFAULT_PLANNER_METRIC_PARAMS: PlannerMetricParams = {
  climbMode: CLIMB_METRIC_MODE_DEFAULT,
  climbTickCost: CLIMB_TICK_COST_DEFAULT,
  climbWaitCost: CLIMB_WAIT_COST_DEFAULT,
  wallLandingBonus: WALL_LANDING_BONUS,
  wallTickBonus: WALL_NORMALIZE,
  wallMode: WALL_MODE_DEFAULT,
  wallProductiveBonus: WALL_PRODUCTIVE_BONUS_DEFAULT,
  climbPhantomWheelEnabled: CLIMB_PHANTOM_WHEEL_ENABLED_DEFAULT,
  pastilleMode: PASTILLE_MODE_DEFAULT,
  pastilleSecureBonus: PASTILLE_SECURE_BONUS_DEFAULT,
  pastilleAttractScale: PASTILLE_ATTRACT_SCALE_DEFAULT,
};

// Live defaults shape the planner toward "go up" using the phantom-wheel
// attractor + time-cost urgency only: no perception of wheels above the
// viewport (revealScreensAbove=0) and a shallow search horizon
// (maxStableDepth=3). Together with `climbPhantomWheelEnabled=true` and
// `climbTickCost=3` they give h/min ≈ 2620 / p10 ≈ 2540 climb-only at the
// default operating point — beating the older lookahead=0.5/jumps=4
// baseline at less perception. Studies override per preset/CLI as needed.
export const PLANNER_PERCEPTION_DEFAULTS = {
  revealScreensAbove: 0,
  memoryScreensBelow: 2,
};

export const PLANNER_SEARCH_DEFAULTS = {
  budgetMs: 5,
  maxEdgeRollouts: 360,
  maxStableDepth: 3,
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
  if (!(WALL_MODES as readonly string[]).includes(resolved.wallMode)) {
    resolved.wallMode = WALL_MODE_DEFAULT;
  }
  if (!(PASTILLE_MODES as readonly string[]).includes(resolved.pastilleMode)) {
    resolved.pastilleMode = PASTILLE_MODE_DEFAULT;
  }
  return resolved;
}

export function emptyScoreBreakdown(total = 0): CandidateScoreBreakdown {
  return {
    climb: 0,
    wall: 0,
    pastille: 0,
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
    // Snapshot the obligation set once per plan: every candidate path is
    // scored against the same fixed list of perceived pastilles, so the
    // pastille signal is well-defined across edges in a single search tree.
    const obligations = this.snapshotPastilleObligations(perceived.snap);
    // Root reward starts empty: pathReward.collectedKeys must reflect ONLY
    // pastilles physically grabbed during this plan's simulation. Pre-credit
    // here would over-claim: the blob has not actually grabbed anything yet.
    const rootReward = this.emptyCollectReward();
    const rootPastilleDist = this.initialPastilleDistSq(obligations, rootState.blob);
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
      0,
      false,
      rootPastilleDist,
      obligations,
      rootReward,
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
      pathWallProductiveLift: 0,
      pathPastilleMinDistSq: rootPastilleDist,
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
        const edge = this.evaluateEdge(rootState, node, waitTicks, edges.length, obligations);
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
          pathWallProductiveLift: edge.pathWallProductiveLift,
          pathPastilleMinDistSq: edge.pathPastilleMinDistSq,
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

  private evaluateEdge(
    rootState: SimSnapshot,
    parent: SearchNode,
    waitTicks: number,
    edgeId: number,
    obligations: PastilleObligation[],
  ): SearchEdge {
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
    // Edge-local minimum squared distance from any sample on this edge to
    // each obligation pastille. Combined with parent.pathPastilleMinDistSq
    // after we know whether the edge counts as a same-stable-target scoop.
    const edgeMinDistSq = obligations.length > 0
      ? this.initialPastilleDistSq(obligations, sim.blob)
      : EMPTY_DIST_SQ;
    const recordStep = (press: boolean): void => {
      sim.step(press, constantRng);
      plan.push(press);
      this.collectStepReward(sim, reward);
      samplesX.push(sim.blob.x);
      samplesY.push(sim.blob.y);
      if (sim.blob.y < edgeApexY) edgeApexY = sim.blob.y;
      if (sim.blob.state === BLOB_STATE_WALL) edgeWallTicks += 1;
      // Update graded-mode approach distance for each obligation. Squared
      // distance keeps the inner loop branch-free; sqrt is taken once per
      // pastille at score time. Only walked when obligations are non-empty.
      if (obligations.length > 0) {
        const bx = sim.blob.x;
        const by = sim.blob.y;
        for (let i = 0; i < obligations.length; i += 1) {
          const dx = bx - obligations[i].x;
          const dy = by - obligations[i].y;
          const d2 = dx * dx + dy * dy;
          if (d2 < edgeMinDistSq[i]) edgeMinDistSq[i] = d2;
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
    // the apex because reaching a high arc on the way still happened. Mirror
    // this on the pastille approach distance: a same-target scoop should not
    // count as "the path approached pastille p" for graded credit either.
    const effectiveReward = sameStableTarget ? this.emptyCollectReward() : reward;
    const pathReward = this.extendCollectReward(parent.pathReward, effectiveReward);
    const pathPastilleMinDistSq = obligations.length === 0
      ? EMPTY_DIST_SQ
      : sameStableTarget
        ? parent.pathPastilleMinDistSq
        : this.minMergeDistSq(parent.pathPastilleMinDistSq, edgeMinDistSq);
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
    // Productive wall lift: height (px) gained on edges that touched the wall.
    // Same-target wall scoops are excluded so wall→wall→wall oscillation that
    // ends back on the same side gets no credit. The signal sums genuine
    // wall-mediated upward motion; oscillation cycles cancel out by nature.
    const edgeTouchedWall = edgeWallTicks > 0 || edgeStartsOnWall;
    const edgeWallProductiveLift = edgeTouchedWall && !sameStableTarget
      ? Math.max(0, parent.state.blob.y - endState.blob.y)
      : 0;
    const pathWallProductiveLift = parent.pathWallProductiveLift + edgeWallProductiveLift;
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
      pathWallProductiveLift,
      sameStableTarget,
      pathPastilleMinDistSq,
      obligations,
      pathReward,
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
      pathWallProductiveLift,
      pathPastilleMinDistSq,
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

  private snapshotPastilleObligations(snap: SimSnapshot): PastilleObligation[] {
    if (this.cfg.policy.pastille === 0) return [];
    const out: PastilleObligation[] = [];
    for (const p of snap.pastilles) {
      out.push({ key: this.pastilleKey(p), x: p.x, y: p.y });
    }
    return out;
  }

  private initialPastilleDistSq(
    obligations: PastilleObligation[],
    blob: { x: number; y: number },
  ): Float64Array {
    if (obligations.length === 0) return EMPTY_DIST_SQ;
    const out = new Float64Array(obligations.length);
    for (let i = 0; i < obligations.length; i += 1) {
      const dx = blob.x - obligations[i].x;
      const dy = blob.y - obligations[i].y;
      out[i] = dx * dx + dy * dy;
    }
    return out;
  }

  private minMergeDistSq(parent: Float64Array, edge: Float64Array): Float64Array {
    if (parent.length === 0) return edge;
    if (edge.length === 0) return parent;
    const out = new Float64Array(parent.length);
    for (let i = 0; i < parent.length; i += 1) {
      out[i] = parent[i] < edge[i] ? parent[i] : edge[i];
    }
    return out;
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
  // signal, and planner physics (state bonus, water safety, backtrack, loop)
  // live as named constants distinct from policy.
  //
  //   total =
  //     + climb × (
  //         pathApexHeight × CLIMB_NORMALIZE
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
    pathWallProductiveLift: number,
    sameStableTarget: boolean,
    pathPastilleMinDistSq: Float64Array,
    obligations: PastilleObligation[],
    pathReward: CollectReward,
  ): CandidateScoreBreakdown {
    const policy = this.cfg.policy;
    const metricParams = this.cfg.metricParams;
    const waterMargin = end.waterY - end.blob.y;

    const pathApexHeight = Math.max(0, root.blob.y - pathApexY);
    const baseClimbSignal = pathApexHeight * CLIMB_NORMALIZE;
    let climbSignal = baseClimbSignal;
    if (metricParams.climbMode === 'time-cost') {
      climbSignal = baseClimbSignal - pathTicks * metricParams.climbTickCost;
    } else if (metricParams.climbMode === 'wait-cost') {
      climbSignal = baseClimbSignal - pathWaitTicks * metricParams.climbWaitCost;
    }
    // Wall: dispatched on `wallMode`. `event` is the legacy
    // landings + ticks signal, retained for ablation. `productive` rewards
    // path-cumulative height earned on wall-touching edges, which lets the
    // mix coefficient scale wall preference smoothly without rewarding
    // wall→wheel→wall oscillation or passive wall-hugging.
    const wallSignal = metricParams.wallMode === 'productive'
      ? pathWallProductiveLift * metricParams.wallProductiveBonus
      : pathWallLandings * metricParams.wallLandingBonus
      + pathWallTicks * metricParams.wallTickBonus;

    // Pastille capture: path-level obligation satisfaction. Skipped entirely
    // when the policy weight is zero so the live (climb+wall) planner pays no
    // overhead for a feature it isn't using.
    const pastilleSignal = policy.pastille !== 0
      ? this.pastilleSignal(obligations, pathReward, pathPastilleMinDistSq)
      : 0;

    const climb        = policy.climb        * climbSignal;
    const wall         = policy.wall         * wallSignal;
    const pastille     = policy.pastille     * pastilleSignal;

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
      const total = climb + wall + pastille - TERMINAL_DEATH_COST;
      return {
        ...emptyScoreBreakdown(),
        climb,
        wall,
        pastille,
        safety: TERMINAL_DEATH_COST,
        total,
      };
    }

    const total = climb + wall + pastille + stability - safety - backtrack - loop;
    return { climb, wall, pastille, stability, safety, backtrack, loop, total };
  }

  private pastilleSignal(
    obligations: PastilleObligation[],
    pathReward: CollectReward,
    pathPastilleMinDistSq: Float64Array,
  ): number {
    if (obligations.length === 0) return 0;
    const params = this.cfg.metricParams;
    const collected = pathReward.collectedKeys;
    const bonus = params.pastilleSecureBonus;
    if (params.pastilleMode === 'count') {
      let count = 0;
      for (let i = 0; i < obligations.length; i += 1) {
        if (collected.has(obligations[i].key)) count += 1;
      }
      return count * bonus;
    }
    // graded: collected pastilles contribute 1.0; unsecured ones contribute
    // max(0, 1 − d_min/scale) so a path that "almost grabs" a pastille earns
    // a continuous fraction of bonus. This is the smoothness mechanism — it
    // turns a yes/no edge tip-over into a graded slope.
    const scale = Math.max(1e-3, params.pastilleAttractScale);
    let sum = 0;
    for (let i = 0; i < obligations.length; i += 1) {
      if (collected.has(obligations[i].key)) {
        sum += 1;
        continue;
      }
      const d = Math.sqrt(pathPastilleMinDistSq[i]);
      sum += Math.max(0, 1 - d / scale);
    }
    return sum * bonus;
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
    if (this.cfg.metricParams.climbPhantomWheelEnabled) {
      const position = this.phantomWheelPosition(full);
      // Phantom is fed straight to the search's scratch sim via the perceived
      // snapshot. Live game wheels are unchanged. The phantom starts inactive
      // (above viewport), and the scratch sim's `isElementActive` check
      // activates it once the simulated camera scrolls high enough — so the
      // search only "lands" on it after a credible upward arc.
      wheels.push({
        x: position.x,
        y: position.y,
        ray: PHANTOM_WHEEL_RAY,
        speed: PHANTOM_WHEEL_SPEED,
        a: 0,
        fr: PHANTOM_WHEEL_FR,
        mines: [],
        destroyed: false,
        boomAngle: null,
        active: false,
        dustTick: 0,
      });
    }
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

  // Phantom wheel position. y sits `0.25` screen-heights above the reveal
  // top so it's just past what the planner can see; x is the map center.
  // Computed from the planner's root snapshot so the phantom is stable for
  // the entire search invocation.
  private phantomWheelPosition(snap: SimSnapshot): { x: number; y: number } {
    const viewTop = -snap.mapY;
    const y = viewTop - STAGE_HEIGHT * (this.cfg.revealScreensAbove + PHANTOM_WHEEL_Y_OFFSET_SCREENS);
    const x = STAGE_WIDTH * 0.5;
    return { x, y };
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
