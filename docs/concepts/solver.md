# Time budget, determinism and cancellation

```json
{
  "solver": { "strategy": "auto", "time_budget_ms": 100, "max_iterations": 200000, "seed": 0, "grid_cell": "auto" }
}
```

## Strategies

* `greedy` — the priority-ordered greedy pass with the degradation ladder only.
* `local` — greedy, then local search (relocate, swap, insert by ejection chains, switch
  label variants) with a simulated-annealing acceptance rule that never breaks a hard
  constraint and never makes the priority outcome worse.
* `exact` — local search, then a deterministic branch and bound over the 24 cheapest
  candidates per item, which proves optima on small and medium problems and is a bounded
  improvement step on large ones ([ADR 0014](../adr/0014-exact-search-branch-and-bound.md)).
* `auto` (default) — `local`, or `exact` for problems with at most 3,000 candidates and a
  budget of at least 500 ms.

`stats.strategy_used` reports what ran.

## The time budget is an iteration budget

`time_budget_ms` (default **100 ms** in the Rust core and its bindings, **250 ms** in the
TypeScript engine) does not stop the search on the clock. It is converted into a fixed
number of local-search moves:

> moves = min(`max_iterations`, `time_budget_ms` × rate, 400 × number of items)

with rate 100 moves per ms in Rust and 40 in TypeScript — 10,000 moves for both defaults.
The result therefore depends on the input and the seed, never on the machine's speed or
load ([ADR 0007](../adr/0007-determinism-and-time-budget.md)).

A wall-clock **guard** protects against pathologically slow machines: local search stops
at 3 × the budget after the start of the solve, and the greedy pass stops opening new
priority bands at 10 × (the remaining items are `budget_exhausted`). Either sets
`stats.time_guard_hit` — the only case in which results may depend on timing.

For interactive use, lower the budget; for publication graphics, raise it (and allow the
exact search with ≥ 500 ms).

## Determinism

The same problem and `solver.seed` give the same result on every machine and run:

* no decision depends on hash-map iteration order; sorts are stable with total
  comparators;
* floating-point code uses only `+ − × ÷ √` and a shared deterministic math library
  (`det_math`: logarithms, exponentials, sines in degrees, rounding) implemented with the
  same operations in Rust and TypeScript;
* random choices come from a specified PCG32 generator seeded with `solver.seed`.

The TypeScript engine is a line-by-line port of the Rust core and makes the same decisions
for the same iteration counts; the parity fixtures of the conformance suite compare their
results. Text widths of the bundled font are identical in every implementation (simple
shaping). [Specification §10.4](../reference/spec.md#104-determinism) has the details.

## Cancellation and progress

A host can stop a solve early:

| Binding | Cancel with | Progress |
|---|---|---|
| Python | `cancelled=` a `la.CancelToken`, a callable, a `threading.Event` (raises `la.Cancelled`) | `progress=(phase, fraction)` |
| JavaScript / WebAssembly | `signal` (an `AbortSignal`, or any object with `aborted`) | `progress` |

The solver polls the request at every priority band and every 64 items of the greedy pass,
every 256 local-search moves and every 4,096 exact-search nodes. Once cancelled it stops
improving — the greedy pass places no further items (`budget_exhausted`), the searches keep
their best state — and still repairs and verifies, so the result is valid; `stats.cancelled`
is `true` ([ADR 0017](../adr/0017-cancellation-and-progress.md)). `place` is synchronous: in
JavaScript, cancel from a callback or run the solve in a worker
([WebAssembly limitations](../bindings/wasm.md#limitations)).

Progress is reported when a phase starts (`greedy`, `local`, `exact`), per greedy band and
every 256 local-search moves, as `(phase, fraction)`.

## The grid

Soft costs are computed on coverage grids, one per obstacle class, with summed-area tables
for constant-time area queries ([ADR 0005](../adr/0005-coverage-grids-and-summed-area-tables.md)).
`grid_cell` `"auto"` is a quarter of the smallest font size, clamped to 1–4 px; larger cells
are faster and coarser. Hard tests against vector geometry do not use the grid: they are
exact ([ADR 0006](../adr/0006-exact-hard-constraints.md)).

## Performance

The [benchmark](../project/benchmark.md) measures the targets — for example 200 labels
over 10,000 points in ≤ 15 ms (Rust), ≤ 30 ms (WebAssembly), ≤ 60 ms (TypeScript) — on
every release.
