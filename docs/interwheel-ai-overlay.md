# Interwheel AI trajectory overlay — design notes

Reference notes on how the planner's debug path is drawn, how the famous Mario
A* agent does the same thing, and why the two visualizations look so different
in practice. Captured so we don't have to rediscover this.

---

## 1. Reference: the Robin Baumgarten Mario A* agent

Source: `mario-astar-robinbaumgarten/` (clone of the CIG 2009 agent).

The path-drawing code is **disabled in the released build** — all of it is
commented out — but the mechanism is interesting because it's the version most
people remember from videos.

### Storage

A single static integer buffer in the Mario engine:

```java
GlobalOptions.Pos[1000][2]   // (x, y) pairs, world coordinates
```

It's global, fixed-size, kind-blind. No edge id, no best/dead, no metadata.

### Recording site

Inside `SearchNode.simulatePos()` in `astar/AStarSimulator.java`, around the
inner `for (i < repetitions)` loop:

- one write **before** `advanceStep(action)`
- one write **after** `advanceStep(action)`
- index `debugPos` is incremented per write and **wraps at 1000** (ring buffer)

So every tick of every expanded child contributes 2 points.

### Reset

`startSearch()` zeros the whole buffer and resets `debugPos = 0` at the start
of each plan. Also commented out. In practice the reset is rare, which matters
— see §3.

### Renderer

The agent itself does not draw. The Mario engine reads `GlobalOptions.Pos[]`
each frame and paints lines/dots over the level. The agent has no opinion
about color, kind, or filtering — every node's every step lands in the same
array.

---

## 2. Current Interwheel implementation

Three files cooperate.

### `src/playground/interwheel-planner.ts` — recording

A* over `InterwheelSim`. An "edge" is **one full decision**:
*wait N ticks → press to launch → fly until next grab / wall / death*, capped
at `MAX_FLIGHT_TICKS = 260`.

Each `SearchEdge` carries its own `segments: Segment[]`. A `Segment` is
deliberately minimal — only what the renderer needs:

```
edgeId, x0/y0/x1/y1, depth, localTick, value, onChosenChain
```

Sampling inside `evaluateEdge()` is sparse: every `TRAJECTORY_SAMPLE_TICKS = 3`
ticks, plus on press, terminal, and state transitions. Each edge becomes a
polyline with ~tens of points.

After search, `segmentsForEdges()` walks each edge once and stamps every
segment with the edge's scalar `value` plus an `onChosenChain` boolean
(`bestEdgeIds.has(edge.id)` — the chain back from the chosen target node to
the root). No kind/phase enum, no per-segment scoreGain. The renderer
consumes only the scalar value and the chain bit.

### `src/playground/trajectory-overlay.ts` — rendering

A Pixi.js `Graphics` child of the game's scrolling `world` Container, so
segments use world-space coordinates and scroll automatically.

Two modes (toggled with `D`): `on` / `off`. No filter mode — the rendering
rule does the convergence work directly. See §4 for the reasoning.

The rule:

- Chosen-chain segments draw at `alpha = 1`.
- Other segments draw at `alpha = rank^γ`, where `rank ∈ [0, 1]` is the edge's
  position when all evaluated edges are sorted by `value` ascending (worst = 0,
  best = 1) and `γ = ALPHA_GAMMA = 3`.
- Below `MIN_DRAW_ALPHA = 0.05` segments are culled outright (no draw call) so
  the long tail doesn't accumulate into a noise carpet.

One color (`0x9be8ff`), one line width (`1`). All edges drawn in a single
pass — no kind layering, no per-segment color.

The mode is governed by `ALPHA_MODE` at the top of the file. `'rank'` is
current; a `'value'` mode (`alpha = exp(-(gap/scale)^γ)`) is kept as a
documented baseline for A/B comparison. See `buildEdgeAlpha()` for both
formulas. §4 documents why rank ended up the default.

Tunables (top of file):

| Constant          | Default | Effect                                       |
|-------------------|---------|----------------------------------------------|
| `ALPHA_MODE`      | `rank`  | rank-based vs value-based fade               |
| `ALPHA_GAMMA`     | `3`     | curve steepness; raise → fewer bright lines  |
| `MIN_DRAW_ALPHA`  | `0.05`  | cull threshold; raise → cleaner long tail    |
| `SEGMENT_COLOR`   | cyan    | uniform stroke color                         |
| `SEGMENT_WIDTH`   | `1`     | uniform stroke width                         |
| `SCALE_PIVOT`     | `0.5`   | value-mode only — calibration percentile     |

### `src/playground/ai-interwheel.ts` — wiring

- Instantiates `TrajectoryOverlay(g.world)` and re-draws after each plan.
- Keys: `A` toggles AI (clears overlay when off), `D` cycles overlay mode,
  `R` reloads.
- On game-end, `overlay.draw([])` clears the path.

---

## 3. Why Mario looks like one line and ours looks like a fan

The renderer is not the cause. There are three structural causes.

### a) Action-space asymmetry

Mario's action set is forward-only: `createPossibleActions()` returns
`{jump, speed, jump+speed, …}` and the agent always ORs in `KEY_RIGHT = true`.
There is no "go left". So every simulated trajectory drifts rightward; the fan
can only spread vertically (jumps) and only diverges meaningfully when the
physics actually splits — i.e. when there's something to jump over. That's
exactly the "I only see branches when there's an enemy" observation.

Interwheel's launch from a wheel is a **circle of possible directions**.
Different `waitTicks` values legitimately send the blob left, right, up. There
is no built-in directional bias.

### b) Granularity asymmetry

In Mario, expanding a child means one (or a few) `advanceStep` calls. Two
sibling children differ by **a few pixels** over their entire recorded
contribution — they all run right, one's jumping, one's sprinting, the
x-deltas barely diverge. Visually those siblings overplot into one fat line.

In Interwheel, each "edge" is a full ballistic arc to the next grab. Two
sibling edges that differ only in wait-time launch from slightly different
points on the wheel and end up at completely different wheels. Those arcs
diverge by hundreds of pixels and often go in opposite directions.

Same number of expansions, very different on-screen footprint.

### c) Storage asymmetry — competition for visual budget

Mario writes into a 1000-slot ring buffer. Multiple branches **compete** to
occupy it. A* with a strong heuristic expands the principal variation deepest;
the leader's deep expansion produces many writes, losers' shallow expansion
produces few. The ring naturally fills with samples from the leading branch
and overwrites the others.

Interwheel gives each edge its own dedicated polyline. A bad edge's polyline
would be just as visible on screen as a good edge's polyline if everything
were drawn at the same alpha — there is no shared budget at the storage
layer. The current implementation re-introduces the same effect at the
rendering layer instead, by mapping alpha to each edge's rank among all
edges (§4). Losers fade because they lose, not because a filter excluded
them.

This is the same idea as heuristic dominance, expressed at the rendering
layer: **the visualization should reward search effort, not just
enumeration**.

---

## 4. Convergence by design — what we built and why

The original implementation had a `cinematic` filter mode (bucketing branches
by launch depth, proximity-to-best tests, wait-prefix trimming) bolted on top
of the renderer purely so the animation was watchable. It worked but it was
not a principled rule, and tuning it felt like fighting the tool rather than
expressing intent. We replaced it with a single render-time mapping from
edge value to alpha.

The framing: **rendering opacity is a function of how competitive an edge is
with the best**, not a function of arbitrary visual heuristics. As one path
dominates the score, alternatives fade automatically. When multiple paths are
genuinely competitive (one toward a collectible, one straight up), they all
stay visible because they're all close to the best.

This is the same principle behind both Mario phenomena: heuristic dominance
suppresses uncompetitive branches, and the ring buffer suppresses branches
that didn't earn many writes. Both are forms of "the leader wins by being
better, not by being filtered to win."

### Two formulations, value-based vs rank-based

We tried both, in this order.

**Value-based (first attempt):** `alpha = exp(-((value_gap)/scale)^γ)`, where
`scale` is the gap from the best edge to the median edge. Median edge always
sits at `alpha = exp(-1) ≈ 0.37` regardless of γ; γ steepens the curve on
both sides of the median. We tuned γ from 1 → 2 → 3 → 4 and raised the cull
threshold, but the visual barely changed.

The reason was a property of our score landscape: most non-trivial edges
cluster very close to the best in *value*. With a tight cluster near the top,
`scale` itself becomes small, and the upper-percentile edges all have tiny
gaps relative to it — γ steepens the curve but the inputs are all in the
"near zero gap" region where the curve is flat-near-1. Result: too many
similarly-bright lines.

**Rank-based (current):** sort edges by value ascending, assign each a
`rank ∈ [0, 1]` (worst = 0, best = 1), and use `alpha = rank^γ` with γ = 3.
This forces a fixed alpha distribution regardless of how clustered the
underlying values are. Even if 30 edges sit within 1% of the best in value,
they get distinct ranks and therefore distinct alphas; only the actually-top
few stay bright, the rest fade as their rank drops.

The trade-off: rank-mode loses the "two near-tied alternatives are both
bright" property of value-mode. If your score landscape ever produces a
genuine bimodal split (a few clearly-best alternatives, then a wide gap), the
near-tied top alternatives still differentiate by rank — which is arguably a
mild loss of fidelity. In practice we accept it: the convergence-by-design
property is more valuable than perfect value-fidelity, and the chosen plan
is still highlighted unconditionally via `onChosenChain`.

`ALPHA_MODE` at the top of `trajectory-overlay.ts` lets you flip back to
value-mode for diagnosis if the rank fade ever feels off. `α buckets` and
`Value` rows in the playground stat panel surface the live distribution so
you can tell which mode the score landscape calls for.

### What this shifted

The hard work moved from **"render-time pruning so the animation looks
good"** to **"score modeling so the planner's evaluation gradient is
meaningful."** Rank-mode is robust to score-landscape shape, but if the
ranking itself is uninformative (e.g. a single-objective score that makes
all collectible-route edges artificially identical), no amount of rendering
cleverness will paint a convergence story that isn't there. That's a future
score-function conversation, not an overlay one.

---

## 5. Side-by-side reference

| Aspect              | Mario A*                              | Interwheel today                       |
|---------------------|---------------------------------------|----------------------------------------|
| Build status        | commented out                         | live in playground                     |
| Edge granularity    | one `advanceStep` (or a few)          | full wait → launch → flight arc        |
| Action space        | forward-only (`KEY_RIGHT` always set) | omnidirectional launch                 |
| Storage             | global `int[1000][2]` ring            | per-edge `Segment[]` on each edge      |
| Sampling rate       | every tick × 2                        | every 3 ticks + transitions            |
| Per-segment metadata| none                                  | edgeId, x0/y0/x1/y1, depth, localTick, value, onChosenChain |
| Visual budget       | shared, leader dominates by volume    | shared via render-time alpha (rank-based) |
| Convergence         | emergent (heuristic + ring)           | emergent (rank → alpha mapping)        |
| Renderer            | external Mario engine                 | Pixi `Graphics` child of `world`       |
| Reset               | per `startSearch` (commented out)     | `draw([])` on AI-off / game-end        |
| User toggle         | none                                  | `D` toggles overlay on/off, `A` toggles AI |
