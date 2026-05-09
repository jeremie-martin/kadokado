# Interwheel Planner Spec

Authoritative summary of the current Interwheel planner policy surface.

## Search Model

The planner is a best-first search over stable states. A node is a stable
resting state (`GRAB` or `WALL`). An edge is:

```text
wait N ticks -> press jump -> simulate until grab / wall / death / flight horizon
```

Waiting is part of the path. After a stable landing, the child node gets its own
wait choices.

The final action sequence is traced from the highest-value stable leaf back to
the root. There is no separate scoring pass after the fact: each node already
carries the score for the full root-to-node path.

## Live Policy

The live policy is intentionally small:

```ts
type PlannerPolicy = {
  climb: number;
  wall: number;
};
```

Current default:

```ts
{ climb: 1.0, wall: 0.5 }
```

Removed from live policy for now:

- `thoroughness`: immediate physical-pickup reward did not produce a useful
  capture-control objective.
- `patience`: only modified `thoroughness`, so it had no independent role.
- `focus`: it was only a climb/thoroughness lerp and was not a smooth capture
  control.
- `pace` and `detour`: they duplicated work that now belongs to the climb
  efficiency metric and internal route-shaping penalties.

Pastille telemetry is still recorded. It is not part of the current score until
the capture objective is redesigned.

## Score

`scoreCandidate()` currently computes:

```text
total =
  climb * (pathHeight * waterClimbBoost - pathTicks * climbTickCost)
  + wall * wallSignal
  + stability
  - safety
  - backtrack
  - loop
```

`pathHeight = max(0, root.blob.y - pathApexY)`.

`pathTicks` is the cumulative simulated duration from the root stable state to
the candidate leaf, including waits and flights. The default climb metric mode
is `time-cost`, with:

```ts
{ climbMode: 'time-cost', climbTickCost: 3 }
```

This keeps height as the primary signal while adding urgency: equal or similar
height routes prefer the path that gets there sooner. The historical apex-only
shape remains available to studies as `climbMode: 'legacy'`; `wait-cost` is a
study alternative that charges only stable waiting ticks.

`wallSignal = pathWallLandings * wallLandingBonus + pathWallTicks * wallTickBonus`.

Metric parameters are not policy knobs. The current defaults are:

```ts
{
  climbMode: 'time-cost',
  climbTickCost: 3,
  climbWaitCost: 0,
  wallLandingBonus: 300,
  wallTickBonus: 5,
}
```

The study tooling can sweep these metric parameters separately from policy
coefficients.

## Climb Efficiency Validation

The selected climb default was chosen from climb-only studies (`policy.climb=1`,
`policy.wall=0`) using the trusted pure simulator. A standard sweep over
`climbTickCost=2.5..4.0` showed the useful region and the failure boundary:
`3.0..3.5` gave large speed gains, while `3.75+` introduced low-tail outliers.

The overnight validation on seeds `4200..4239`, 180 seconds per seed, reported:

| config | mean h/min | p10 h/min | min h/min | died | wall% |
| --- | ---: | ---: | ---: | ---: | ---: |
| legacy climb-only | 2150.8 | 2085.0 | 1995.7 | 0% | 0.0 |
| time-cost, climbTickCost=3 | 2429.2 | 2372.7 | 2330.0 | 0% | 0.0 |
| time-cost, climbTickCost=3.25 | 2428.5 | 2385.7 | 1161.0 | 0% | 0.0 |
| time-cost, climbTickCost=3.5 | 2382.3 | 2365.0 | 1233.0 | 0% | 0.7 |
| wait-cost, climbWaitCost=6 | 2372.3 | 2309.0 | 2251.3 | 0% | 0.1 |

`climbTickCost=3` was selected because it preserved the large gain without the
severe low-tail outliers seen at higher values.

## Internal Physics Terms

These are not user-facing policy:

- `stability`: bonus for landing in a stable state.
- `safety`: water deficit and unresolved-flight penalties.
- `backtrack`: penalty for ending significantly below the edge start.
- `loop`: penalty for same-stable-target scoops with no pickup or spark and
  minimal y-gain.

`nodePriority()` also has an internal search-order time bias. This affects which
frontier nodes are expanded first under budget, but it is not part of the final
leaf score.

## Pastille Capture Direction

The next capture objective should not revive the old `thoroughness` shape under
a new name. The desired behavior is: when a pastille is perceived, bias toward
not leaving it behind, even if height suffers.

That future signal should be designed as a path-level capture obligation
metric: perceived, collected, missed/abandoned, still pending, and possibly
route-progress toward a plausible pickup. It must be validated primarily
against capture percentage over perceived obligations, with height/speed/death
reported as tradeoff diagnostics.

## Study Requirements

Interwheel studies must make responsiveness first-class:

- Every non-climb metric must be studied mixed with climb.
- Parameter value -> behavior response should be reported directly.
- The response should be smooth and ideally close to linear over the useful
  range.
- A fixed planner configuration should be measurable without running a sweep,
  using the same raw facts, derived analytics, presets, and reports as larger
  studies.
- Metric parameters, such as `wallLandingBonus` and `wallTickBonus`, must be
  sweepable separately from policy coefficients.
- Focused parameter sweeps can use `--param=KEY` and
  `--param-range.KEY=A:B` for dense floating-point reads around a candidate
  range.
- New metrics should be registered in the study runner rather than adding a new
  one-off script.
- Reports should include run speed (`height / elapsed trial time`), height,
  death rate, wall jumps/min, wall time, perceived pastilles, collected
  pastilles, capture percentage, and planner score-spread diagnostics.
- Response-curve tables are shared tracked analytics, not metric-owned target
  declarations. For example, a wall study should focus on wall jumps/min, wall
  time, and wall steering; capture percentage remains visible as a side effect.
- Per-minute, percent, and ratio analytics should be derived from raw trial
  facts through common formulas, then selected explicitly for the report. Do not
  auto-generate every possible numeric variant.
- Metric-parameter sweeps define a min/max range per parameter and use one
  shared point count per preset. Override that density with `--param-points=N`
  when a denser local read is needed.
- Study presets also define planner search settings: lookahead screens, search
  depth in jumps, edge budget, and per-plan CPU budget. Concurrency is not a
  preset value; by default the runner uses roughly two thirds of available CPU
  cores.
- Parity checks belong to the analytics harness (`npm run analyze:interwheel
  -- --verify-pure-planner`), not the study runner.

The current entrypoint is:

```sh
npm run analyze:interwheel:study
npm run analyze:interwheel:study -- --suite=config --policy.climb=1 --policy.wall=0
npm run analyze:interwheel:study -- --suite=params --metric=climb --param=climbTickCost --param-range.climbTickCost=2.5:4 --param-points=7 --preset=standard
```

It writes `raw.json`, `summary.json`, and `report.md` under
`.tmp/interwheel-studies/<timestamp>/`.
