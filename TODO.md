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
- Continue reducing perception discontinuities. Reveal is now frozen while
  attached so the post-landing camera settle no longer drips new wheels into
  the search mid-rotation (seed 10, climb=1, wall=0: 13 perception-driven
  flips → 0). Residual ~20 stable-mode wobbles per 600 ticks remain, all with
  `perceivedDelta=0`: 1-tick launch-tick wobble from the discrete root wait
  step plus search-budget timing noise, and rare target-wheel flips when two
  edges score within rounding (e.g. seed 10 tick 223, w18↔w17). Open ideas:
  hysteresis on chosen-edge identity, and tightening the reveal trigger from
  "empty knownWheelIdx" to a discrete FLY→stable transition event.
- Redesign the pastille objective later under a better name than
  `thoroughness`. The target behavior is capture-priority: when a pastille is
  perceived, bias toward not leaving it behind, even if height suffers. Treat
  perceived pastilles as obligations and validate capture% over perceived
  obligations, with collected count, perceived count, height, run speed, and
  deaths as tradeoff diagnostics.
- Reintroduce a focus-style control only after the capture objective exists. It
  should tune capture targeting, not lerp climb against the removed
  `thoroughness` metric.
