# 0014 — Exact search: deterministic branch and bound instead of a MILP solver

* Status: accepted (deviation from brief §5.6 "exact")
* Date: 2026-10-16

## Context
The brief suggests the optional exact strategy as a MILP (one binary per candidate, at
most one per item, pairwise conflicts) solved with the `highs` crate in Rust and the
`highs` WASM build in TypeScript. HiGHS is C++: the crate needs CMake and a C++ toolchain,
it does not build for `wasm32-unknown-unknown`, the TypeScript package would need a
separate multi-megabyte WASM dependency, and its runtime (and, with time limits, its
result) depends on the machine, which conflicts with determinism (ADR 0007).

## Decision
`strategy: "exact"` (and `auto` for ≤ 3,000 candidates with a budget ≥ 500 ms) runs a
branch and bound over items in priority order on the candidate conflict graph
(`solver/exact.rs`): the 24 cheapest feasible candidates per item, the omission mode's
priority objective first (strict: per key level; prefix: prefix length; weighted: tier
sums), then total static cost, bounded by "every remaining item at its cheapest
candidate". The search is limited by a node budget (`max(budget_ms × 2000, 10,000)`),
starts from the local-search incumbent and never returns anything worse. It is pure
code, identical in both implementations, and deterministic.

## Consequences
Proven optima on small and medium instances (the conformance and benchmark problems
with up to a few hundred candidates); on large instances the node budget makes it a
bounded improvement step. A MILP backend can still be added later behind a feature flag
for users who want it, as a host-provided strategy.
