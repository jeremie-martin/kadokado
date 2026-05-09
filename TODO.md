# TODO

## Interwheel Planner

- Redo policy studies as the first-class foundation before designing new
  climb-efficient or capture metrics. The study tool must support both policy
  coefficient sweeps and metric-parameter sweeps, for example sweeping
  `wallLandingBonus` / `wallTickBonus` independently from `policy.wall`.
- Improve every non-climb metric's responsiveness when mixed with climb. A
  metric's policy coefficient should produce a smooth, predictable, ideally
  near-linear behavior curve over its useful range. Study reports should make
  that response curve explicit instead of only ranking final outcomes.
- Study and redesign the climb objective as "climb high efficiently", not just
  "eventually reach a high apex". Candidate formulas include height per elapsed
  path time, height reward normalized by path ticks, and height reward minus a
  named internal time cost. Compare against the current `climb + wall` default
  using explicit run speed (`height / elapsed trial time`) across fixed trial
  durations.
- Redesign the pastille objective later under a better name than
  `thoroughness`. The target behavior is capture-priority: when a pastille is
  perceived, bias toward not leaving it behind, even if height suffers. Treat
  perceived pastilles as obligations and validate capture% over perceived
  obligations, with collected count, perceived count, height, run speed, and
  deaths as tradeoff diagnostics.
- Reintroduce a focus-style control only after the capture objective exists. It
  should tune capture targeting, not lerp climb against the removed
  `thoroughness` metric.
