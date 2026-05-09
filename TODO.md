# TODO

## Interwheel Planner

- Continue using policy studies as the first-class foundation before designing
  new capture metrics. The study tool supports policy coefficient sweeps,
  metric-parameter sweeps, focused parameter ranges, and repeated fixed-config
  comparisons.
- Improve every non-climb metric's responsiveness when mixed with climb. A
  metric's policy coefficient should produce a smooth, predictable, ideally
  near-linear behavior curve over its useful range. Study reports should make
  that response curve explicit instead of only ranking final outcomes.
- Revalidate the climb efficiency metric after major planner/search changes.
  The current default is `climbMode=time-cost`, `climbTickCost=3`, selected
  from standard and overnight climb-only studies because it improved run speed
  substantially without the low-tail outliers seen at higher time costs.
- Continue reducing perception discontinuities. The post-landing camera lerp
  re-ranks the chosen edge mid-rotation as wheels drip into knownWheelIdx and
  the planning band shifts. The previous attempt that froze reveal entirely
  while attached (commit 892f29e) regressed lookahead=0 — knownWheelIdx never
  grew between flights — and was reverted. Residual ~20 stable-mode wobbles
  per 600 ticks beyond the perception cause: 1-tick launch-tick wobble from
  the discrete root wait step plus search-budget timing noise, and rare
  target-wheel flips when two edges score within rounding (e.g. seed 10
  tick 223, w18↔w17). Open ideas: anchor the planner's effective mapY to a
  stable reference (FLY→attached transition, or a wheel-anchored focus) so
  the planning band and reveal range stop shifting during the lerp;
  hysteresis on chosen-edge identity.
- Redesign the pastille objective later under a better name than
  `thoroughness`. The target behavior is capture-priority: when a pastille is
  perceived, bias toward not leaving it behind, even if height suffers. Treat
  perceived pastilles as obligations and validate capture% over perceived
  obligations, with collected count, perceived count, height, run speed, and
  deaths as tradeoff diagnostics.
- Reintroduce a focus-style control only after the capture objective exists. It
  should tune capture targeting, not lerp climb against the removed
  `thoroughness` metric.
