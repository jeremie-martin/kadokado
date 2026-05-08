# Interwheel Collectibles Objective

This is a design/debug brief for the Interwheel A* planner's collectible
objective. It captures the intended behavior, the current failure mode, and
the repro/test loop. It is intentionally separate from
`interwheel-ai-overlay.md`, which is the cleaner reference for the overlay and
planner controls.

Status note: this brief describes the collectible-objective problem and some
historical experiments. The current planner contract is summarized in
`docs/interwheel-planner-spec.md`: the live pickup knob is `thoroughness`, and
it counts physical simulator pickup events in a path-cumulative
`CollectReward`. Stable-surface orbit claims are not active in the current
planner.

## Goal

The `collectibles` policy should make the agent choose paths that secure
pastilles and sparks while still following a natural route through the level.
It must not mean "grab the visible collectible as soon as possible".

The important case is when two routes can secure the same collectible set:

- one route spends an extra jump to bank a pastille immediately;
- another route reaches a useful wheel/wall first and naturally collects the
  same pastille shortly after.

The second route should usually win, because the collectible outcome is the
same and the route is cleaner, higher, faster, or otherwise better according to
the other path-level terms.

## Core Principle

Planner objectives should value path outcomes, not isolated edges.

For collectibles this means:

1. Each simulated edge records collectible facts.
2. Each node carries a cumulative path collectible state.
3. `scoreCandidate()` reads the cumulative path state.
4. A valuable leaf/frontier makes its ancestor route valuable.

This is the same family of principle as the climb/leaf backtracking behavior:
the path is what matters. A local edge that looks attractive only because it
grabs something earlier should not dominate if the full path outcome is worse.

## Current Implementation Shape

Relevant files:

- `src/playground/interwheel-planner.ts`
- `src/playground/ai-interwheel.ts`
- `playground.html`
- `docs/interwheel-ai-overlay.md`

Current planner concepts:

- `CollectReward` stores pastille value, spark score, collected keys, and
  minimum distance to perceived pastilles.
- `SearchNode.pathReward` is the cumulative root-to-node collectible state.
- `SearchEdge.reward` is the edge-local realized pickup facts.
- `scoreCandidate()` uses cumulative `pathReward` for:
  - `collectibles`
  - `missedCollect`
- Wall routes and pace are also path accumulators.

The problematic detail is the definition of "collected" or "secured". So far,
the planner has mostly counted realized simulator pickup events. That makes
pickup timing leak into the objective: a detour that physically touches a
pastille now can beat a cleaner route that would naturally collect it from a
stable surface a moment later.

## Seed 8 Failure

Manual repro:

1. Start the playground:

   ```sh
   npm run dev -- --host 127.0.0.1
   ```

2. Open:

   ```text
   http://127.0.0.1:5173/playground.html?seed=8
   ```

   If port `5173` is occupied, Vite will print the actual port.

3. Use these planner settings:

   ```text
   Climb:        0.30
   Collectibles: 1.00
   Wall routes:  0.65
   Pace:         1.00
   Lookahead:    0.50
   Search jumps: 4
   Edge budget:  360
   CPU budget:   5ms
   ```

4. Enable `Highlight chosen chain (debug)`.

5. Watch the area around roughly `248m` to `255m`.

Observed bad behavior:

- The agent is on the lower-left wheel.
- A green pastille near that wheel is naturally collectible by staying on the
  wheel.
- A blue pastille is above/left.
- A green pastille is to the right.
- A larger wheel is above/right.
- With collectible pressure, the chosen chain jumps up/left to bank the blue
  first, then lands back on the same wheel or routes through the side wall,
  then continues.

Expected behavior:

- The agent should not prioritize the blue solely because it can be touched
  immediately.
- It should be allowed to wait/rotate for the nearby green, jump toward the
  right-side green / upper route, and collect the blue later if the upper wheel
  or route naturally owns it.
- If both paths secure the same pastilles, the cleaner upward route should win.

Important testing note: do not use `climb=3` as the main collectible test. That
can hide the collectible objective problem by letting climb dominate. The
useful repro is `collectibles=1.0`, `climb=0.3`.

## What Has Been Tried

These approaches were explored and are not sufficient by themselves.

### Upward Carry Inside Collectibles

Idea: add a small capped upward bonus to the collectible path score.

Problem: this still lets "bank the collectible now" dominate. It changes the
score magnitude but does not fix the definition of what collectible outcome the
path has achieved.

### Passive Preview In `scoreCandidate()`

Idea: when scoring a stable leaf, simulate passive waiting on that surface and
count nearby natural pickups for that score.

Problem: this is score-only unless it is written into the node accumulator.
Descendants do not inherit the claim, so it violates the accumulator model in
practice.

### Stable-Surface Claims

Idea: when a path reaches a stable wheel, claim pastilles naturally owned by
that wheel's orbit and store that in `pathReward`.

This is closer to the desired model because descendants inherit the claim. It
also matches the intuition that reaching the wheel is enough to secure a
pastille the wheel will naturally rotate through.

Open issue: the seed 8 failure can still appear when the detour physically
collects the blue during the flight and lands on a different stable state, such
as a wall. So stable-surface claims alone do not fully define which pickups are
part of the route versus side scoops.

### Same-Stable Scoop Suppression

Idea: if an edge launches away and lands back on the same stable target, do not
let transient pickups from that edge enter `pathReward`.

This addresses the obvious "jump out and fall back to the same wheel" case, but
not the variant where the detour banks the collectible and lands on a different
stable state. Seed 8 can still show a bad left-wall route.

## Likely Root Issue

The planner still conflates two concepts:

- physically touched during this simulated edge;
- secured by the chosen route.

For collectible planning, "secured by the route" is the better objective. A
pickup should not automatically become a high-value path claim just because a
flight touched it early. The claim should be tied to the route's stable
progression and frontier outcome.

The core design question is therefore:

> What exactly makes a pastille part of a path's collectible outcome?

Candidates:

- Actual pickup events during normal progression should count.
- Pastilles naturally owned by reached stable wheels should count.
- Flight pickups that require a side excursion may need a stricter rule before
  becoming path claims.
- A route that only improves pickup timing, without improving the final claimed
  collectible set or route state, should not gain collectible value.

## Non-Goals

Avoid these unless we deliberately decide otherwise:

- A generic path-dominance/tiebreaker layer outside the objective.
- A large local edge penalty for one specific screenshot.
- A collectible score that secretly becomes another climb knob.
- Extra default UI controls for temporary tuning.
- Debug-only behavior that changes the planner objective.

## Testing Checklist

Run basic verification:

```sh
npm run build
npx playwright test tests/e2e/playground.spec.ts tests/e2e/analyze-interwheel.spec.ts
git diff --check
```

Manual seed 8 check:

- Open `playground.html?seed=8`.
- Set `collectibles=1.0`, `climb=0.3`.
- Enable chosen-chain highlighting.
- Observe around `248m` to `255m`.
- Failure: first chosen route banks the blue with a left/up detour before the
  cleaner route can own it naturally.
- Success: the chosen route does not spend a launch just to bank the blue early
  when the sane upward route can secure the same collectible outcome.

Useful browser console probes:

```js
window.__planner__.lastStats()?.bestScoreBreakdown
```

```js
window.__planner__.lastSegments()
  .filter((s) => s.onChosenChain)
  .map((s) => ({
    edgeId: s.edgeId,
    generation: s.generation,
    x0: Math.round(s.x0),
    y0: Math.round(s.y0),
    x1: Math.round(s.x1),
    y1: Math.round(s.y1),
  }))
```

When investigating a candidate fix, answer two questions separately:

1. Is the sane route present in the search tree?
2. If present, does it lose because the collectible score prefers earlier
   pickup timing?

Those require different fixes: search coverage versus objective definition.
