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
edgeId, x0/y0/x1/y1, depth, localTick, support, onChosenChain
```

Sampling inside `evaluateEdge()` is sparse: every `TRAJECTORY_SAMPLE_TICKS = 3`
ticks, plus on press, terminal, and state transitions. Each edge becomes a
polyline with ~tens of points.

`support` is **not** the raw planner score of that one edge — it's the
visual overdraw budget the renderer should give it. Follow-up jumps already
exist as later edges in the search tree, so after the tree is built the
planner computes **lineage support** in `lineageSupportForEdges()`:

1. each edge seeds with `rank^LINEAGE_SUPPORT_GAMMA` of its own raw score
   (worst rank = 0, best = 1, γ=3 by default — strong descendants count more
   than mediocre ones);
2. a single bottom-up pass adds `LINEAGE_SUPPORT_DECAY × child_support`
   (0.65) to each parent edge.

A first jump that opens up many strong follow-ups accumulates support from
each of them, even when its own landing scores middling. Conversely, a first
jump with a brilliant immediate score but no productive descendants doesn't
get inflated. The bottom-up pass is sound because A* expands best-first and
a child edge can only be created after its parent node has been popped, so
a parent always precedes any of its children in the edge array.

`segmentsForEdges()` then stamps each segment with its edge's `support` and
an `onChosenChain` boolean (`bestEdgeIds.has(edge.id)` — the chain back from
the chosen target node to the root). The renderer consumes only those two
fields.

### `src/playground/trajectory-overlay.ts` — rendering

A Pixi.js `Graphics` child of the game's scrolling `world` Container, so
segments use world-space coordinates and scroll automatically.

Two modes (toggled with `D`): `on` / `off`. No filter mode — the rendering
rule does the convergence work directly. See §4 for the reasoning.

The rule:

- Chosen-chain segments draw at `alpha = 1`.
- Other segments draw at `alpha = rank^ALPHA_GAMMA`, where `rank ∈ [0, 1]` is
  each edge's position when sorted ascending by `support` (worst = 0,
  best = 1) and `γ = 4`.
- Below `MIN_DRAW_ALPHA = 0.05` segments are culled outright (no draw call)
  so the long tail doesn't accumulate into a noise carpet.
- Stroke width is interpolated by **support magnitude** (not alpha):
  `width = widthMin + (widthMax − widthMin) × clamp(support / p95Support, 0, 1)`.
  This decouples width from alpha so they encode different things — see §5
  for the framing. The chosen-prefix root reads thick + opaque; the chosen-
  plan tip reads thin + opaque (low own support but `onChosenChain`); off-
  chain prefixes that the search explored read medium-width + faded; off-
  chain leaves read thin + faded.

One color (`0x9be8ff`). All edges drawn in a single pass — no kind
layering, no per-segment color.

Why rank rather than support magnitude directly: the lineage recurrence has
factor `branching × decay` typically > 1, so support grows roughly
exponentially with depth on the principal prefix. Linear normalize-to-max
would let one outlier (depth-0 prefix root) dominate `supportMax` and crush
every other edge below the cull threshold. Log scaling and percentile-max
were considered; rank-mapping is the cleanest because it preserves the
*ordering* lineage support imposes (which is the structural improvement)
without inheriting the exponential blow-up. The previous rank-of-value
calibration carries over directly: γ=3 was confirmed by playtest.

Tunables are exposed as instance setters (`planner.setLineage`,
`overlay.setAlphaGamma`/`setMinDrawAlpha`/`setSegmentWidth`) and bound to
sliders in the playground "Overlay" panel. Defaults live at the top of the
respective source files (`LINEAGE_DEFAULTS`, `OVERLAY_DEFAULTS`):

| Constant                  | Default | Effect                                      |
|---------------------------|---------|---------------------------------------------|
| `ALPHA_GAMMA`             | `4`     | rank-curve steepness; raise → fewer bright lines |
| `MIN_DRAW_ALPHA`          | `0.05`  | cull threshold; raise → cleaner long tail   |
| `SEGMENT_COLOR`           | cyan    | uniform stroke color                        |
| `widthMin`                | `1`     | stroke width at low support (off-chain leaves) |
| `widthMax`                | `3`     | stroke width at p95 support (chosen-prefix root and near-top expanded prefixes) |
| `WIDTH_NORM_PERCENTILE`   | `0.95`  | percentile of support distribution that saturates at widthMax |
| `LINEAGE_SUPPORT_GAMMA`   | `3`     | raw-score rank → seed support; γ=3 means only top descendants pull a parent up |
| `LINEAGE_SUPPORT_DECAY`   | `0.65`  | fraction of child support a parent inherits |

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
rendering layer instead, via a lineage-support pass: each edge's support
seeds at `rank^γ` of its score, then accumulates a decayed share of each
descendant's support. The renderer then ranks edges by support and maps
`rank^γ` to alpha (§4). Losers fade because they lose, not because a filter
excluded them.

This is the same idea as heuristic dominance, expressed at the rendering
layer: **the visualization should reward search effort, not just
enumeration**.

---

## 4. Convergence by design — what we built and why

The original implementation had a `cinematic` filter mode (bucketing branches
by launch depth, proximity-to-best tests, wait-prefix trimming) bolted on
top of the renderer purely so the animation was watchable. It worked but it
was not a principled rule, and tuning it felt like fighting the tool rather
than expressing intent. We replaced it with one principle: **rendering
opacity is a function of how much competitive search mass an edge carries**,
expressed via a lineage-support value computed by the planner, normalized
to alpha by the renderer.

This is the same principle behind both Mario phenomena: heuristic dominance
suppresses uncompetitive branches, and the ring buffer suppresses branches
that didn't earn many writes. Both are forms of "the leader wins by being
better, not by being filtered to win."

### Three iterations, what each one solved

**Value-based first.** `alpha = exp(-((bestValue − value)/scale)^γ)` with
`scale = best − median`. We tuned γ from 1 → 2 → 3 → 4. The visual barely
changed because our raw score landscape clusters most edges very close to
the best — with a tight cluster, `scale` is small, the upper-percentile
edges all have tiny gaps relative to it, and γ-steepening just bends the
curve in a region where it's already flat-near-1. Too many similarly-bright
lines.

**Rank-based second.** `alpha = rank^γ` with γ=3, where rank ∈ [0,1] is each
edge's position when sorted by score ascending. This forced a fixed alpha
spread regardless of how clustered the raw scores were — if 30 edges sat
within 1% of the best in score, they got distinct ranks and therefore
distinct alphas. Convergence appeared, but treated each edge in isolation:
a "good first jump that opens up many strong follow-ups" stayed dim because
its own landing score was middling.

**Lineage support, current.** A first jump's brightness should reflect the
plans starting *from* it, not just its own landing. The planner now computes
`support[e] = rank(e)^γ + LINEAGE_SUPPORT_DECAY × Σ support[children(e)]` in
a single bottom-up pass over the search tree. The renderer then ranks edges
by support and maps `rank^ALPHA_GAMMA` to alpha — same mapping shape as
iteration two, but now the *ordering* it ranks reflects tree structure,
not isolated edge scores. (Magnitude can't be used directly: with
branching×decay > 1 the recurrence makes support grow roughly exponentially
with depth on the principal prefix, so one outlier dominates `supportMax`
and crushes the tail under linear normalization. Log and percentile-max
were considered; rank-of-support is cleanest, since the structural
information is in the ordering, not the magnitudes.)

What this gives us:

- A first jump that opens up many strong follow-ups accumulates support
  from each of them and lights up its prefix, even when its own landing is
  middling. (Mario ring-buffer "additive overdraw," expressed as opacity.)
- The `LINEAGE_SUPPORT_GAMMA = 3` seed means only **strong** descendants
  contribute meaningfully — mediocre fanout doesn't inflate prefixes.
- The `0.65` decay protects against a single brilliant deep leaf
  disproportionately lighting up a mediocre prefix (`0.65^d` falls off
  fast, so a one-off lottery ticket only travels a few levels up).
- Off-chain edges with no expanded descendants get just their own
  `rank(value)^γ`, so the long tail still has a meaningful gradient.

The `α buckets` and `Support` rows in the playground stat panel surface the
live distribution.

### What this shifted

The hard work moved from **"render-time pruning so the animation looks
good"** to **"score and tree modeling so the planner exposes a meaningful
gradient."** If the underlying score is uninformative (e.g. a single-
objective score that makes all collectible-route edges artificially
identical) no amount of rendering cleverness will paint a convergence story
that isn't there — but lineage support also helps here, because even a
flat raw-score distribution still produces a non-flat support distribution
once the tree's branching structure is folded in.

---

## 5. Visual channel mapping — design space

The renderer has two visual channels per segment (alpha and width), and the
search produces three usable underlying signals (raw value, lineage support,
rank-of-X). How each channel maps to a signal is a design choice with real
visual consequences. Captured here so future iterations don't relitigate
ground.

### What we want each channel to communicate

Three distinct things, ideally on independent visual channels:

1. **The chosen plan** — should pop. The user needs to see where the blob
   is going.
2. **Search effort distribution** — where the planner's compute went. Mario's
   ring-buffer naturally encoded this: branches the search expanded deeply
   got more pixels overplotted; thin/abandoned branches got few. This is the
   "leader looks thick" effect.
3. **Alternative competitiveness** — among non-chosen edges, which were
   near-tied with the winner vs. obvious losers. Useful for understanding
   the search's reasoning ("there were two viable routes here, the planner
   picked X").

### Underlying signals available

| Signal      | What it is                              | Property                                   |
|-------------|-----------------------------------------|--------------------------------------------|
| `value`     | edge's own immediate score              | per-edge, raw                              |
| `support`   | own + decayed Σ descendants' support    | per-edge, magnitude (Mario-like, blows up with depth) |
| `rank-of-X` | position in sorted distribution         | per-edge, distribution-stable, max=1       |

### Mapping options considered

**Option A: One signal, both channels.**
`alpha = rank(support)^γ`, `width = lerp(min, max, alpha)`. Width and alpha
co-vary perfectly. *Critique:* alpha is overloaded — it encodes both "is
this visible" and "how prominent" — and rank discards magnitude that the
additive-overdraw intuition cared about.

**Option B: Decoupled — alpha = rank, width = support magnitude.** *(current direction)*
- `alpha = rank(support)^γ` (chosen-chain forced to 1) — distribution-
  stable visibility, cull-friendly.
- `width = lerp(widthMin, widthMax, normalize(support))` — Mario-like
  additive overdraw.

Each channel encodes a distinct concept: alpha = "is this worth showing,"
width = "how much search effort flowed through this edge." The chosen-prefix
root reads thick *and* opaque; the chosen-plan **tip** reads thin-but-fully-
opaque (low own support but `onChosenChain`), like a tree branch tapering —
visually mirroring "this is where the planner thinks the action is going
next." Off-chain prefixes that the search explored get medium width even at
low alpha. Off-chain leaves get widthMin and faded — barely visible noise.
Recurrence blow-up handled by normalizing against a percentile (p95), not by
max.

**Option C: Pure magnitude, both channels.**
Both `alpha` and `width` driven by `normalize(support)`. Magnitude info
preserved everywhere. *Critique:* outliers (the chosen-prefix root with
support ~25) crush the long tail unless you pick a good pivot percentile.
Loses the distribution-stable nice-spread property of rank.

**Option D: Drop the chosen-chain shortcut.**
The chosen prefix already has the highest support, so it'd naturally be
brightest+widest. *Critique:* loses guaranteed visual primacy — if a near-
tied alternative exists, the chosen plan might not visually pop.

### Decision and current state

Going with **Option B, in two steps**:

- **Step 1 (current):** width = `lerp(widthMin, widthMax, support/p95Support)`
  with p95-percentile saturation. Alpha unchanged. Tunable widthMin/widthMax
  in the playground; default widthMax > widthMin so the tapering shows on
  first load.
- **Step 2 (after playtest):** if Option B's tapering reads well, ship. If
  the chosen-leaf-thin effect is confusing, fall back to width tied to alpha
  (Option A) and rely on cranking widthMax for chosen-plan prominence.

The decision is "what should width *mean* — same thing as alpha, or
something complementary?" Option B says complementary; Step 2 will confirm
or revert.

---

## 6. Side-by-side reference

| Aspect              | Mario A*                              | Interwheel today                       |
|---------------------|---------------------------------------|----------------------------------------|
| Build status        | commented out                         | live in playground                     |
| Edge granularity    | one `advanceStep` (or a few)          | full wait → launch → flight arc        |
| Action space        | forward-only (`KEY_RIGHT` always set) | omnidirectional launch                 |
| Storage             | global `int[1000][2]` ring            | per-edge `Segment[]` on each edge      |
| Sampling rate       | every tick × 2                        | every 3 ticks + transitions            |
| Per-segment metadata| none                                  | edgeId, x0/y0/x1/y1, depth, localTick, support, onChosenChain |
| Visual budget       | shared, leader dominates by volume    | shared via lineage support → rank → alpha |
| Convergence         | emergent (heuristic + ring)           | emergent (lineage support → rank → alpha) |
| Renderer            | external Mario engine                 | Pixi `Graphics` child of `world`       |
| Reset               | per `startSearch` (commented out)     | `draw([])` on AI-off / game-end        |
| User toggle         | none                                  | `D` toggles overlay on/off, `A` toggles AI |
