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
- `pace` and `detour`: they duplicated work that should belong to a future
  "climb high efficiently" objective.

Pastille telemetry is still recorded. It is not part of the current score until
the capture objective is redesigned.

## Score

`scoreCandidate()` currently computes:

```text
total =
  climb * pathHeight * waterClimbBoost
  + wall * wallSignal
  + stability
  - safety
  - backtrack
  - loop
```

`pathHeight = max(0, root.blob.y - pathApexY)`.

`wallSignal = pathWallLandings * wallLandingBonus + pathWallTicks * wallTickBonus`.

`wallLandingBonus` and `wallTickBonus` are metric parameters, not policy knobs.
They default to the historical constants:

```ts
{ wallLandingBonus: 300, wallTickBonus: 5 }
```

The study tooling can sweep these metric parameters separately from policy
coefficients.

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
- Metric parameters, such as `wallLandingBonus` and `wallTickBonus`, must be
  sweepable separately from policy coefficients.
- New metrics should be registered in the study runner rather than adding a new
  one-off script.
- Reports should include run speed (`height / elapsed trial time`), height,
  death rate, wall jumps/min, wall time, perceived pastilles, collected
  pastilles, capture percentage, and planner score-spread diagnostics.
- Response-curve tables are shared tracked analytics, not metric-owned target
  declarations. For example, a wall study should focus on wall jumps/min, wall
  time, and wall steering; capture percentage remains visible as a side effect.
- Parity is opt-in for the study runner; use `--parity` when validating that the
  pure-planner path still matches the mounted path.

The current entrypoint is:

```sh
npm run analyze:interwheel:study
```

It writes `raw.json`, `summary.json`, and `report.md` under
`.tmp/interwheel-studies/<timestamp>/`.
