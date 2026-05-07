# Interwheel Generation Notes

## Empirical Climb Checks

Current experimental command:

```sh
npm run analyze:interwheel:climb -- --seed=42 --max-seconds=300
npm run analyze:interwheel:climb -- --seed=42 --max-seconds=300 --no-water --min-height=5000
```

This is intentionally offline tooling. It runs one deterministic seed through
the trusted pure simulator with a climb-biased agent and reports whether the
agent survived to the time cap with recent upward progress. Live generation
should not call this validator directly.

The `--no-water` mode temporarily disables drowning in the pure simulator. Use
it only for route-only calibration against the analytical edge validator. In
that mode, the pass criterion is target height rather than recent progress; it
is not a gameplay mode.

This empirical check is not a proof of reachability. It is a fast way to detect
obviously bad seeds or generator changes before we scale up to larger seed
populations.

## Analytical Reachability

Current experimental command:

```sh
npm run analyze:interwheel:edges -- --seed=42 --max-height=4000
```

Current wheel generation is finite and mostly geometric. It spaces wheels and
mines, but it does not prove that the climb remains possible once mine arcs,
wheel rotation, wall routes, and timing are considered.

The next serious validator should be analytical and local rather than a second
full search agent. It should answer whether the generated local graph contains
at least one safe upward route. Individual wheels may be unreachable; the
important invariant is that a reachable frontier can keep advancing.

Promising shape:

- Treat wheels and walls as anchors in a reachability graph.
- Derive or cheaply sample feasible launch windows from each anchor to nearby
  higher anchors.
- Model mine arcs as forbidden landing-angle intervals on the target wheel.
- Keep wall contacts as alternate anchors, because valid routes may be
  wheel-to-wall-to-wheel.
- Advance by bands of height, not by requiring every generated wheel to be
  reachable.
- Report failed bands with the blocking wheel/mine layout and candidate route
  traces so generator changes can be debugged.

The current implementation is deliberately approximate: it samples local jump
trajectories from wheel anchors, treats mines as forbidden landing-angle arcs,
and includes wall-assisted wheel-to-wall-to-wheel edges. It does not mutate
generation and should be calibrated against empirical climb-agent runs before
we trust its pass/fail signal.

Once the analytical validator identifies reliable failure modes, generation can
retry local choices, reduce mine count, move mine angles, insert an alternate
wheel, or regenerate a small band instead of accepting impossible sections.

## Current Generation Repair

The first generation repair is intentionally small: mine placement now checks
the wheel perimeter density after adding the next mine. Previously, `addMine`
could add one mine too many, producing wheels whose mine danger intervals could
cover every practical landing phase.

Calibration on seeds `42..51`:

- Before the repair, the analytical edge validator failed several seeds before
  `5000m`.
- Ignoring mines made all of those seeds analytically reachable, pointing to
  mine placement rather than geometry.
- After the density fix, the analytical validator reaches at least `5000m` for
  all seeds `42..51`.
- Seed `42` no-water empirical climb now reaches `5946m`, where it previously
  stalled below `5000m`.

## Difficulty

Future work: expose a continuous generation difficulty value and characterize it
empirically. One promising measurement is to run intentionally imperfect agents
over fixed seed populations: delayed jumps, noisy timing, reduced search depth,
or limited reaction windows. The distribution of failure heights would give a
practical measure of whether generated difficulty actually ramps as intended.
