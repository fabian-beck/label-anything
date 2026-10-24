# Concepts

One problem goes in, one result comes out:

```text
result = place(problem)        problem.v1.json  →  result.v1.json
report = validate(problem)     { valid, errors[], warnings[] }
```

| Page | |
|---|---|
| [The problem format](problem.md) | every section of a problem, with examples |
| [The result format](result.md) | placements, explanations, statistics |
| [Avoidance classes and policy](avoidance.md) | obstacle classes; hard, soft and ignore; the four `avoid` maps |
| [Candidates and the degradation ladder](candidates.md) | candidate models, the cost model, what happens when nothing fits |
| [Presets and defaults](presets-defaults.md) | how options merge; what each preset does |
| [The solver](solver.md) | how it chooses, strategies, the iteration budget, reproducibility, cancellation |
| [The debug overlay](debug-overlay.md) | seeing what the engine saw |
| [Errors and validation](errors.md) | issues, codes, where errors surface per binding |

## How a solve works

Every implementation runs the same steps:

1. **Validate** the problem completely ([errors](errors.md)).
2. **Merge options**: defaults ← preset ← problem ([presets and defaults](presets-defaults.md)).
3. **Prepare obstacles**: vector layers, SVG and raster backgrounds become classed geometry
   and coverage grids ([avoidance](avoidance.md)).
4. **Measure labels** and build their variants (wrapped, alternative, truncated, shrunk).
5. **Generate candidates** per item: adjacent, slider, internal, distant, boundary
   ([candidates](candidates.md)).
6. **Choose**: a greedy pass in priority order with the degradation ladder, local search,
   and an exact search for small problems; then columns for crowds and repairs
   ([the solver](solver.md)).
7. **Verify** every hard constraint independently, and **report** the placements, the
   explanations and the statistics ([result](result.md)).

The [explainer](../try.md#how-it-works-step-by-step) replays these steps on a real solve,
decision by decision.

The normative definitions are in the [specification](../reference/spec.md); design
decisions and their reasons in the [architecture decision records](../project/decisions.md).
