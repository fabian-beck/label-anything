# Search

After the greedy pass, a simulated-annealing local search improves the layout, and small
problems get an exact branch and bound written in plain code rather than a MILP solver.

## Context
The brief suggests the exact strategy as a mixed-integer program solved with HiGHS. HiGHS
is C++: it needs CMake, does not build for `wasm32-unknown-unknown`, would add a
multi-megabyte WebAssembly dependency to the TypeScript package, and its runtime — with
time limits, its result too — depends on the machine. The local search, for its part, adds
little over a greedy pass with a ladder (+0.7 % priority-weighted placement on the
benchmark).

## Decision
- **Local search** (spec §10.2) relocates and swaps labels, inserts unplaced items by
  ejection chains, and switches variants. Priority never gets worse; costs follow the
  Metropolis rule over the iteration budget. A move's `Δ` counts only the moved labels'
  own costs; the best state is restored at the end only when its total, computed afresh,
  is lower than the walk's.
- **Exact search** (`strategy: "exact"`, or `auto` for at most 3,000 candidates and a
  budget of at least 500 ms) is a branch and bound over items in priority order on the
  conflict graph: the 24 cheapest feasible candidates per item, the omission objective
  first and static cost second, bounded by every remaining item at its cheapest candidate,
  within a node budget of `max(budget_ms × 2000, 10 000)`. It starts from the local
  search's result and never returns anything worse. It is the same code in both languages
  and deterministic.

## Consequences
Small and medium problems get proven optima, large ones a bounded improvement. A MILP
backend could still come as a strategy supplied by the host. The running sum of `Δ` can
drift from the true total, since a leader through another label's buffer changes that
label's cost; the restore rule tolerates the drift instead of evaluating every neighbour
twice more.

## Alternatives
- **HiGHS**: see the context.
- **(1,2)-swaps**, the workhorse of independent-set local search: with strict priorities
  no swap can improve, since removing a label for two of lower keys makes it worse and one
  of higher key is already an eviction. Where weights add up or keys tie, a prototype
  gained 1–5 labels per problem.
- **An exact `Δ`**, including the other labels' dynamic costs: two more cost evaluations
  per neighbour of every move that involves a leader.
- **Draws without idle iterations** (44 % of the draws make no move): better results at
  the same number of moves, but the same budget then takes 1.8 times as long.
