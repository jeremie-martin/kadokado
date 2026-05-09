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
- High priority: reduce perception discontinuities in the planner. Seed 10
  shows that while rotating on a wheel, a newly revealed wheel can abruptly
  change the chosen route and predicted launch tick. Study approaches such as
  freezing the perceived wheel set while attached, revealing farther only on
  stable landings, or adding explicit hysteresis for newly revealed routes.
- Redesign the pastille objective later under a better name than
  `thoroughness`. The target behavior is capture-priority: when a pastille is
  perceived, bias toward not leaving it behind, even if height suffers. Treat
  perceived pastilles as obligations and validate capture% over perceived
  obligations, with collected count, perceived count, height, run speed, and
  deaths as tradeoff diagnostics.
- Reintroduce a focus-style control only after the capture objective exists. It
  should tune capture targeting, not lerp climb against the removed
  `thoroughness` metric.
