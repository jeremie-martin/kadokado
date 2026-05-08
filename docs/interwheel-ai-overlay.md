# Interwheel AI Trajectory Overlay

Current reference for how the Interwheel planner records candidate paths, how
the overlay renders them, and why this differs from Robin Baumgarten's Mario
A* visualization.

## Mario Reference

The Robin Baumgarten Mario A* path drawing is disabled/commented out in the
released source, but the mechanism explains the familiar "mostly one line"
look:

- Mario writes raw `(x, y)` samples into one global `GlobalOptions.Pos[1000][2]`
  ring buffer.
- Expanding a child advances one or a few ticks, so sibling samples differ by
  only a few pixels and overplot.
- The action space is forward-biased (`KEY_RIGHT` is always on), so branches
  mostly share direction.
- The fixed ring buffer is a shared visual budget. Best-first search expands
  the leading branch deeper, so that branch contributes more samples and
  overwrites weaker branches.

Interwheel cannot copy this directly: one edge is a whole wait -> launch ->
flight arc, and wheel launches are omnidirectional.

## Planner Model

`src/playground/interwheel-planner.ts` runs best-first search over
`InterwheelSim`.

One search edge means:

```text
wait N ticks -> press -> fly until grab / wall / death / flight horizon
```

Segments are playground-only debug data:

```text
edgeId, x0/y0/x1/y1, depth, localTick, support, onChosenChain, isLeaf, generation
```

`TRAJECTORY_SAMPLE_TICKS = 1` so displayed polylines are stable frame-to-frame.
`generation` is the search-tree depth of the edge child node and is used by the
"Color by generation" debug mode and planner-side render capping.

The playground exposes `revealScreensAbove` as *Lookahead screens*. The current
default is `0.5`, meaning the planner sees half a viewport above the live view;
setting it to `0` restricts lookahead to the current viewport top. Search depth
and rollout controls are also exposed because lookahead can be invisible if the
planner still stops after the default `4` stable jumps or `360` evaluated
edges.

The overlay intentionally emits one fewer generation than the search depth and
never emits fourth-or-deeper generations. At the default `4` search jumps, the
planner evaluates fourth-generation futures and propagates their lineage support
backward, but the displayed decision space stops at the third jump.

### Edge Scoring

The main scoring fix is that directional terms are local to the edge:

- `heightGain` stays global: it rewards discovering a new run max from the
  live root.
- `yGain`, backtrack penalty, and loop behavior are relative to the edge start
  state. A third-generation jump down from an upper wheel is therefore scored
  as a local backtrack, even if it still ends above the live blob.
- A flight that is still unresolved after `MAX_FLIGHT_TICKS` gets
  `UNRESOLVED_FLIGHT_PENALTY`; it should not rank as a good candidate just
  because it flew upward into unknown space.

Collectibles are scored on the root-to-node path, not as an independent local
edge preference:

- Each edge records only pickup facts: unique pastilles collected, spark score,
  and minimum distance to each perceived pastille.
- A child node extends its parent's `pathReward` by unioning picked pastille
  keys, accumulating spark score, and carrying the best minimum distance seen
  anywhere along the path.
- `collectibles` and `missedCollect` are both computed from that path reward.
  A deep leaf that captures a valuable pastille therefore makes its whole
  ancestor chain valuable through the selected path and lineage support.
- `missedCollect` is proportional to `policy.collectibles` for perceived
  pastilles passed within `MISS_PROXIMITY_PX = 300` anywhere on the path but
  not picked up (`MISS_PENALTY_FACTOR = 1.0`, cubic proximity weight).
- `nodePriority` adds a `collectibleBias` term: `exp(-d / NODE_BIAS_DECAY_PX)`
  summed over uncollected pastilles, scaled by `policy.collectibles *
  NODE_BIAS_FACTOR` (`NODE_BIAS_DECAY_PX = 400`, `NODE_BIAS_FACTOR = 1.5`).
  This only pulls best-first expansion toward branches that approach pickups;
  it is not the value assigned to the final path.

There is one temporary A/B knob in the playground:

- `asymmetricYGain`: if enabled, local downward `yGain` is weighted 3x harder.
  Keep this optional until wall-slide collectible routes have been playtested
  against it.

## Lineage Support

Raw edge score alone is not enough for rendering: a mediocre first jump may
open many strong follow-ups. The planner therefore computes `support` after the
tree is built.

Only leaf/frontier edges seed support. A leaf/frontier edge is an edge whose
child node was not expanded into any children, including dead ends, unresolved
flights, depth-limit leaves, and budget frontier leaves. Internal edges start
with zero support and become important only through descendants.

For each edge:

```text
support = isLeaf ? rank(edge.value among leaves)^lineageGamma : 0
support[parent] += support[child] * lineageDecay
```

For leaf edges, `edge.value` is the cumulative root-to-leaf path value of the
child node, including path-level collectible reward and path-level miss cost.

Defaults:

- `lineageGamma = 4`
- `lineageDecay = 0.65`
- `lineageClaimAmp = 0`

This gives a first jump visual credit for the competitive continuations it
enables. It is the Interwheel equivalent of Mario's additive overdraw, but
explicit and score-aware instead of ring-buffer accidental.

`lineageClaimAmp` is an optional debug/tuning lens. When it is greater than
zero, each perceived pastille captured by one or more leaves is assigned to the
highest-valued leaf that captured it, and that leaf seed gets an extra
uniqueness multiplier. The default `0` keeps lineage support purely path-value
based.

## Renderer

`src/playground/trajectory-overlay.ts` is a Pixi `Graphics` child of the game
world container, so segments are drawn in world coordinates and scroll with the
level.

The overlay has two modes:

- `on`
- `off`

`D` toggles the mode. `A` toggles the AI. `P` pauses/resumes the playground.
`R` reloads the page.

### Alpha and Width

Edges are sorted by support. Low-support edges are culled by rank to avoid a
carpet of weak alternatives, but this is only a cleanup threshold:

```text
draw = rank(support) >= minSupportRank
```

Drawn lines use support rank for alpha, so weak alternatives can recede without
being fully removed. The chosen chain is not highlighted by default; the
playground has a debug checkbox that draws it over the normal support view.

```text
alpha = lerp(alphaMin, alphaMax, rank(support)^alphaGamma)
```

```text
width = clamp(widthMin + (support / leafSupportTotal) * shareWidthScale, widthMin, widthMax)
  * generationWidthWeight(generation)
```

Defaults:

- `minSupportRank = 0.7`
- `widthMin = 0.3`
- `widthMax = 7`
- `shareWidthScale = 18`
- `generationWidthWeights = [1.0, 0.9, 0.5, 0.0]`
- `alphaMin = 0.07`
- `alphaMax = 0.9`
- `alphaGamma = 4`

Width is the edge's share of all rendered leaf/frontier support, capped by
`widthMax`, then multiplied by the edge generation's width weight. When the
render cap or a zero generation weight hides the deepest searched generation,
the last visible generation is treated as the renderer frontier for width
normalization; support itself is still computed from the full searched tree.
This keeps the main trunk visually dominant only when it actually carries a
large fraction of explored successful futures.

### Color

The normal line color is configurable in the playground. "Color by generation"
is a debug checkbox that maps tree depth to a rainbow palette. It is useful for
spotting whether visual noise comes from first jumps, second jumps, or deeper
future continuations.

## Playground Controls

Policy controls affect planner score:

- Focus
- Climb
- Collectibles
- Wall routes
- Pace

Overlay controls affect rendering or support recomputation:

- Lineage decay
- Lineage gamma
- Pastille claim amp
- Low-support cull
- Width base / min
- Width cap / max
- Width share scale
- Generation width weights (Gen 1-3; Gen 4+ is fixed hidden)
- Alpha min/max/gamma
- Line color
- Color by generation
- Highlight chosen chain

Planner experiment:

- Lookahead screens
- Search jumps
- Edge budget
- CPU budget
- Asymmetric yGain (temporary)

## Quick Comparison

| Aspect | Mario A* | Interwheel |
|---|---|---|
| Action space | forward-biased | omnidirectional wheel launch |
| Edge granularity | one/few ticks | wait -> launch -> full flight |
| Storage | global 1000-point ring | per-edge segments |
| Visual budget | implicit ring-buffer competition | explicit lineage support |
| Main visibility signal | overplot volume | support-weighted width + support-rank alpha |
| Width signal | overplot density | descendant leaf support |
| Debug coloring | none | optional generation palette |
