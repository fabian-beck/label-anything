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

The [explainer](../try.md#how-it-works-step-by-step) steps through these phases on a real
solve; the [specification](../reference/spec.md#10-solver) defines them. `solver.strategy`
sets how far a solve goes:

* `greedy` — the greedy pass with the degradation ladder only.
* `local` — greedy, then local search (relocate, swap, insert by ejection chains, switch
  label variants) with a simulated-annealing acceptance rule.
* `exact` — local search, then a deterministic branch and bound over the 24 cheapest
  candidates per item, which proves optima on small and medium problems and is a bounded
  improvement step on large ones ([ADR solver/search](../adr/solver/search.md)).
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
degradation ladder 10 × the budget after it started (checked between priority bands and
every 64 items), so that a slow preparation, such as a host `measure` callback for many
labels, still leaves the most important labels their turn. Items not reached by then still
get their best free normal position, in priority order and without the ladder, for up to
another 10 × the budget; the rest are `budget_exhausted`
([ADR solver/time-budget](../adr/solver/time-budget.md)). Either guard sets
`stats.time_guard_hit`, the only case in which results may depend on timing.

For interactive use, lower the budget; for publication graphics, raise it, to 500 ms or
more to allow the exact search.

## Determinism

The same problem and `solver.seed` give the same result on every machine and in every
run:

* no decision depends on hash-map iteration order, and sorts are stable with total
  comparators;
* floating-point code uses only `+ − × ÷ √` and a shared deterministic math library
  (`det_math`: logarithms, exponentials, sines in degrees, rounding), built from the same
  operations in Rust and TypeScript;
* random choices come from a specified PCG32 generator seeded with `solver.seed`.

The TypeScript engine is a line-by-line port of the Rust core and makes the same decisions
for the same iteration counts; the conformance suite's parity fixtures compare their
results. Text widths of the bundled font are identical in every implementation (simple
shaping). [Specification §10.4](../reference/spec.md#104-determinism) has the details.

## Cancellation and progress

A host can stop a solve early:

| Binding | Cancel with | Progress |
|---|---|---|
| Python | `cancelled=` a `la.CancelToken`, a callable, a `threading.Event` (raises `la.Cancelled`) | `progress=(phase, fraction)` |
| JavaScript / WebAssembly | `signal` (an `AbortSignal`, or any object with `aborted`) | `progress` |

The solver polls the request at every priority band and every 64 items of the greedy pass,
every 256 local-search moves and every 4,096 exact-search nodes. Once cancelled, it stops
improving — the greedy pass places no more items (`budget_exhausted`), the searches keep
their best state — but still repairs and verifies, so the result is valid, with
`stats.cancelled` set ([ADR solver/time-budget](../adr/solver/time-budget.md)). `place` is
synchronous, so in JavaScript, cancel from a callback or solve in a worker
([WebAssembly](../getting-started/javascript.md#webassembly)).

Progress is reported as `(phase, fraction)` when a phase starts (`greedy`, `local`,
`exact`), per greedy band and every 256 local-search moves.

## The grid

Soft costs are computed on coverage grids, one per obstacle class, whose summed-area
tables answer area queries in constant time
([ADR obstacles/coverage-grids](../adr/obstacles/coverage-grids.md)). `grid_cell: "auto"`
is a quarter of the smallest font size, clamped to 1–4 px; larger cells are faster and
coarser. Hard tests against vector geometry do not use the grid: they are exact
([ADR obstacles/hard-constraints](../adr/obstacles/hard-constraints.md)).

## Performance

The [benchmark](../project/benchmark.md) checks the performance targets on every release,
for example 200 labels over 10,000 points in at most 15 ms (Rust), 30 ms (WebAssembly) and
60 ms (TypeScript).
