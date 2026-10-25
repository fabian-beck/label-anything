# The solver

```json
{
  "solver": { "strategy": "auto", "time_budget_ms": 100, "max_iterations": 200000, "seed": 0, "grid_cell": "auto" }
}
```

## How it chooses

The solver picks one of each item's [candidates](candidates.md), or none, in phases:

1. **Greedy pass.** Items are placed in priority order, band by band; a band holds the
   items of equal priority, the most constrained first. Each item takes its cheapest free
   candidate, counting what that takes away from the items still waiting. After a band,
   its unlabeled items run the [degradation ladder](candidates.md#the-degradation-ladder).
2. **Local search** relocates, swaps and re-inserts labels, accepting only changes that
   keep every hard constraint and never make the priority outcome worse.
3. **Exact search**, for small problems with a large budget: a branch and bound that can
   prove the best placement.
4. **Columns and repairs.** Crowds with unlabeled items get
   [fan labels](candidates.md#fan-labels). With `strict` omission, a priority repair gives
   each omitted item a position that only less important labels hold, so no label is
   missing in favour of a less important one
   ([ADR priority/repair](../adr/priority/repair.md)).
5. **Verification** re-checks every hard constraint exactly.

The [explainer](https://fabian-beck.github.io/label-anything/playground/explain.html) steps through these phases on a real
solve; the [specification](../reference/spec.md#10-solver) defines them. `solver.strategy`
sets how far a solve goes:

* `greedy` — the greedy pass only.
* `local` — greedy, then local search.
* `exact` — local search, then the exact search
  ([ADR solver/search](../adr/solver/search.md)).
* `auto` (default) — `local`, or `exact` for problems with at most 3,000 candidates and a
  budget of at least 500 ms.

`stats.strategy_used` reports what ran.

## The time budget is an iteration budget

`time_budget_ms` (default **100 ms** in the Rust core and its bindings, **250 ms** in the
TypeScript engine) does not stop the search by the clock. It becomes a fixed number of
local-search moves:

> moves = min(`max_iterations`, `time_budget_ms` × rate, 400 × number of items)

with a rate of 100 moves per ms in Rust and 40 in TypeScript: 10,000 moves for both
defaults. The result therefore depends on the input and the seed, never on the machine's
speed or load ([ADR solver/time-budget](../adr/solver/time-budget.md)).

A wall-clock **guard** protects against very slow machines and very large problems. Local
search stops 3 × the budget after the solve started. The greedy pass stops running the
degradation ladder 10 × the budget after it started; items not reached by then get only
their best free normal position, in priority order, for up to another 10 × the budget, and
the rest are `budget_exhausted`. Either guard sets `stats.time_guard_hit`, the only case in
which results may depend on timing
([ADR solver/time-budget](../adr/solver/time-budget.md)).

For interactive use, lower the budget; for publication graphics, raise it, to 500 ms or
more to allow the exact search.

## Determinism

The same problem and `solver.seed` give the same result on every machine and in every
run. No decision depends on hash-map order, floating-point code uses only `+ − × ÷ √` and
a shared math library built from them, and random choices come from a PCG32 generator
seeded with `solver.seed` ([spec §10.4](../reference/spec.md#104-determinism)).

The TypeScript engine is a line-by-line port of the Rust core and makes the same decisions
for the same iteration counts; the conformance suite compares their results. Text widths of
the bundled font are identical in every implementation (simple shaping).

## Cancellation and progress

A host can stop a solve early:

| Binding | Cancel with | Progress |
|---|---|---|
| Python | `cancelled=` a `la.CancelToken`, a callable, a `threading.Event` (raises `la.Cancelled`) | `progress=(phase, fraction)` |
| JavaScript / WebAssembly | `signal` (an `AbortSignal`, or any object with `aborted`) | `progress` |

Once cancelled, the solver places no more items (they are `budget_exhausted`) and keeps
the best state it has; the result is still repaired and verified, with `stats.cancelled`
set. `place` is synchronous, so in JavaScript, cancel from a callback or solve in a worker
([Web Workers](../getting-started/javascript.md#web-workers)).

Progress is reported as `(phase, fraction)` when a phase starts (`greedy`, `local`,
`exact`), per greedy band and every 256 local-search moves.

## The grid

Soft costs are computed on coverage grids, one per obstacle class
([ADR obstacles/coverage-grids](../adr/obstacles/coverage-grids.md)). `grid_cell: "auto"`
is a quarter of the smallest font size, clamped to 1–4 px; larger cells are faster and
coarser. Hard tests against vector geometry do not use the grid: they are exact
([ADR obstacles/hard-constraints](../adr/obstacles/hard-constraints.md)).

## Performance

The [benchmark](../project/benchmark.md) checks the performance targets on every release,
for example 200 labels over 10,000 points in at most 15 ms (Rust), 30 ms (WebAssembly) and
60 ms (TypeScript).
