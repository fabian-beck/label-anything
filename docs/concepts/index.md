# Concepts

One problem goes in, one result comes out:

```text
result = place(problem)        problem.v1.json  →  result.v1.json
report = validate(problem)     { valid, errors[], warnings[] }
```

Between the two, every implementation runs the same pipeline:

1. **Validate** the problem completely ([errors](errors.md)).
2. **Merge options**: defaults ← preset ← problem ([presets and defaults](presets-defaults.md)).
3. **Prepare obstacles**: vector layers, SVG and raster backgrounds become classed geometry
   and coverage grids ([avoidance](avoidance.md)), and the picture's regions a region map
   ([regions](regions.md)).
4. **Measure labels** and build their variants (wrapped, alternative, truncated, shrunk).
5. **Generate candidates** per item: adjacent, slider, internal, distant, boundary
   ([candidates](candidates.md)).
6. **Choose**: a greedy pass in priority order with the degradation ladder, local search,
   and an exact search for small problems ([solver](solver.md)).
7. **Verify** every hard constraint independently, and **report** the placements, the
   explanations and the statistics ([result](result.md)).

| Page | |
|---|---|
| [The problem format](problem.md) | every section of a problem, with examples |
| [The result format](result.md) | placements, explanations, statistics |
| [Avoidance classes and policy](avoidance.md) | obstacle classes; hard, soft and ignore; the four `avoid` maps |
| [Regions](regions.md) | the parts of a picture a label belongs to: countries, bars, compartments |
| [Candidates and the degradation ladder](candidates.md) | candidate models, the cost model, what happens when nothing fits |
| [Presets and defaults](presets-defaults.md) | how options merge; what each preset does |
| [Time budget, determinism and cancellation](solver.md) | strategies, the iteration budget, reproducibility |
| [The debug overlay](debug-overlay.md) | seeing what the engine saw |
| [Errors and validation](errors.md) | issues, codes, where errors surface per binding |

The normative definitions are in the [specification](../reference/spec.md); design
decisions and their reasons in the [architecture decision records](../project/decisions.md).
