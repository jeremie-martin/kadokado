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
edgeId, x0/y0/x1/y1, depth, localTick, support, onChosenChain, generation
```

`TRAJECTORY_SAMPLE_TICKS = 1` so displayed polylines are stable frame-to-frame.
`generation` is the search-tree depth of the edge child node and is used only
by the "Color by generation" debug mode.

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

Collectibles influence both edge score and node priority:

- Each edge incurs a `missedCollect` cost proportional to
  `policy.collectibles` for any perceived pastille passed within
  `MISS_PROXIMITY_PX = 300` but not picked up (`MISS_PENALTY_FACTOR = 1.0`,
  linear proximity weight).
- `nodePriority` adds a `collectibleBias` term: `exp(-d / NODE_BIAS_DECAY_PX)`
  summed over uncollected pastilles, scaled by `policy.collectibles *
  NODE_BIAS_FACTOR` (`NODE_BIAS_DECAY_PX = 400`, `NODE_BIAS_FACTOR = 1.5`).
  This pulls best-first expansion toward branches that approach pickups.

There is one temporary A/B knob in the playground:

- `asymmetricYGain`: if enabled, local downward `yGain` is weighted 3x harder.
  Keep this optional until wall-slide collectible routes have been playtested
  against it.

## Lineage Support

Raw edge score alone is not enough for rendering: a mediocre first jump may
open many strong follow-ups. The planner therefore computes `support` after the
tree is built.

For each edge:

```text
support = rank(edge.value)^lineageGamma
support[parent] += support[child] * lineageDecay
```

Defaults:

- `lineageGamma = 3`
- `lineageDecay = 0.65`

This gives a first jump visual credit for the competitive continuations it
enables. It is the Interwheel equivalent of Mario's additive overdraw, but
explicit and score-aware instead of ring-buffer accidental.

## Renderer

`src/playground/trajectory-overlay.ts` is a Pixi `Graphics` child of the game
world container, so segments are drawn in world coordinates and scroll with the
level.

The overlay has two modes:

- `on`
- `off`

`D` toggles the mode. `A` toggles the AI. `P` pauses/resumes the playground.
`R` reloads the page.

### Alpha

Edges are sorted by support. Non-chosen edges draw with:

```text
alpha = rank(support)^alphaGamma
```

The chosen chain is forced to `alpha = 1`.

Defaults:

- `alphaGamma = 4`
- `minDrawAlpha = 0.05`

Low-alpha segments are culled to avoid a carpet of barely visible lines.

### Width

Width uses support magnitude, not alpha:

```text
width = lerp(widthMin, widthMax, clamp(support / p95Support, 0, 1))
```

This keeps alpha and width meaningful:

- alpha: "is this path competitive enough to show?"
- width: "how much search mass flowed through this edge?"

Defaults:

- `widthMin = 1`
- `widthMax = 3`
- `WIDTH_NORM_PERCENTILE = 0.95`

The p95 pivot prevents a single root-prefix support outlier from crushing every
other width to the minimum.

### Color

The normal line color is configurable in the playground. "Color by generation"
is a debug checkbox that maps tree depth to a rainbow palette. It is useful for
spotting whether visual noise comes from first jumps, second jumps, or deeper
future continuations.

## Playground Controls

Policy controls affect planner score:

- Focus
- Wall routes
- Pace

Overlay controls affect rendering or support recomputation:

- Lineage decay
- Lineage gamma
- Alpha gamma
- Min alpha
- Width min
- Width max
- Line color
- Color by generation

Planner experiment:

- Asymmetric yGain (temporary)

## Quick Comparison

| Aspect | Mario A* | Interwheel |
|---|---|---|
| Action space | forward-biased | omnidirectional wheel launch |
| Edge granularity | one/few ticks | wait -> launch -> full flight |
| Storage | global 1000-point ring | per-edge segments |
| Visual budget | implicit ring-buffer competition | explicit lineage support |
| Main visibility signal | overplot volume | rank-of-support alpha |
| Width signal | overplot density | support magnitude |
| Debug coloring | none | optional generation palette |
