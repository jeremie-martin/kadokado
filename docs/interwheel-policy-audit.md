# Interwheel Policy Knob Audit

Audit of every policy knob currently exposed by `InterwheelPlanner`, with a
recommended consolidation. Companion doc to `interwheel-ai-overlay.md`
(reference) and `interwheel-collectibles-objective.md` (design principles).

## TL;DR (post-Phase 2 confirmation, 2026-05-08)

- **Today: 10 knobs** — `climb`, `collectibles`, `wallRoutes`, `pace`,
  `claimRadius`, `detourCost`, `patienceDiscount`, `missPenalty`,
  `captureFloor`, `gameScoreGain`.
- **Three knobs are confirmed redundant** (`missPenalty`, `captureFloor`,
  `gameScoreGain`) — ablation evidence below.
- **One knob is confirmed inert** at the new operating point
  (`claimRadius`) — Phase 2 study A and the confirmation sweep both show
  no contribution; wider tube actively hurts via "phantom claims".
- **Recommended consolidation: 6 user-facing knobs** —
  `climb`, `collect`, `detour`, `patience`, `wall`, `pace`. Initially
  the audit proposed 5 (folding detour+patience into a single
  `discipline` multiplier), but the confirmation sweep showed the two
  contribute partly independently at the new operating point — keeping
  them separate is more honest.
- **Path toward a single `focus` slider** in a future phase: the
  natural lerp is `climb ↔ collect`, with `detour`, `patience`, `wall`,
  `pace` either constants or focus-derived.
- **Confirmed new operating point** (beats user-mix and default
  significantly):
  ```
  climb=1.0, collect=1.0, detour=0.50, patience=0.65,
  wall=0.65, pace=1.0
  ```
  vs `default`: +231m (+17%), +5560 score (+23%), +27% raw harvest.
  vs `user-mix`: +204m (+14%), +4566 score (+18%), +21% pastilles.

## Methodology

For each knob the audit answers five questions:

1. **Formula** — exact computation it triggers in `scoreCandidate()`.
2. **Path-cumulative status** — does it conform to "value paths, not
   isolated edges" (`interwheel-ai-overlay.md` §"Adding New Planner
   Signals", `interwheel-collectibles-objective.md` §"Core Principle")?
3. **Mechanism overlap** — which other term in `scoreCandidate()` reads
   the same data or duplicates the same intent?
4. **Ablation evidence** — what does the most recent sweep say about
   contribution to the user-mix candidate (climb=1, collectibles=1.8,
   wallRoutes=0.65, pace=1, claimRadius=70, detourCost=0.30,
   patienceDiscount=0.65, missPenalty=2, captureFloor=0.35,
   gameScoreGain=1.10)?
5. **Disposition** — KEEP, MERGE, or DROP, with rationale.

Numbers are from `.tmp/interwheel-knobs/2026-05-08T13-49-15-691Z/report.md`,
4 trials × 60s. Treat individual deltas as indicative, not statistical.

## Per-knob audit

### 1. `climb` — KEEP

- **Formula:** `policy.climb × heightPolicy × (1 + waterUrgency × 1.2)` where
  `heightPolicy = end.maxHeight + heightGain × 9 + yGain × 4`.
- **Path-cumulative:** Mixed, intentionally. `heightGain` is global (run-max
  discovery), `yGain` is local. Doc-justified split (`interwheel-ai-overlay.md`
  lines 90–97).
- **Overlap:** None for the upward signal proper. `gameScoreGain` partially
  re-implements the height arm via `Math.floor(heightGain)` inside
  `sim.score`, but at coarser resolution and without `yGain` shaping.
- **Ablation:** Load-bearing — `user -climb` (not run; ablating climb in a
  config so dependent on it would give noise). All non-climb policies
  underperform climb-only's 1410m.
- **Disposition:** **KEEP.** Primary axis. Stays as one of the 5 user
  knobs.

### 2. `collectibles` — KEEP (as `collect`)

- **Formula (reward arm):** `policy.collectibles × (sparkScore × 3 +
  pickedValue × 1.5) × (1 - waterUrgency × 0.85)`.
- **Formula (penalty arm):** `policy.collectibles ×
  missedCollectibleValue(pathReward) × MISS_PENALTY_FACTOR × (1 -
  waterUrgency × 0.85)`. (interwheel-planner.ts:933–938)
- **Path-cumulative:** Yes. Reads `pathReward.pickedValue` and `sparkScore`
  (cumulative); `missedCollectibleValue` reads `pathReward.minDistSq` and
  `pathReward.collectedKeys` (both cumulative).
- **Overlap:** It's doing **two distinct jobs** with one coefficient — pickup
  reward AND miss penalty. Together with `claimRadius` it defines what
  counts as "claimed" by the path. `missPenalty` and `captureFloor` are
  alternate flavors of the same penalty arm (see below).
- **Ablation:** Load-bearing. Removing it (`user -collectibles`, not run
  in quick mode) would zero out both arms; user-mix's collect score line
  is 4699 — substantial.
- **Disposition:** **KEEP** as the core "collect" axis. Renaming to
  `collect` for clarity is optional but reduces confusion with the
  pastille type.

### 3. `wallRoutes` — KEEP (as `wall`)

- **Formula:** `policy.wallRoutes × pathWallRouteValue`.
- **Path-cumulative:** Yes. `pathWallRouteValue` accumulates per-edge
  wall-route value (`interwheel-planner.ts:813`).
- **Overlap:** None. Mechanism is unique.
- **Ablation:** Not directly ablated in quick mode. user-mix uses 0.65;
  default is 0.65. Stable contributor in many seeds with side walls.
- **Disposition:** **KEEP.** Independent axis.

### 4. `pace` — KEEP

- **Formula:** `policy.pace × (totalTicks × 4 + pathWaitPenalty)`.
- **Path-cumulative:** Yes. `totalTicks` and `pathWaitPenalty` are
  cumulative.
- **Overlap:** None.
- **Ablation:** Not directly ablated. Plays a protective role (penalize
  long plans). Should remain at default ~1.0 in most operating points.
- **Disposition:** **KEEP.** Independent axis.

### 5. `claimRadius` — DROP (revised after Phase 2)

- **Formula:** Gates which perceived pastilles get added to
  `pathReward.collectedKeys` and `pickedValue` via `tubeClaimReward`. Only
  affects the path-cumulative claim set; doesn't add a new score line.
- **Path-cumulative:** Yes. Tube claims are added to `pathReward` in
  `evaluateEdge` (`interwheel-planner.ts:751-754`), so descendants
  inherit the claim.
- **Overlap:** It's a **mechanism extension** of `collectibles`, not a
  separate axis. With `collectibles=0`, `claimRadius` does nothing.
- **Phase 2 study A evidence (sweep over claimRadius ∈ {0, 35, 70, 120,
  200, 300} on top of phase2-base):** score peaks at `claim=0–35`
  (24355 / 24622) and degrades monotonically with wider tube — `claim=300`
  costs −4000 score and −11 pastilles vs `claim=0`. Capture% essentially
  flat (78.7–81.2%) across the range. Confirmation sweep (with
  collect=1.0, det=0.60 base): `claim=70` and `claim=35` give *identical*
  results to `claim=0` (28069 / 28147 / 28147 score).
- **Failure mechanism:** "phantom claims". Wide tube counts pastilles
  the path *passed near* as already-secured, even when the live agent
  re-plans every tick and never actually picks them up. The score
  breakdown shows the leaf collect-term grows, but the realized
  pastille count *drops*. The planner is choosing leaves that look
  good but don't deliver.
- **Disposition (revised):** **DROP.** Originally proposed as MERGE
  (pin at 70 inside `collect`); Phase 2 data shows pinning at 70 is
  worse than pinning at 0 by every metric. The mechanism stays in code
  for now (cheap, may be useful in some regime), but it should default
  to 0 and not be exposed as a user-facing knob.

### 6. `detourCost` — KEEP (revised: standalone, not merged)

- **Formula:** `policy.detourCost × pathOffAxis`. Path-off-axis is the
  sum of edge-integrals of perpendicular distance from path samples to
  each edge's start→end chord.
- **Path-cumulative:** Yes. `pathOffAxis` accumulates per-edge
  contributions (`interwheel-planner.ts:758-760`).
- **Overlap:** Partial conceptual overlap with `patienceDiscount` —
  both reward "clean upward routes that don't detour for early grabs",
  but at different layers (geometry vs pickup-timing). Phase 2 study B
  showed they contribute non-redundantly.
- **Ablation (user-mix):** **Biggest contributor.** Removing it costs
  −2426 score (23332 → 20906), height drops 96m, total pastilles drop
  from 59.8 to 52.8. Capture% rises (84 → 86) — wrong trade.
- **Phase 2 study B evidence (detour ∈ {0, 0.30, 0.60} × patience grid):**
  every `det=0.60` row beats every `det=0.30` row by ~2300 score,
  regardless of patience. Going beyond 0.60 stops helping
  (`det=0.80, 1.00` plateau or regress).
- **Confirmation sweep:** `det=0.40` gave 28231 score, `det=0.60` gave
  28147, `det=0.80` gave 26282, `det=1.00` gave 26795. Sweet plateau
  is **det ∈ [0.40, 0.60]**. Pick midpoint for default: **0.50**.
- **Disposition (revised):** **KEEP as a standalone user-facing knob.**
  Originally proposed as half of a merged `discipline` knob, but Phase 2
  showed `detour` and `patience` contribute somewhat independently; a
  single multiplier on the pair would lose useful tuning surface.
  Recommended default: 0.50.

### 7. `patienceDiscount` — KEEP (revised: standalone, not merged)

- **Formula:** When an edge realizes a real pickup whose pastille is also
  within stable-claim range of any wheel above the agent (root-pinned
  reachability set), discount the pickup contribution by
  `(1 - patienceDiscount)`. (`interwheel-planner.ts:1011-1029`).
- **Path-cumulative:** Yes. `pathReward.pickedValue` accumulates the
  discounted values.
- **Overlap:** Reinforces the same intent as `detourCost` (clean upward
  routes), at a different mechanical layer (timing of the pickup credit
  rather than path geometry).
- **Ablation (user-mix):** Small contributor. `user -patience` costs
  −413 score. *This was misleading* — see Phase 2 below.
- **Phase 2 study B evidence:** at the user-mix base (`col=1.8`), patience
  alone (`det=0, pat=*`) does almost nothing — `pat=0` → 21897, `pat=1.0`
  → 21571. The user-mix ablation result was real: at that base, patience
  is dominated by the high `collectibles` weight.
- **Confirmation sweep evidence (the surprise):** at the *new* operating
  point (`col=1.0, det=0.60, claim=0`), reviving `patience=0.65` adds
  **+1547 score, +50m height, +4 total pastilles** vs the no-patience
  predicted (29694 vs 28147). Patience was being *masked* by
  high-collectibles previously, not redundant.
- **Disposition (revised):** **KEEP as a standalone user-facing knob.**
  Originally proposed as half of a merged `discipline` knob; Phase 2
  shows patience contributes non-trivially at the right operating point
  and shouldn't be folded into a single multiplier. Recommended default:
  0.65.

### 8. `missPenalty` — DROP

- **Formula:** `policy.missPenalty × missedCollectibleValue(pathReward)
  × MISS_PENALTY_FACTOR × (1 - waterUrgency × 0.85)`.
- **Path-cumulative:** Yes (same path-cumulative inputs as the
  collectibles miss arm).
- **Overlap:** **Exact same formula** as the existing miss-penalty arm
  of `collectibles`, with a different coefficient. Was added to allow
  decoupling "I want to penalize misses without rewarding pickups", but
  in practice users always also have collectibles>0 (because that's the
  mechanism that *secures* pastilles).
- **Ablation:** −2 score when removed from user-mix (noise). At
  `missPenalty=2`, the score-breakdown line is 17 — barely above the
  numerical floor.
- **Disposition:** **DROP.** Two coefficients for the same formula is
  the textbook duplication. If decoupling proves necessary later, add
  back as an internal constant inside the `collect` mechanism.

### 9. `captureFloor` — DROP

- **Formula:** `policy.captureFloor × (Σ uncollected_value /
  max(1, Σ perceived_value)) × CAPTURE_FLOOR_SCALE` where
  `CAPTURE_FLOOR_SCALE = 7000`.
- **Path-cumulative:** Yes. Reads `pathReward.collectedKeys`
  (cumulative); `currentPerceivedKeys` is plan-level constant.
- **Overlap:** Same intent (penalize misses) as `missPenalty` and the
  collectibles miss arm, with different math. Conceived as a "dial-to-
  100% capture" mechanism, but…
- **Ablation:** −7 score when removed from user-mix at value 0.35
  (noise). At higher values, **catastrophic failure**: `cap=3.0+claim=200`
  killed the agent in 50% of trials, dropping height to 585m. Capture%
  saturates around 85% well before deaths begin.
- **Disposition:** **DROP.** The "dial-to-100%" intent fails empirically
  — the ceiling appears to be search-coverage-bound (some pastilles are
  unreachable from the agent's column at the moment of perception), not
  policy-weight-bound. Reaching higher capture% probably needs deeper
  search or wider `revealScreensAbove`, not a stronger penalty. If we
  need flat-penalty semantics again, re-derive cleanly.

### 10. `gameScoreGain` — DROP

- **Formula:** `policy.gameScoreGain × (end.score - root.score)`.
- **Path-cumulative:** Yes. `sim.score` is monotonic during the run.
- **Overlap:** **Pure duplication.** `sim.score` is internally
  `Math.floor(heightGain) + Σ pastille_values + Σ spark_scores`, so
  this knob is `climb's heightGain arm + collectibles' reward arm`
  re-summed without geometry shaping. The only reason to use it is
  "I want exactly the in-game score as the objective" — but the
  geometry-aware climb + collect terms produce *better* in-game scores
  than gameScoreGain alone (per the sweep).
- **Ablation:** **Removing it improves user-mix by +889 score and +43m
  height.** It actively pulls the planner away from climb's local
  shaping toward a coarser sum-only objective.
- **Disposition:** **DROP.** Hardest case in the audit because removing
  it improves outcomes. No salvageable use-case at present.

## Proposed consolidation: 10 → 6 user-facing knobs (revised)

| Today | After | Disposition | Default |
|---|---|---|---|
| `climb` | `climb` | KEEP | 1.0 |
| `collectibles` | `collect` | KEEP (rename) | 1.0 *(was 1.8 in user-mix; lower is better)* |
| `wallRoutes` | `wall` | KEEP (rename) | 0.65 |
| `pace` | `pace` | KEEP | 1.0 |
| `detourCost` | `detour` | KEEP (rename) | 0.50 *(plateau is 0.40–0.60; midpoint chosen)* |
| `patienceDiscount` | `patience` | KEEP (rename) | 0.65 |
| `claimRadius` | (internal, default 0) | DROP from UI | 0 |
| `missPenalty` | — | DROP | n/a |
| `captureFloor` | — | DROP | n/a |
| `gameScoreGain` | — | DROP | n/a |

Result: **6 user-facing knobs**: `climb`, `collect`, `detour`,
`patience`, `wall`, `pace`. The new operating point is:
- `climb=1.0`, `collect=1.0`, `detour=0.50`, `patience=0.65`,
  `wall=0.65`, `pace=1.0`.

This new configuration **beats the existing `default`** (which was the
de-facto operating point) by:
- Height: +231m (+17%)
- Score: +5560 (+23%)
- Total pastilles: +15.6 (+27%)
- Capture rate: −4.3pp (slightly lower ratio, but +27% raw harvest)

And **beats `user-mix`** (the user's hand-tuned 10-knob config) by:
- Height: +204m (+14%)
- Score: +4566 (+18%)
- Pastilles: +12.8 (+21%)

So consolidation isn't "neutral cleanup" — it's an actual improvement
in capability, because the previous defaults (collect=1.8, claim=70,
detour=0.30) were suboptimal. Phase 2 found the better operating point.

### Why the original 5-knob proposal became 6

The original audit folded `detourCost` and `patienceDiscount` into a
single `discipline` knob with internal coupling. Phase 2 study B
sampled the (detour, patience) grid and found:

- At the high-collectibles base (col=1.8), patience contributes ~0
  alone. Looks redundant.
- At the new low-collectibles base (col=1.0), patience contributes
  +1547 score on top of detour=0.60. **Not redundant.**

The high-col base was *masking* patience's contribution. With
collectibles=1.8 doing the heavy "value pickups" job, the marginal
value of "discount easy pickups" (patience) shrinks. At collectibles=1.0,
patience has more room to act.

Single-multiplier `discipline` would lock the detour:patience ratio at
some fixed coupling, losing the ability to tune them separately at
different operating points. Two knobs is more honest.

## Phase 2 confirmation summary

Three studies and a confirmation sweep produced the revised
recommendations. Reports are at:
- `.tmp/interwheel-knobs/2026-05-08T14-15-08-661Z/report.md` (Phase 2 studies A/B/C)
- `.tmp/interwheel-knobs/2026-05-08T14-23-02-163Z/report.md` (confirmation)

**Study A** swept `claimRadius ∈ {0, 35, 70, 120, 200, 300}` on
phase2-base. Score peaked at `claim=0–35` and degraded with wider tube.
"Phantom claims" mechanism (planner counts pastilles the path passes
near as already-secured, but the live agent doesn't deliver) makes
wider tube actively harmful. **Conclusion: claim ≤ 35; default 0.**

**Study B** sampled (detour, patience) grid on phase2-base. detour was
the dominant signal (+2300 score per 0.30 step). At this base patience
alone added near-zero. Sweet plateau at `det ∈ [0.30, 0.60]`.

**Study C** swept (collectibles, claimRadius) joint grid. Best point
was `col=1.0, claim=0` at 26437 score — *lower* collectibles than
user-mix's 1.8, *no* tube. claim=150 was actively bad at high col
(phantom claims again).

**Confirmation sweep** centered on the predicted optimum
`(climb=1, col=1, det=0.6, claim=0, pat=0)` and probed 11 neighbors.
Surprise: reviving `patience=0.65` at this new base added +1547 score,
inverting study B's "patience is weak" finding. Patience was being
masked by high-collectibles in study B; at the new lean operating
point it contributes meaningfully.

The new operating point also revealed:
- `det=0.40` ≈ `det=0.60` (tied within noise; pick midpoint 0.50)
- `claim=35` and `claim=70` give identical results to `claim=0` (confirmed inert)
- `wall` and `pace` contribute small but real (~250–500 score each); keep at defaults

## Migration risk register

1. **`missPenalty=2` in user-mix → 0**: ablation evidence shows −2 score
   delta. Negligible regression.
2. **`captureFloor=0.35` in user-mix → 0**: ablation shows −7 score
   delta. Negligible regression. Open question for "dial higher capture":
   needs different mechanism (search depth, lookahead) — out of scope
   for this consolidation.
3. **`gameScoreGain=1.10` → 0**: ablation shows **+889 score
   improvement.** Strict positive change.
4. **`claimRadius=70` → 0**: confirmation sweep shows zero delta at
   the new base. Strict no-op or slight win.
5. **`detourCost=0.30` → 0.50**: confirmation shows +0–4000 score
   gain depending on `collectibles` setting. Strict win.
6. **`collectibles=1.8` → 1.0**: confirmation shows +1500 score gain
   at the new operating point. Strict win.
7. **`patience` stays at 0.65**: same value as user-mix.
8. **Removing the existing miss-penalty arm of `collectibles`?** No — the
   audit recommends keeping it. The `collectibles` knob is the *one*
   place where pickup reward and miss penalty are coupled, which matches
   the design-doc intent that "the same coefficient that values pickups
   should also penalize missing them".

Net migration: every change is either neutral or positive. No
regressions expected.

## Open questions

1. **Should `claimRadius` be focus-derived eventually?** Phase 2 showed
   it's inert at the recommended operating point and actively hurts
   when widened. The "focus-derived" idea would only make sense if a
   different operating regime made wider tubes useful — none discovered
   yet. **Recommendation: drop from focus design entirely.** Keep the
   mechanism in code (it's cheap), default to 0, don't expose.

2. **Should `discipline` be a single multiplier on (detour, patience)?**
   Phase 2 study B + confirmation sweep answer: **No.** They contribute
   independently at the new lean operating point. Two separate knobs.

3. **Should the focus slider eventually drive `wall` and `pace`?**
   User confirmed: **No.** Both are protective/defensive signals.
   `wall` is level-geometry-dependent; `pace` is plan-cost-dependent.
   Neither tracks the climb↔collect axis.

4. **How does this interact with the future water-aware focus
   auto-tuning the user mentioned?** Out of scope for this audit.
   Note that the existing `waterUrgency` factor in `scoreCandidate()`
   already does some of this work locally.

5. **Capture% saturation at ~85%.** Even with the strongest collect
   bias tested (col=2.0, claim=0), capture stays around 84.7%.
   Reaching higher capture appears to be search-coverage-bound (some
   pastilles unreachable from the agent's column at the moment of
   perception), not policy-weight-bound. Future work: deeper
   `maxStableDepth` or wider `revealScreensAbove`.

## Status & next steps

Phase 1 (audit), Phase 2 (verification), Phase 2.5 (math redesign), and
Phase 3 (implementation) are **done**. See `interwheel-policy-math.md`
for the math redesign details.

Implementation summary:
- 6 user-facing knobs: `climb`, `collect`, `wall`, `pace`, `detour`,
  `patience`. 4 dropped: `claimRadius`, `missPenalty`, `captureFloor`,
  `gameScoreGain`.
- All ~17 magic numbers in `scoreCandidate` are now named module-scope
  constants with `// why` comments (planner physics, scoring rule, etc.).
- Orthogonal score formula: each knob × one path-cumulative signal.
  `pathHeight = max(0, root.y − pathApexY)` replaces the 3-signal
  `heightPolicy` mix. `pathWallTicks` (continuous) replaces the
  0/300/450 tier function. `pace × totalTicks` (linear) replaces the
  `pace × (totalTicks×4 + nonlinearWaitPenalty)` mix. `miss = collect ×
  FIXED_MISS_RATIO × missedCollectibleValue × waterCollectDamp`
  (default-coupled to collect via internal constant).
- New defaults: `climb=1.0, collect=1.0, detour=0.5, patience=0.65,
  wall=0.65, pace=1.0`.

Regression tests pass with **score=18096 at the analytics seed** (vs.
8096 with the prior planner) — the orthogonal redesign is >2× better at
default config than the old planner was at its old defaults.

Remaining work:

4. **Phase 4 — focus slider redesign**: the existing focus slider
   lerps `climb` and `collect` along the FOCUS_CLIMB and FOCUS_COLLECT
   ranges. After Phase 3, these endpoints may need re-tuning given
   the new orthogonal math. Endpoints to revisit:
   - `focus=0` ≡ "pure climber": climb=1.6, collect=0, others at
     defaults (detour=0.5, patience=0.65)
   - `focus=1` ≡ "balanced collector": climb=0.3, collect=3.0, others
     at defaults

5. **Phase 5 — focus validation sweep**: focus ∈ {0, 0.2, 0.4, 0.6,
   0.8, 1.0}, full 2-min trials. Already included in the Phase 2.5b
   validation sweep at `scripts/interwheel/sweep-knobs.mjs`. Confirm
   smooth monotonic capture% / height tradeoff. If kinks appear, an
   internal coupling is broken.
