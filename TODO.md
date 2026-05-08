# TODO

## Interwheel Planner

- After the overnight policy study, investigate folding an "as fast as possible"
  component into the climb objective. The likely target is a climb-rate signal
  such as height gained per path time, or a normalized path-height reward that
  already accounts for elapsed ticks. If this works, the standalone `pace`
  penalty may become redundant or need to be redefined.
- After the overnight policy study, revisit the pastille objective definition.
  Current `thoroughness` only rewards physical pickup events inside the
  simulated path. Consider a separate path-level input that measures whether a
  route is getting closer to a pastille, moving onto a plausible pickup route,
  or otherwise making a pastille likely to be collected later. Validate this
  against capture% before merging it into the score.
