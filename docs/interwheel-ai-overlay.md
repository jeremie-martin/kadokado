# Interwheel AI Planner And Overlay

Reference for the Interwheel A* playground planner and candidate-line overlay.

## Core Principles

- Value paths, not isolated edges. An edge rollout records facts; the node path
  accumulates those facts; leaves/frontier nodes decide which futures are good.
- If a leaf is good, its ancestor chain must get credit. The selected plan
  backtracks from the best stable leaf, and visual support flows backward from
  competitive leaves.
- Keep expansion hints separate from final value. `nodePriority` may bias search
  toward promising states, but it must not become the path score.
- Local terms are only for local motion constraints: local y movement,
  backtrack, loop avoidance, water safety, and unresolved flights. Any objective
  based on future route outcome should be accumulated root-to-node first.
- Debug rendering is not planner behavior. Chosen-chain highlighting and
  generation coloring are inspection tools, off by default.

## Search Model

`src/playground/interwheel-planner.ts` searches over `InterwheelSim`.

One search edge is:

```text
wait N ticks -> press -> fly until grab / wall / death / flight horizon
```

The planner sees remembered wheels/pastilles in a vertical planning band:
current viewport plus `revealScreensAbove` above and `memoryScreensBelow`
below. The playground exposes lookahead, search depth, rollout budget, and CPU
budget because these limits directly shape which leaves exist.

The overlay renders at most one generation fewer than the search depth. At the
default 4 searched jumps, fourth-generation futures can affect support, but the
visible decision space stops at generation 3.

## Path Scoring

The planner records edge facts and extends node-level path accumulators.

Each edge records a `CollectReward`:

- unique pastilles physically collected on that edge
- spark count collected on that edge

Each child node stores a cumulative `pathReward` built from its parent path plus
the edge reward. Pastilles are unioned by key and sparks accumulate.

`pathReward` currently uses simulator pickup events: a pastille is credited
when the simulated path physically collects it with the live game's 70px
blob-to-pastille pickup geometry. The earlier stable-surface orbit claim path
was removed because it over-credited pickups that the live game had not
actually collected.

An edge that launches away and lands back on the same stable target does not
add its transient pickups to `pathReward`. It has not improved the stable route;
the scoop is treated as transient movement rather than path progress.

Pastille pickup facts are telemetry only in the current score. The old
`thoroughness`/`patience` pickup objective was removed because it did not give a
controllable capture mode. A future capture metric should still follow the same
path-accumulator rule: if a future leaf satisfies a perceived-pastille
obligation, its ancestor route must receive that value.

Wall routes follow the same principle. Each edge records wall ticks and the
canonical wall-jump-and-land event. These are added to `pathWallTicks` and
`pathWallLandings`, and `scoreCandidate()` reads those path values instead of
only the currently evaluated edge.

Height is path-level too:

- `pathHeight = max(0, root.blob.y - pathApexY)` records the highest point
  reached anywhere on the path.
- The default climb score is height-efficient:
  `pathHeight * waterClimbBoost - pathTicks * climbTickCost`, with
  `climbTickCost=3`. The time cost gives urgency to otherwise similar high
  routes while preserving height as the dominant path outcome.
- backtrack cost, loop behavior, water safety, and unresolved-flight penalty
  remain local/frontier planner-physics terms.

If future objectives behave like route outcomes, implement them as path
accumulators first.

## Lineage Support

Support is a rendering signal, not the planner objective. It exists because a
mediocre first jump can open excellent continuations.

Only leaf/frontier edges seed support:

```text
support = isLeaf ? rank(edge.value among leaves)^lineageGamma : 0
support[parent] += support[child] * lineageDecay
```

Defaults:

- `lineageGamma = 4`
- `lineageDecay = 0.65`

Internal edges start at zero and become visible only through descendant futures.
This is the Interwheel replacement for Mario A* overdraw: explicit, score-aware
back-propagation instead of an accidental ring-buffer visual budget.

## Overlay

`src/playground/trajectory-overlay.ts` draws candidate segments in world
coordinates as a Pixi `Graphics` child.

Segments contain:

```text
edgeId, x0/y0/x1/y1, depth, localTick, support, onChosenChain, isLeaf, generation
```

Line alpha is based on support rank. Width is based on the edge's share of
visible leaf/frontier support, capped and multiplied by generation width.
Low-support culling removes visual clutter only; it does not affect planning.

The chosen chain is not highlighted by default. The playground checkbox draws it
over the support view for debugging.

When the blob is already flying, the overlay should not collapse to only the
current airborne arc. It first simulates the current no-input flight to its
predicted stable landing, then runs the normal stable-root search from that
predicted landing and prepends the airborne prefix to those future segments.
This is still a live forecast from the current tick, not a planner commitment:
the forecast may change on the next tick if perception or simulator state
changes.

## Playground Surface

Policy controls affect planner score:

- Focus
- Climb
- Thoroughness
- Detour
- Patience
- Wall
- Pace

Planner controls affect search/perception limits:

- Lookahead screens
- Search jumps
- Edge budget
- CPU budget

Overlay controls affect rendering or lineage support:

- Lineage decay/gamma
- Low-support cull
- Width, alpha, color, and generation weights
- Color by generation
- Highlight chosen chain

Detailed leaf/support diagnostics remain available through
`window.__planner__.lastStats()?.diagnostics`; they are intentionally not part
of the main UI.

## Adding New Planner Signals

Before adding a new objective term:

1. Decide whether it is local motion shaping or path outcome value.
2. For path outcomes, record edge facts and extend a node-level accumulator.
3. Score leaves/frontier nodes from the accumulated path state.
4. Let lineage support back-propagate that leaf value to ancestors.
5. Keep temporary tuning/debug controls out of the default UI unless they are
   actively needed for a current investigation.
