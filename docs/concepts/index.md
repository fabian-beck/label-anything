# Concepts

One [problem](problem.md) goes in, one [result](result.md) comes out:

```text
result = place(problem)        problem.v1.json  →  result.v1.json
report = validate(problem)     { valid, errors[], warnings[] }
```

## How a solve works

Every implementation runs the same steps:

1. **Validate** the problem completely ([errors](errors.md)).
2. **Merge options**: defaults ← preset ← problem ([presets](../reference/presets.md)).
3. **Prepare obstacles**: vector layers, SVG and raster backgrounds become classed geometry
   and coverage grids ([avoidance](avoidance.md)), and the picture's regions a region map
   ([regions](regions.md)).
4. **Measure labels** and build their variants (wrapped, alternative, truncated, shrunk).
5. **Generate candidates** per item: adjacent, slider, internal, distant, boundary
   ([candidates](candidates.md)).
6. **Choose**: a greedy pass in priority order with the degradation ladder, local search,
   and an exact search for small problems; then columns for crowds and repairs
   ([the solver](solver.md)).
7. **Verify** every hard constraint independently, and **report** the placements, the
   explanations and the statistics ([result](result.md)).

The [explainer](https://fabian-beck.github.io/label-anything/playground/explain.html)
replays these steps on a real solve, decision by decision; the
[debug overlay](debug-overlay.md) shows what a solve of yours saw and did.

The normative definitions are in the [specification](../reference/spec.md); design
decisions and their reasons in the [architecture decision records](../project/decisions/index.md).
