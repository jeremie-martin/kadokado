# Interwheel Policy Math — Redesign Proposal

Companion to `interwheel-policy-audit.md`. The audit asked *which knobs to
keep*; this doc asks *what should the formulas inside each knob actually be*.

The current implementation is a pile of layered changes. The math is doing
roughly the right thing, but several knobs each combine multiple internal
signals with magic-number weights, several "physics constants" are scattered
inline, and one knob (`collectibles`) couples reward and penalty under one
coefficient by historical accident. This document proposes a redesign for
**orthogonality**: each user knob = one path-cumulative signal × one
weight, with planner physics (state bonus, water urgency, loop / backtrack
/ safety penalties) clearly separated as named constants.

The redesign is **behavior-changing on purpose**. Targets: clarity,
maintainability, predictable focus-slider lerp. Validation is a 15-minute
sweep after implementation.

## Audit of `scoreCandidate()` (current state)

Reading `scoreCandidate()` (interwheel-planner.ts:899-995) in full:

### A. `climb` is three correlated signals

```ts
const heightPolicy =
    end.maxHeight +     // signal 1: leaf's absolute height
    heightGain * 9 +    // signal 2: discovery of new run-max (= end.maxHeight - root.maxHeight, ×9)
    yGain * 4;          // signal 3: local edge upward delta (= start.blob.y - end.blob.y, ×4)
const height = policy.climb * heightPolicy * (1 + waterUrgency * 1.2);
```

Three height signals summed with the magic weights `1 + 9 + 4`. Two of
them (`maxHeight`, `heightGain`) are linearly dependent — `heightGain =
end.maxHeight − root.maxHeight`, so `heightPolicy = end.maxHeight × 10 −
root.maxHeight × 9 + yGain × 4`. **Effectively two signals dressed up as
three.** And `yGain` is a per-edge local term in a knob that's otherwise
pretending to be path-level.

The doc-justified mix ("global heightGain reward + local yGain shaping",
`interwheel-ai-overlay.md:90-97`) is a real design decision, but the
specific weighting `9 vs 4 vs 1` is unjustified.

### B. `collectibles` couples reward + penalty under one coefficient

```ts
const scoreTerm = scorePolicy * cfg.scoreBias * (1 - waterUrgency * 0.85);
const collectibles = policy.collectibles * scoreTerm;
const missedRaw = missedCollectibleValue(pathReward) * MISS_PENALTY_FACTOR
                 * (1 - waterUrgency * 0.85);
const missedCollect = policy.collectibles * missedRaw;
const missPenalty = policy.missPenalty * missedRaw;   // dropped per audit
```

`policy.collectibles` scales BOTH the reward arm AND the proximity miss
penalty. The design doc asserts this should be coupled, but this is a
historical position — operationally the user often wants reward and miss
to scale independently. The dropped `missPenalty` knob was an attempt to
decouple via a parallel coefficient; cleaner would be to decouple in the
formula itself.

### C. `pace` mixes two correlated time costs

```ts
const paceCost = policy.pace * (totalTicks * 4 + pathWaitPenalty);
```

- `totalTicks × 4` — linear time cost (the `× 4` is magic)
- `pathWaitPenalty` — nonlinear wait-time cost from `waitPenalty()`:
  ```ts
  waitTicks * waitPenalty                                 // linear part
    + overstay² * (1 + overstay/grace) * longWaitPenalty   // accelerating part
  ```
  (interwheel-planner.ts:1165-1169)

Two correlated penalties on "slow plans" wired through one knob with no
way to tune the linear vs nonlinear mix.

### D. `wallRoutes` is a tier function, not a continuous gradient

```ts
private wallRouteValue(route: EdgeRoute): number {
  if (route.startsOnWall) return 0;
  if (route.touchedWall && route.endedOnWall) return 450;
  if (route.touchedWall) return 300;
  return 0;
}
```

Three discrete tiers per edge. Then `pathWallRouteValue` is the sum
across edges. Crude. A continuous "fraction of path on a wall" or
"wall-ticks accumulated" would compose better with other path-level
signals.

### E. Magic constants scattered inline

In `scoreCandidate` alone:
| Constant | Where | Meaning |
|---|---|---|
| `× 9` | heightGain weight | tuned by hand |
| `× 4` | yGain weight | tuned by hand |
| `× 4` | totalTicks weight inside paceCost | different magic 4 |
| `× 1.5` | pickedValue weight in `collectibleScorePolicy` | scoring-rule choice |
| `× 3` | sparkScore weight | scoring-rule choice |
| `× 25` | backtrackPenalty per-pixel | tier choice |
| `+20` | backtrackPenalty threshold | tier choice |
| `× 30` | waterPenalty per-pixel-deficit | safety-physics |
| `+850, +600, −1000` | STATE_BONUS{GRAB,WALL,FALLBACK} | physics |
| `+650` | loopPenalty (same-stable scoop) | tier choice |
| `+1_000_000` | safetyCost (death) | physics |
| `+50_000` | UNRESOLVED_FLIGHT_PENALTY | physics |
| `× 1.2` | waterUrgency boost on climb | safety-coupling |
| `× 0.85` | waterUrgency damp on collect/miss | safety-coupling |
| `MISS_PROXIMITY_PX = 300` | miss-proximity cutoff | scoring-rule |
| `MISS_PROXIMITY_EXP = 3` | cubic falloff | scoring-rule |
| `WATER_SAFETY_MARGIN = 160` | water threshold | physics |
| `MISS_PENALTY_FACTOR = 1.0` | scaling baseline | scaling baseline |
| `CAPTURE_FLOOR_SCALE = 7000` | (now-dropped) | dropped per audit |

That's ~17 magic numbers in one function, a mix of:
- **Physics constants** (water margin, safety/death/flight penalties) — should stay inline as named planner constants. They're "the planner's universe", not user-facing tuning.
- **Scoring rule choices** (× 1.5 for pastilles, × 3 for sparks, miss proximity 300px cubic) — inherent to the game, not knobs. Should be named constants.
- **Magic weighting choices** (× 9 for heightGain, × 4 for yGain, × 4 for totalTicks, × 25 for backtrack, × 30 for water deficit, +650 for loop) — these are the suspicious ones. They're mixing signals into knob outputs without justification.
- **Hidden coupling** (waterUrgency × 1.2 / × 0.85) — auto-scales between safety and pickup behavior. Useful but invisible.

### F. `waterUrgency` is a hidden multi-coupler

```ts
const waterUrgency = this.waterUrgency(waterMargin);
const height = policy.climb * heightPolicy * (1 + waterUrgency * 1.2);
const scoreTerm = scorePolicy * scoreBias * (1 - waterUrgency * 0.85);
const missedRaw = ... * (1 - waterUrgency * 0.85);
```

The `waterUrgency ∈ [0, 1]` factor implicitly couples three terms:
boosts climb by up to 220%, dampens collect by up to 85%, dampens miss
by up to 85%. The intent is "near water, prioritize escape over
harvest". Useful, but: (1) the user can't observe or tune it, (2) it
makes climb/collect non-orthogonal in a hidden way (raising climb does
*more* near water than far from water), (3) the coupling factor
multipliers (1.2, 0.85) are magic.

### G. `detour` and `patience` partially fire on the same routes

`detour` = path-level lateral travel.
`patience` = pickup-level discount when the same pastille is reachable
from a higher wheel.

Different mechanisms. But Phase 2 confirmed they often co-fire on the
same "side scoop" routes. Both penalize "wasted pickup detours".

This isn't strictly redundant — Phase 2 showed they contribute
non-redundantly at the new operating point — but it's a question of
"are they different *axes* of route quality?" If the answer is "they're
two views of the same axis," merging into a single `discipline` knob
would be defensible. If they're orthogonal in some routes, two knobs
is right.

The audit settled on "two knobs" because Phase 2 showed independent
contribution. But the *intent* is the same. Worth documenting clearly:
**detour shapes geometry across all path samples; patience shapes
specific pickup-event costs.** Geometry vs event scope.

## Proposed redesign — orthogonal formulation

### Path-cumulative outcomes (one signal per knob)

```
pathHeight   = max(0, root.blob.y - pathApexY)        // single height signal (px climbed)
pathClaim    = pathReward.pickedValue * 1.5           // total claimed value, scoring-rule weighted
pathSpark    = pathReward.sparkScore * 3              // total spark score, scoring-rule weighted
pathTime     = totalTicks                             // single time signal
pathDetour   = pathOffAxis                            // single shape signal
pathWallTime = (sum of ticks spent on wall, path-cumulative)  // continuous, replaces tiered wallRouteValue
```

(`pathHeight` requires re-introducing `pathApexY` accumulator, which we
dropped after the apex audit. Cheap to add back.)

(`pathWallTime` requires per-step "currently on wall" tracking, similar
to how `pathOffAxis` already accumulates per-step contributions. Replace
the `wallRouteValue()` tier function entirely.)

### Frontier facts (the leaf's own state)

```
endStableBonus    = STATE_BONUS[end.blob.state] ?? STATE_BONUS_FALLBACK
endWaterPenalty   = waterMargin < SAFETY ? (SAFETY - waterMargin) * SAFETY_GRADIENT : 0
endFlightPenalty  = end.blob.state === FLY ? UNRESOLVED_FLIGHT_PENALTY : 0
endTerminalCost   = isTerminal(end) ? TERMINAL_DEATH_COST : 0
```

These are planner physics, not user tuning. Keep as named constants.

### Edge-local mechanisms (penalties for bad-shape edges)

```
edgeBacktrack(start, end)  = (end.y - start.y - BACKTRACK_GRACE) > 0
                              ? (end.y - start.y - BACKTRACK_GRACE) × BACKTRACK_GRADIENT : 0
edgeLoop(sameStable, edgeReward, yGain)
                            = sameStable && noPickup && yGain < LOOP_GAIN_THRESH
                              ? LOOP_PENALTY : 0
```

Independent of policy knobs. Named constants.

### Internal modulators

```
waterUrgency(waterMargin) ∈ [0, 1]       // unchanged: contextual urgency
patienceAdjustment(pathReward)           // applied internally to pathClaim
missProximityPenalty(pathReward)         // applied internally to pathClaim, proximity-bounded
```

`patienceAdjustment` and `missProximityPenalty` are *adjustments to
pathClaim*, not separate knobs. Their strengths are tuned by
`patienceFactor` and `missFactor` constants (or via `policy.patience` if
exposed; see §"User-facing knobs" below).

### User-facing score formula (proposed)

```
total =
  + climbWeight   × pathHeight   × (1 + waterUrgency × WATER_CLIMB_BOOST)
  + collectWeight × (pathClaim × patienceFactor + pathSpark)
                  × (1 - waterUrgency × WATER_COLLECT_DAMP)
  + wallWeight    × pathWallTime
  − paceWeight    × pathTime
  − detourWeight  × pathDetour
  − missWeight    × missProximityPenalty(pathReward) × (1 - waterUrgency × WATER_COLLECT_DAMP)
  + endStableBonus
  − endWaterPenalty
  − endFlightPenalty
  − endTerminalCost
  − edgeBacktrack(start, end)
  − edgeLoop(sameStableTarget, edgeReward, yGain)
```

(`patienceFactor` shrinks `pathClaim` for pastilles also reachable from
a higher wheel; details are an internal mechanism scaled by
`policy.patience`.)

(`missWeight` is now its own coefficient, decoupled from `collectWeight`.
Default = collectWeight × FIXED_MISS_RATIO so the existing coupling is
preserved by default but tunable if needed.)

### User-facing knobs (final)

| Knob | Default | Scales |
|---|---:|---|
| `climb` | 1.0 | `pathHeight` |
| `collect` | 1.0 | `pathClaim + pathSpark` (with `patience` adjustment internal) |
| `wall` | 0.65 (×1) | `pathWallTime` |
| `pace` | 1.0 | `pathTime` |
| `detour` | 0.50 | `pathDetour` |
| `patience` | 0.65 | `patienceAdjustment` strength on `pathClaim` |
| `missWeight` | (linked to `collect` by default) | `missProximityPenalty` |

7 user-facing knobs in the formula, but `missWeight` defaults to
`collect × FIXED_MISS_RATIO` so the exposed UI stays at 6:
`climb, collect, wall, pace, detour, patience`. Power users can override
`missWeight` if needed.

### Named constants (the planner's "physics")

```ts
// Heights
const STATE_BONUS_GRAB = 850;
const STATE_BONUS_WALL = 600;
const STATE_BONUS_FALLBACK = -1000;

// Backtrack: penalize edges that lose ground
const BACKTRACK_GRACE_PX = 20;
const BACKTRACK_GRADIENT = 25;

// Loop: penalize scoops that don't gain anything
const LOOP_PENALTY = 650;
const LOOP_GAIN_THRESH_PX = 20;

// Safety
const TERMINAL_DEATH_COST = 1_000_000;
const UNRESOLVED_FLIGHT_PENALTY = 50_000;
const WATER_SAFETY_MARGIN_PX = 160;
const WATER_DEFICIT_GRADIENT = 30;
const WATER_URGENCY_FAR_PX = 320;
const WATER_CLIMB_BOOST = 1.2;
const WATER_COLLECT_DAMP = 0.85;

// Scoring rule (game-physical)
const PASTILLE_VALUE_WEIGHT = 1.5;
const SPARK_VALUE_WEIGHT = 3;
const MISS_PROXIMITY_PX = 300;
const MISS_PROXIMITY_EXP = 3;
const FIXED_MISS_RATIO = 1.0;  // missWeight = collectWeight × this by default
```

All named, all in one block at the top of the file. Each commented with
"why this number". Magic numbers eliminated from `scoreCandidate()`.

## Concrete change list

For the implementation pass:

### Drop or replace
1. Remove `heightGain × 9 + yGain × 4` mix. Replace with
   `pathHeight = max(0, root.blob.y - pathApexY)`. This requires
   restoring `pathApexY` accumulator (was removed after apex-knob audit).
2. Drop the `× 4` magic in `paceCost`. `pathTime = totalTicks` directly,
   plus an internal continuous `pathWaitTicks` if we want non-linear
   wait acceleration as a separate physics term.
3. Drop tiered `wallRouteValue()`. Replace with `pathWallTime`
   accumulator (per-step "blob.state === WALL" count).
4. Decouple `policy.collectibles` from miss penalty in formula. Default
   coupling preserved via `missWeight = collect × FIXED_MISS_RATIO`.

### Refactor (semantic-preserving)
5. Rename `policy.collectibles → policy.collect`.
6. Rename `policy.detourCost → policy.detour`,
   `policy.patienceDiscount → policy.patience`,
   `policy.wallRoutes → policy.wall`.
7. Move all magic numbers in `scoreCandidate()` to named module-scope
   constants with `// why` comments.
8. Drop the now-redundant inline `× 1.5` and `× 3` in
   `collectibleScorePolicy()` — promote to named constants used both in
   helper and `scoreCandidate`.

### Keep unchanged (working-as-intended)
9. `waterUrgency()` function and its application — it's a contextual
   modulator, useful as-is. Just name the constants.
10. `STATE_BONUS`, `loopPenalty` discrete tiers, terminal/flight
    penalties — physics, not policy.
11. The cumulative `pathReward` model — it's path-cumulative correctly.

## Migration & validation

### Migration steps (proposed order)

1. **Day 0 — refactor pass (semantic-preserving)**: rename knobs,
   extract magic numbers to named constants, no behavior change. Verify
   playwright regression tests still produce the same scores (8096 /
   6822). One-day work.

2. **Day 1 — formula simplification (behavior-changing)**: replace
   `heightPolicy` mix with `pathHeight`, replace `wallRouteValue()`
   tiers with `pathWallTime` accumulator, drop `× 4` from `pace`, add
   `missWeight` coupling. Re-tune the new defaults so the sweet spot
   maps to the same place as today's user-mix replacement
   `(climb=1.0, collect=1.0, detour=0.5, patience=0.65)`.

3. **Day 1 — validation sweep**: 15 minutes wall, ~16 conditions × 16
   trials × 60s. Conditions:
   - `default` (pre-redesign reference, run on a separate branch or
     via env-flag to compare)
   - new defaults (`climb=1, collect=1, detour=0.5, patience=0.65,
     wall=0.65, pace=1`)
   - climb-only (sanity floor)
   - per-knob isolation: 6 conditions, each varying one knob ±0.5 from
     default
   - focus-axis sweep: 6 conditions at focus ∈ {0, 0.2, 0.4, 0.6, 0.8,
     1.0} with the new lerp

   That's ~16 conditions × 16 trials = 256 trials × ~10s/trial ÷ 12
   concurrency = ~3.5 min compute, plus ~10 min for the sweep
   orchestration overhead → ~15 min total.

4. **Day 1 — read sweep**: confirm no regressions vs the audit's
   confirmation sweep results (predicted optimum should still produce
   ~29000 score, ~1600m, ~70 pastilles). If regressions, identify which
   formula change caused them. Most likely culprits: pathApexY without
   yGain shaping might lose some climb-rate; pathWallTime without tier
   bonuses might over- or under-value wall use.

5. **Day 2 — focus slider redesign**: with orthogonal knobs, focus
   becomes a clean climb↔collect lerp. Update `policyFromFocus()`.

### Risks and mitigation

- **`heightGain` discovery bonus matters**: removing the global
  `× 9` heightGain term might reduce the planner's preference for
  routes that newly discover high y. Mitigation: if the validation
  sweep shows lower peak heights, re-introduce a small bonus
  proportional to `(end.maxHeight - root.maxHeight)` as a separate
  pathHeight component.

- **Tier wall bonus was load-bearing in some seeds**: discrete
  `300/450` rewards "did the agent touch a wall at all?", which can
  unlock route diversity. Continuous wallTime might lose this
  threshold effect. Mitigation: if needed, add a one-time `pathWallTime
  > 0 ? FIRST_WALL_BONUS : 0` term as a small physics constant.

- **`missWeight` decoupled from `collect`**: by default we preserve the
  ratio, but a user could now break the implicit coupling. Mitigation:
  document the coupling clearly. Make `missWeight = null → use
  collect × FIXED_MISS_RATIO` the default, with an explicit override
  available.

- **`pathApexY` re-introduction**: the apex tracking was removed during
  the apex-knob ablation cleanup. Adding it back is cheap (one
  accumulator), but make sure it tracks the *minimum y* across all
  edge samples, not just stable-leaf positions.

## Open questions for you

1. **Decoupling `collect` and `miss`**: do you want `missWeight` to be a
   user-facing 7th knob, or hidden-by-default with `missWeight = collect
   × 1.0` baked in? My recommendation: hide by default, expose only if
   future tuning shows a need.

2. **Continuous `pathWallTime`**: I'm proposing this replaces the
   tiered bonus entirely. But the tiered bonus has a "did this route
   touch a wall at all?" character that wallTime might miss for short
   wall taps. Should we keep a small one-time "first wall touch" bonus
   alongside the continuous time? My default proposal: just the
   continuous time, see if it works.

3. **`heightGain` discovery reward**: the current formula rewards
   discovering new run-max heights with `× 9` weight. If we drop this,
   the planner might happily climb to the same height repeatedly. My
   default proposal: drop, let `pathHeight` carry the climb signal,
   re-evaluate after sweep.

4. **`pace` non-linear waits**: the current `pathWaitPenalty` accelerates
   beyond the grace period. Should this stay as a named-constant
   internal mechanism, or be folded into linear pace? Default
   proposal: keep as internal acceleration with named constants
   (`WAIT_GRACE_TICKS`, `WAIT_LINEAR_RATE`, `WAIT_ACCEL_RATE`), part
   of `pathTime` cost.

## Validation sweep design (15 min target)

Conditions, sized for a real comparison:

```
References (3):
  default-old      — current planner code (pre-redesign), via git checkout
  default-new      — new planner with new defaults
  climb-only-new   — sanity floor

Per-knob isolation around new defaults (6 × 2 = 12):
  climb=0.5, climb=1.5
  collect=0.5, collect=2.0
  detour=0.25, detour=1.0
  patience=0, patience=1.0
  wall=0, wall=1.5
  pace=0.5, pace=1.5

Focus axis (6):
  focus=0.0, 0.2, 0.4, 0.6, 0.8, 1.0
```

Total: 3 + 12 + 6 = 21 conditions. With 12 trials × 60s × 12 concurrency
= ~21 × 5s = ~105s compute, plus orchestration overhead = ~3-4 min.

For "15 minutes nice and slow" the user wants more trials per
condition. Let me size accordingly: **21 conditions × 24 trials =
504 trials**. At 10s game time / trial / 12 concurrency = ~7 min
compute. Plus per-condition page-setup overhead ≈ 21 × 5s = 100s.
**Total ~9-10 min.** Good fit for the user's 15-min target with
breathing room.

If we want to push further, bump trials to 32 or seeds to a wider range
to reduce variance estimates. Or add a mini-grid sweep across (collect,
detour) joint at 5 conditions to see if interactions persist post-
redesign.

## Status & next steps

Phase 2.5 = this document. After read-and-discuss:

- **Phase 2.5b — implementation pass** (1–2 days):
  - Day 0: pure refactor (rename, extract constants, no behavior
    change). Verify regression tests.
  - Day 1: behavior-changing simplifications (drop magic mixes,
    introduce pathApexY + pathWallTime accumulators, decouple
    missWeight). Run 15-min validation sweep. Iterate on regressions.

- **Phase 3 — final consolidation** (was originally just rename, now
  becomes the natural commit point after redesign).

- **Phase 4 — focus slider redesign** (cleaner with orthogonal math).

- **Phase 5 — focus validation sweep** (the original Phase 5).
