# Interwheel Policy Work — Handoff

Status snapshot for resuming the Interwheel planner policy redesign on
another machine. Branch: `interwheel-collectibles-redesign`.

## TL;DR — where we are

We just completed **Phase 2.5b (orthogonal-math redesign)** of the
Interwheel planner policy. The 10-knob "kitchen sink" was reduced to **6
clean orthogonal knobs** and the score formula was rewritten from the
ground up. The audit + math docs explain the why; this doc is the
"how do I pick this back up tomorrow."

**Code is committed but the validation sweep (Phase 2.5b validation) was
interrupted before completing.** The next concrete action when you
resume is to run the sweep and read its output.

The redesign already shows a >2× score improvement at the analytics
regression-test seed (8096 → 18096). Whether this holds across the full
21-condition sweep is what the validation pass is meant to confirm.

## Quick resume sequence

```sh
git checkout interwheel-collectibles-redesign
git pull   # (if pushed; otherwise the local branch is the source of truth)
npm install
npm run build
npx playwright test tests/e2e/playground.spec.ts tests/e2e/analyze-interwheel.spec.ts
# All 3 tests should pass. Same-seed analytics result: score=18096 height=953m.
```

Then run the validation sweep:

```sh
node scripts/interwheel/sweep-knobs.mjs
# ~45 min wall time at default settings (24 trials × 21 conditions × 2-min game time).
# To iterate faster:
node scripts/interwheel/sweep-knobs.mjs --quick           # 4 trials, ~10 min
node scripts/interwheel/sweep-knobs.mjs --trials=8        # 8 trials, ~20 min
```

Output lands in `.tmp/interwheel-knobs/<timestamp>/report.md`.

## Key reading order (to refresh context)

1. **`docs/interwheel-collectibles-objective.md`** — original design
   principle: "value paths, not isolated edges." Pre-existing.
2. **`docs/interwheel-ai-overlay.md`** — pre-existing reference for the
   planner and overlay; "Adding New Planner Signals" section is the
   compatibility contract for new signals.
3. **`docs/interwheel-policy-audit.md`** — Phase 1 audit (which knobs
   to keep) + Phase 2 sweep findings + revised disposition (6 knobs
   final, not 5 as originally proposed).
4. **`docs/interwheel-policy-math.md`** — Phase 2.5 math redesign
   proposal: what's wrong with the old formulas, the orthogonal
   replacement, the migration plan. The formulation it proposes is
   what got implemented.
5. **`docs/interwheel-policy-handoff.md`** — this file.

## What's done (committed)

### The 6-knob orthogonal redesign

`src/playground/interwheel-planner.ts` was rewritten:

- **Removed knobs** (4): `claimRadius`, `missPenalty`, `captureFloor`,
  `gameScoreGain`. The first three are confirmed redundant or actively
  harmful per the audit. `gameScoreGain` improves outcomes when set to 0
  (it pulls the planner away from climb's geometry-aware shaping toward
  a coarser sum-only objective).
- **Renamed knobs** (4): `collectibles → collect`, `wallRoutes → wall`,
  `detourCost → detour`, `patienceDiscount → patience`.
- **Final 6 user-facing knobs**: `climb`, `collect`, `wall`, `pace`,
  `detour`, `patience`.

### `scoreCandidate()` rewritten

Each user knob now scales exactly **one** path-cumulative signal:

```
total =
    + climb    × pathHeight     × waterClimbBoost
    + collect  × pathClaim      × waterCollectDamp
    + wall     × pathWallTicks
    − pace     × pathTime
    − detour   × pathOffAxis
    − miss     × missProximity  × waterCollectDamp     (miss = collect × FIXED_MISS_RATIO internal)
    + endStableBonus
    − endSafetyCost − endBacktrackCost − endLoopCost
```

Replaced:
- `heightPolicy = end.maxHeight + heightGain×9 + yGain×4` →
  `pathHeight = max(0, root.blob.y − pathApexY)`. Single signal,
  single magic factor (1).
- Tiered `wallRouteValue()` (0/300/450) → continuous
  `pathWallTicks` accumulator (per-step blob.state === WALL count).
- `pace × (totalTicks×4 + nonlinearWaitPenalty)` → linear
  `pace × totalTicks`. The whole `waitPenalty()` mechanism + its
  config knobs (`waitPenalty`, `waitGraceTicks`, `longWaitPenalty`,
  `targetClimb`, `scoreBias`) were dropped from `PlannerConfig`.

### Magic numbers extracted to named constants

All ~17 magic numbers in `scoreCandidate()` and friends are now named
module-scope constants with `// why` comments. Three groups:

1. **Frontier / safety physics** — `TERMINAL_DEATH_COST`,
   `UNRESOLVED_FLIGHT_PENALTY`, `WATER_DEFICIT_GRADIENT`,
   `WATER_SAFETY_MARGIN`, `WATER_URGENCY_FAR`, `WATER_CLIMB_BOOST`,
   `WATER_COLLECT_DAMP`, `STATE_BONUS_*`.
2. **Edge-local quality** — `BACKTRACK_GRACE_PX`,
   `BACKTRACK_GRADIENT`, `LOOP_PENALTY`, `LOOP_GAIN_THRESH_PX`.
3. **Game scoring rules** — `PASTILLE_VALUE_WEIGHT`,
   `SPARK_VALUE_WEIGHT`, `MISS_PROXIMITY_PX`, `MISS_PROXIMITY_EXP`,
   `FIXED_MISS_RATIO`.

### `DEFAULT_PLANNER_POLICY` updated to the new operating point

```ts
{
    climb: 1.0,
    collect: 1.0,
    wall: 0.65,
    pace: 1.0,
    detour: 0.5,
    patience: 0.65,
}
```

This is from the Phase 2 confirmation sweep (see audit doc). At the
same seed, the analytics regression test went from score=8096 to
score=18096 — over 2× improvement.

### `CandidateScoreBreakdown` renamed (visible in `bestScoreBreakdown`)

Old keys (`height`, `collectibles`, `wallRoute`, `paceCost`,
`missedCollect`, `detourCost`, `safetyCost`, `backtrackCost`,
`loopCost`) → new keys (`climb`, `collect`, `wall`, `pace`, `detour`,
`miss`, `safety`, `backtrack`, `loop`, `stability`, `total`).

### Sim-level overrides for fair benchmarking

`src/games/interwheel/sim.ts`:

```ts
setPastilleSpawnChanceOverride(value | null)
setGenerationDifficultyOverride(value | null)
```

Production gameplay uses null (the height-ramp curves). For sweeps,
these can pin density / difficulty to constants so policies aren't
confounded by reaching denser pastille regions or harder terrain at
different rates. Reverting either to null restores full production
behavior.

The sweep script `scripts/interwheel/sweep-knobs.mjs` defaults to:
- `pastilleSpawnChance = 1.0` (uniform max density)
- `difficulty = 0.3` (early-mid game character — non-trivial but
  survivable)

Override via `--pastille-spawn=natural`, `--pastille-spawn=0.5`,
`--difficulty=natural`, `--difficulty=0.5`, etc.

These overrides are exposed through `window.__interwheelAnalytics__` and
are sweep-only — production gameplay is untouched.

### UI updated

`playground.html`: 6 sliders (climb, collect, wall, pace, detour,
patience) + the existing focus slider. The 4 dropped knob sliders are
gone. The defaults match `DEFAULT_PLANNER_POLICY`. The focus default
shows 0.33 (= 1.0 / FOCUS_COLLECT_MAX of 3) to match the new collect=1.0
default.

### Tests updated

- `tests/e2e/playground.spec.ts`: references new slider IDs
  (`#policy-wall` etc.) and new policy keys (`wall`, `collect` etc.).
  Default-value expectations updated.
- `tests/e2e/analyze-interwheel.spec.ts`: breakdown keys renamed
  (`height` → `climb`, `paceCost` → `pace`).
- All 3 tests pass.

## What's pending (NOT done, NOT committed)

### 1. Phase 2.5b validation sweep (the immediate next thing)

The 21-condition sweep was started but interrupted. The conditions are
already coded in `scripts/interwheel/sweep-knobs.mjs`:

- 3 references: `default-new`, `climb-only`, `old-style`
- 12 per-knob isolations (each of 6 knobs at ±0.5 from default)
- 6 focus axis points (focus ∈ {0, 0.2, 0.4, 0.6, 0.8, 1.0})

Run it on the new machine. The first partial-result before the
spawn/difficulty pinning showed:
- `default-new`: 2437m, 73 past/min
- `climb-only`: 3381m, 93 past/min (surprisingly higher than default-new)

That surprise was *with the production height-ramp curves on* — climb-
only reached harder/denser terrain. After pinning spawn=1.0 and
difficulty=0.3, those confounds are gone. **The honest comparison is
what the new sweep will produce.**

Read the report at `.tmp/interwheel-knobs/<timestamp>/report.md` and:
1. Compare `default-new` vs `old-style` vs `climb-only` heights and
   scores. Does default-new beat both?
2. Per-knob isolations: are the metrics monotonic in the knob value?
   E.g. detour=0.25 → 0.5 → 1.0 should show smooth tradeoff.
3. Focus axis: does capture% rise smoothly as focus goes 0 → 1?
   Does height drop smoothly? Score should peak somewhere in the
   middle.

If any of these look off, it's likely the new orthogonal math has a
calibration issue. See `docs/interwheel-policy-math.md` "Risks and
mitigation" for what to check.

### 2. Phase 4 — focus slider tuning

The existing `policyFromFocus()` in `src/playground/ai-interwheel.ts`
lerps `climb` and `collect` along these endpoints:

```ts
const FOCUS_CLIMB_MAX = 1.6;
const FOCUS_CLIMB_MIN = 0.3;
const FOCUS_COLLECT_MAX = 3;
```

After the validation sweep, these endpoints should be revisited. With
orthogonal math, the focus axis should produce a clean climb↔collect
tradeoff curve. If the curve has kinks or inversions, the endpoints
need re-tuning. See `docs/interwheel-policy-audit.md` "Phase 4" and
`docs/interwheel-policy-math.md` "Validation sweep design" §
"Focus axis."

### 3. Optional cleanups

- The `claimRadius` / `tubeClaimReward` mechanism is still in the code
  but no longer accessible (no slider, default 0). Keep or fully
  excise? The audit says "keep in code, expose if needed later." Up
  to you.
- The `collectibleBias()` helper still exists and is used by
  `nodePriority()` for search-expansion bias. It reads
  `policy.collect`. Untouched in this round.
- The audit doc and math doc reference `claimRadius` / `missPenalty` /
  `captureFloor` historically. Updating them with the redesign is
  done; remove the historical references if you want a tighter
  presentation.

## Files modified (full inventory)

### New files
- `docs/interwheel-policy-audit.md` — Phase 1 audit + Phase 2
  confirmation sweep findings + revised dispositions.
- `docs/interwheel-policy-math.md` — Phase 2.5 math redesign proposal
  (what's wrong, what's the fix, migration plan).
- `docs/interwheel-policy-handoff.md` — this file.
- `scripts/interwheel/sweep-knobs.mjs` — the validation sweep tool.
  Was added during Phase 2 work; restructured for the Phase 2.5b
  validation conditions.

### Modified
- `src/games/interwheel/sim.ts` — added
  `setPastilleSpawnChanceOverride()` and
  `setGenerationDifficultyOverride()` for fair benchmarking. No
  behavior change to production gameplay.
- `src/playground/interwheel-planner.ts` — the bulk of the redesign.
  PlannerPolicy renamed, magic constants extracted, scoreCandidate
  rewritten, pathApexY + pathWallTicks accumulators added,
  pathOffAxis kept, dropped wait-penalty mechanism + EdgeRoute,
  DEFAULT_PLANNER_POLICY updated.
- `src/playground/ai-interwheel.ts` — POLICY_KEYS list updated,
  focus lerp uses `collect` instead of `collectibles`.
- `src/playground/analyze-interwheel.ts` — scoreBreakdownKeys
  rewritten, sim override setters re-exposed through
  `window.__interwheelAnalytics__`.
- `playground.html` — slider list updated to the 6 user-facing knobs,
  defaults aligned to `DEFAULT_PLANNER_POLICY`.
- `tests/e2e/playground.spec.ts` — slider/policy key references
  renamed, default expectations updated.
- `tests/e2e/analyze-interwheel.spec.ts` — breakdown key references
  renamed.
- `scripts/interwheel/policy-sweep-utils.mjs` — DEFAULT_SWEEP_FIELDS +
  compactTrial mapping updated to new breakdown keys (climb / collect
  / wall / pace / detour / miss instead of the old
  height/collectibles/wallRoute/paceCost names).

## Open questions / decisions to revisit

1. **`missWeight` user-exposure**: today it's hidden, defaulting to
   `collect × FIXED_MISS_RATIO (=1.0)`. If you want to decouple miss
   from collect explicitly, add it as a 7th user knob. Current data
   doesn't show a need; defer until empirical evidence appears.

2. **`heightGain` discovery reward**: dropped per the math redesign.
   If the validation sweep shows the agent revisiting altitudes
   (climbs to 1500m, falls back to 1000m, climbs again to 1500m), the
   discovery reward might need to come back as an internal physics
   constant. Watch the per-tier pastille distribution: if mid-tier
   counts are high but high-tier counts low, that's a sign.

3. **Wall continuous vs first-touch bonus**: the math redesign
   replaced tiered `wallRouteValue` with continuous `pathWallTicks`.
   The audit suggested keeping a "first wall touch" bonus alongside.
   Did NOT keep it. If wall-routing routes get under-rewarded,
   re-introduce as a small physics constant (e.g.,
   `pathWallTicks > 0 ? FIRST_WALL_BONUS : 0`).

4. **Pace linear vs nonlinear**: the math redesign dropped the
   nonlinear acceleration in `waitPenalty`. If short waits feel right
   but long ones (>50 ticks) are no longer penalized strongly enough
   that the planner stalls, re-introduce a small acceleration term as
   internal physics.

5. **Sweep pinning values** (`pastilleSpawnChance=1.0`,
   `difficulty=0.3`): both are arbitrary choices. If the validation
   sweep results look weird, try `--difficulty=0.5` or `--difficulty=
   natural` to see if the issue is sensitivity to the test bed.

## Caveats for resuming

- **Don't push to main without review**. The branch
  `interwheel-collectibles-redesign` has the work; ultraview /
  manual-review before merging is wise given the scope.
- **The regression test scores will not match the prior branch**.
  Score=18096 is the new expected at the analytics seed. The test
  asserts `> 0`, not a specific number, so this is fine; just don't
  be surprised.
- **The `__planner__.policy()` shape changed**. If you have any local
  scripts or notebooks that call `__planner__.policy().collectibles`
  etc., they'll get `undefined`. Use the new keys (`collect`, `wall`,
  `detour`, `patience`).
- **`scriptedReward / scoreBias / waitPenalty / waitGraceTicks /
  longWaitPenalty / targetClimb` are no longer accepted in
  `PlannerConfig`**. If old code passes them they'll be ignored.
- **The sweep script defaults max-ticks to 4800** (2-min game time).
  This is longer than prior sweeps. Wall time is ~2-3 min per
  condition. The full 21-condition sweep is ~45 min.

## Suggested first 30 minutes after handoff

1. (5 min) Pull, install, build, run the regression tests.
2. (5 min) Skim `docs/interwheel-policy-audit.md` and
   `docs/interwheel-policy-math.md` to refresh context.
3. (5 min) Open `playground.html` in the dev server (`npm run dev`),
   try the focus slider, see how the new defaults look in real
   gameplay.
4. (15 min) Kick off the validation sweep:
   `node scripts/interwheel/sweep-knobs.mjs --trials=8` (~20 min) for
   a quick read, or full `node scripts/interwheel/sweep-knobs.mjs`
   if you have time.

Then read the report and decide whether to proceed to Phase 4 (focus
slider tuning) or revisit any of the open questions above.
