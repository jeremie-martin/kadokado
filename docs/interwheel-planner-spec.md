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
  pastille: number;
};
```

Current default:

```ts
{ climb: 1.0, wall: 0.5, pastille: 0.5 }
```

The `wall` knob multiplies a path-level wall-use signal. The default mode
is `productive` (`metricParams.wallMode='productive'`), which rewards the
height earned on wall-touching edges and gives a smooth, non-oscillating
dose-response on wall-jumps-per-minute. The alternate `event` mode is the
legacy landings + ticks signal and is retained for ablation only — it
exhibits a wall-jumps cliff and a passive wall-hugging pathology under
high mix. `wall=0` is the no-wall baseline by construction.

The `pastille` knob multiplies a path-level capture-obligation signal that
rewards securing pastilles the planner currently perceives. `pastille=0`
collapses to the climb-only baseline by construction. The default mode is
`count` (`metricParams.pastilleMode='count'`); the alternate `graded` mode
adds graded approach credit and is retained as an ablation. The default mix
of 0.5 in count mode lands on the empirical capture-vs-height sweet spot:
≈82% capture at ≈75% of climb-only h/min on the standard sweep
(8 trials × 60s, seeds 4200..4207).

The playground exposes a `Climb ⇄ Pastille` Focus slider that lerps both
knobs in opposite directions (focus=0 → climb=1.5, pastille=0; focus=1 →
climb=0.5, pastille=1). The underlying climb/pastille sliders remain for
fine control; Focus visually tracks the pastille position.

Removed from live policy for now:

- `thoroughness`: immediate physical-pickup reward did not produce a useful
  capture-control objective.
- `patience`: only modified `thoroughness`, so it had no independent role.
- The historical `focus`: it was only a climb/thoroughness lerp and was not
  a smooth capture control. The current Focus slider is a different knob:
  it lerps climb and the new path-level `pastille` signal, which has been
  validated against capture-rate dose-response.
- `pace` and `detour`: they duplicated work that now belongs to the climb
  efficiency metric and internal route-shaping penalties.

## Score

`scoreCandidate()` currently computes:

```text
total =
  climb * (pathHeight - pathTicks * climbTickCost)
  + wall * wallSignal
  + pastille * pastilleSignal
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

`wallSignal` depends on `wallMode`:
- `event` (legacy): `pathWallLandings × wallLandingBonus + pathWallTicks ×
  wallTickBonus`. Counts wall-jump-and-land events flat plus wall-contact
  ticks. The standard sweep showed this produces a cliff in wallJ/min around
  mix≈0.7–0.9 (1 → 27 over a 0.2 mix change), variance explosion at
  mix≈1.3–1.6 (std=31, p90=132 — flip-decision regime), and a passive
  wall-hugging pathology at high mix (wall%=21 with wallJ/min collapsing).
- `productive` (default): `pathWallProductiveLift × wallProductiveBonus`,
  where `pathWallProductiveLift` accumulates `max(0, edgeStartY − edgeEndY)`
  over edges that touched the wall (excluding same-stable-target wall scoops
  to mirror the loop guard). Oscillation cycles net out to ~0 net height per
  cycle so the signal stays near zero — the agent can't trade climb for raw
  wall-event count, and passive wall-hugging earns nothing because it gains
  no height.

`pastilleSignal` depends on `pastilleMode`:
- `count`: `pastilleSecureBonus × |obligation ∩ pathReward.collectedKeys|`
- `graded`: per perceived pastille `p`, contribution is `1.0` if collected,
  else `max(0, 1 − d_min(path, p) / pastilleAttractScale)`. The signal is the
  bonus times the sum of contributions.

Where `obligation` is the set of pastilles perceived at the planner's root
state, and `d_min` is the minimum distance from any flight sample on the
root-to-leaf path to pastille `p` (same-stable-target scoop edges are excluded
to mirror the existing loop guard). The standard sweep showed `count` strictly
dominates `graded` on the capture-vs-height frontier and that `graded`
converges to count behavior as `pastilleAttractScale → 0`.

Metric parameters are not policy knobs. The current defaults are:

```ts
{
  climbMode: 'time-cost',
  climbTickCost: 3,
  climbWaitCost: 0,
  wallLandingBonus: 300,
  wallTickBonus: 5,
  wallMode: 'productive',
  wallProductiveBonus: 3,
  climbPhantomWheelEnabled: true,
  pastilleMode: 'count',
  pastilleSecureBonus: 200,
  pastilleAttractScale: 50,
}
```

The study tooling can sweep these metric parameters separately from policy
coefficients.

## Phantom Wheel

A virtual mid-size wheel is injected into the perceived snapshot every plan
tick, sitting `0.25` screens above the planner's reveal cone in the middle
horizontally. The search's scratch sim treats it as a real landing target:
existing `stability` and `pathApex` reward whatever plan reaches it, and
`climbTickCost=3` still selects the fastest route there. Live game wheels
are unchanged — the phantom is per-plan only, anchored to the root `mapY`
so it stays stable across the whole search.

The phantom encodes "go up" as a planner principle that doesn't depend on
perceiving an actual wheel above the viewport. It eliminates the
catastrophic wall-loop failure mode at low `revealScreensAbove`, and the
new live defaults (`revealScreensAbove=0`, `maxStableDepth=3`,
`climbPhantomWheelEnabled=true`) outperform the older 0.5/4 perception+
search defaults at climb-only by mean ≈ 2620 / p10 ≈ 2540 (vs the historical
~2430 / ~2370 in the table above) — at less perception. Disable for studies
via `--metric-param.climbPhantomWheelEnabled=false`.

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

## Pastille Capture

The capture objective is now the live `pastille` policy knob (see Live Policy
above and the `pastilleSignal` formulation under Score). It is implemented as
a path-level capture obligation metric: each candidate path is scored against
the set of pastilles perceived at the planner's root, and only path-cumulative
collected keys (which already exclude same-stable-target scoops) earn full
bonus. This avoids the "bank-now" pathology of the old `thoroughness` term.

Empirical dose-response in `count` mode (8 trials × 60s, seeds 4200..4207,
climb=1, wall=0):

| `pastille` | capture% | h/min | grabbed |
| ---:       | ---:     | ---:  | ---:    |
| 0          | 57.0     | 2773  | 187     |
| 0.1        | 64.3     | 2588  | 195     |
| 0.25       | 71.3     | 2397  | 198     |
| 0.5        | 82.5     | 2073  | 195     |
| 1          | 90.5     | 1665  | 168     |
| 2          | 93.3     | 1411  | 145     |
| 4          | 95.5     | 1297  | 136     |
| 16         | 95.8     | 1153  | 124     |

The dose-response is monotone non-decreasing in capture rate, smooth (no
cliff), never below the climb-only baseline at any tested mix, and saturates
near 96% — the remainder are pastilles that are physically unreachable in this
generation profile. Total pastilles grabbed peaks around `pastille=0.25` and
declines at higher mix because the agent climbs less and therefore perceives
fewer pastilles per minute.

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
