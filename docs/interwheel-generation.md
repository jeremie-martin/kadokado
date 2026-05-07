# Interwheel Generation Notes

## Empirical Climb Checks

Current experimental command:

```sh
npm run analyze:interwheel:climb -- --seed=42 --max-seconds=300
```

This is intentionally offline tooling. It runs one deterministic seed through
the trusted pure simulator with a climb-biased agent and reports whether the
agent survived to the time cap with recent upward progress. Live generation
should not call this validator directly.

This empirical check is not a proof of reachability. It is a fast way to detect
obviously bad seeds or generator changes before we scale up to larger seed
populations.

## Analytical Reachability

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

Once the analytical validator identifies reliable failure modes, generation can
retry local choices, reduce mine count, move mine angles, insert an alternate
wheel, or regenerate a small band instead of accepting impossible sections.

## Difficulty

Future work: expose a continuous generation difficulty value and characterize it
empirically. One promising measurement is to run intentionally imperfect agents
over fixed seed populations: delayed jumps, noisy timing, reduced search depth,
or limited reaction windows. The distribution of failure heights would give a
practical measure of whether generated difficulty actually ramps as intended.
