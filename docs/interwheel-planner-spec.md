# Interwheel planner: shared spec

Authoritative summary of how the Interwheel planner actually works today,
how the user-facing knobs get wired into the score, and which signals are
correct vs. known-broken. This is the shared mental model. When the code
moves, this doc moves with it.

All line numbers refer to `src/playground/interwheel-planner.ts` unless
otherwise noted.

## A* call graph

The planner is an A*-style best-first search over a tree of stable→stable
jump options. Each node represents a stable resting state (GRAB or WALL),
each edge represents one "wait N ticks then press jump" plan. Default
horizon is 4 jumps deep (`PLANNER_SEARCH_DEFAULTS.maxStableDepth = 4`).

```
plan() :549
  └─ planStable() :573
       ├─ computeStableClaimableSet(rootState)              // patience set, orbit-band
       ├─ scoreCandidate(...)                                // root score
       ├─ priority-queue loop
       │     ├─ popBestNode(open)
       │     ├─ for each waitSamples():
       │     │     evaluateEdge() :751
       │     │       ├─ recordStep() loop                   // simulates the edge
       │     │       │   └─ collectStepReward(sim, reward)  // observe sim pickup events
       │     │       ├─ extendCollectReward()               // path-cumulative pickups
       │     │       ├─ pathOffAxis / pathApexY / pathWallTicks / pathWallLandings
       │     │       └─ scoreCandidate()                     // edge -> child node value
       │     └─ push child onto open if alive & stable
       ├─ bestStableLeafNode(nodes, edges) :1137             // pick winning leaf
       ├─ bestEdgeIds(nodes, targetNode)                     // trace leaf -> root
       └─ planForNode()                                      // extract action chain
```

The chosen action sequence comes from the **highest-value leaf**, traced
back to root. Functionally: best-leaf wins, root action is read off the
path. There is no separate "backtrack" pass — every node already carries
its full path-cumulative score (computed during `evaluateEdge`).

## Signal table

Each user knob scales **exactly one** path-cumulative quantity through a
fixed normalize constant. This is the orthogonalization. See
`scoreCandidate` :965..1033 for the full formula.

| Knob          | Signal                            | Normalize const               | Code |
|---------------|-----------------------------------|-------------------------------|------|
| `climb`       | `pathHeight = root.y − pathApexY` | `CLIMB_NORMALIZE = 1`         | :115, :986, :994 |
| `thoroughness`| `thoroughnessSignal(pathReward)` (count of grabs, optionally patience-discounted) | `THOROUGHNESS_PER_PASTILLE = 30` | :104, :995, :1067..1078 |
| `wall`        | `pathWallLandings × WALL_LANDING_BONUS + pathWallTicks × WALL_NORMALIZE` | `WALL_LANDING_BONUS = 300`, `WALL_NORMALIZE = 5` | :130, :131 (constants), :991..997 (signal) |
| `pace`        | `totalTicks` (linear)             | `PACE_NORMALIZE = 2`          | :117, :998 |
| `detour`      | `pathOffAxis` (per-edge perpendicular-to-chord integral, summed) | `DETOUR_NORMALIZE = 1/20` | :116, :999 |
| `patience`    | applied **inside** `thoroughnessSignal` as a discount for pastilles also reachable from any wheel above | — | :1067..1078 |

Path-cumulative state lives on each `SearchNode` (:157..173):
`pathReward.collectedKeys`, `pathApexY`, `pathOffAxis`, `pathWallTicks`,
`totalTicks`. Each edge extends the parent's accumulators
(:808, :812..814, :618).

## Final score formula

Pure additive linear (`scoreCandidate`, :986..987):

```
total = climb + thoroughness + wall + stability
      − pace − detour − safety − backtrack − loop
```

Planner-physics terms (not user-tunable, named constants at :47..141):

| Term         | What it does                                                        | Code |
|--------------|---------------------------------------------------------------------|------|
| `stability`  | `STATE_BONUS[GRAB]=850`, `[WALL]=600`, fallback −1000               | :73, :957 |
| `safety`     | `(WATER_SAFETY_MARGIN − margin) × WATER_DEFICIT_GRADIENT` + flight penalty if not landed | :62, :60, :58, :958..962 |
| `backtrack`  | `(end.y − start.y) × BACKTRACK_GRADIENT` once past `BACKTRACK_GRACE_PX` | :83..84, :966 |
| `loop`       | `LOOP_PENALTY = 650` for same-stable-target with no pickup and minimal gain | :87, :969..974 |

There is **NO "always mix climb in" enforcement.** `climb=0` removes the
climb pull entirely. The only contextual mix is the water-urgency
modulation — when the blob is near water, `climb` is boosted by up to
`1 + WATER_CLIMB_BOOST = 2.2×` and `thoroughness` is damped by up to
`1 − WATER_COLLECT_DAMP = 0.15×` (:65..70, :936..937).

## Signal correctness verdicts

### Pastille collection: CORRECT

The planner does not model pickup — it observes it.

- Sim picks up at `distance(blob, pastille) < 70` (`src/games/interwheel/sim.ts:800`).
- Planner records pickups during edge simulation by reading
  `sim.events.collectedPastilles` each step
  (`collectStepReward`, :885..890; called from `recordStep`, :739).
- Path accumulation merges parent + edge collected sets via
  `extendCollectReward` (:876..883), called at :808.
- Each node's `pathReward.collectedKeys` is therefore the exact set of
  pastilles the simulated path would physically grab. Same geometry,
  identical pickup test.
- The earlier orbit-band over-credit bug (`stableSurfaceCollectReward`) is
  fully removed; root reward now starts empty (:560..566).

### Wall signal: hybrid event + continuous

Current form (:950..953):
```
wallSignal = pathWallLandings * WALL_LANDING_BONUS  // 300
           + pathWallTicks    * WALL_NORMALIZE      // 5
```

`pathWallLandings` counts canonical wall-jump-and-land events along the
path: edges that started off the wall, touched it during the edge, and
ended on it. Computed in `evaluateEdge` (around :820..823) and accumulated
on each `SearchNode` like the other path-cumulative quantities.

This restores the discrete-tier preference of the pre-orthogonalization
`wallRouteValue` (commit `8b65c5b`: `+450` for wall-jump-and-land, `+300`
for wall-pass-through) without abandoning the orthogonal-knob design. The
event term anchors "this is a wall-jump-class route"; the tick term
provides a soft gradient on contact duration without rewarding passive
clinging at the same magnitude as launching off the wall.

### Patience claimable set: orbit-band mismatch (low impact)

`computeStableClaimableSet` (:998..1018) uses orbit-band 70px geometry —
"is this pastille within 70px of a wheel's ring?" — rather than blob-
distance 70px geometry. This affects only the **patience discount**
applied inside `thoroughnessSignal`, not main collection scoring. It can
mark a pastille as "stably claimable from a higher wheel" when no actual
trajectory through that wheel would come within 70px of the pastille
itself. Real but isolated; defer until we have evidence it matters.

### Wall-touch detection: faithful

`edgeWallTicks` increments per simulated tick where
`sim.blob.state === BLOB_STATE_WALL` (:733, :743). The planner reads the
sim state directly — no model gap.

## Adding new signals

Follow `docs/interwheel-ai-overlay.md` lines 167..177
("Adding New Planner Signals"):

1. Decide local motion shaping vs path outcome value.
2. For path outcomes: record edge facts in `evaluateEdge` (around
   :733..743), extend a `SearchNode` accumulator (:157..173) at the
   child-node construction site (:612..625) and the corresponding edge
   field (:175..192).
3. Score from accumulated state in `scoreCandidate` (:921..989). Add a
   normalize constant at :115..131 alongside the others.
4. Lineage support already back-propagates leaf value to ancestors for the
   visual overlay; no change needed there.
5. Keep diagnostic UI surfaces opt-in.

## Defaults

- `DEFAULT_PLANNER_POLICY` (:369..376):
  `{ climb: 1.0, thoroughness: 0, wall: 0.5, pace: 1.5, detour: 1.0, patience: 0 }`
- `PLANNER_SEARCH_DEFAULTS` (:383..387):
  `{ budgetMs: 5, maxEdgeRollouts: 360, maxStableDepth: 4 }`
- `PLANNER_PERCEPTION_DEFAULTS` (:378..381):
  `{ revealScreensAbove: 0.5, memoryScreensBelow: 2 }`
