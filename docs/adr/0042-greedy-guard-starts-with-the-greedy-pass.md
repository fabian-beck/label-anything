# 0042 — The greedy guard starts with the greedy pass

* Status: accepted
* Date: 2026-10-18
* Area: Solver
* Affects: Rust `la-core`, TypeScript `@label-anything/core`
* Amends: [ADR 0007](0007-determinism-and-time-budget.md) (the greedy guard)
* Amended by: [ADR 0048](0048-level-0-pass-after-the-greedy-guard.md)

## Context
ADR 0007's wall-clock guard stopped the greedy pass from opening new priority bands
10 × `time_budget_ms` after the start of the solve. Preparation and candidate generation
always run to completion, so their time counted against the greedy pass alone. Labeling
the 20 most significant genes of a 20,000-gene volcano plot with the matplotlib helper
spent 5 s measuring the labels with the figure's renderer (a host `measure` callback) and
2.6 s generating candidates: the guard (1 s) had passed before the first band, and the
result placed nothing — every item `budget_exhausted` after 8 s of waiting. The same
problem with `measure=False` placed all 20.

## Decision
The greedy guard runs from the start of the greedy pass: it stops placing 10 ×
`time_budget_ms` after the pass began. It is checked before every priority band and,
since a single band can hold thousands of items (rank ties of `outlierness` on clustered
data), every 64 items within a band; the undecided rest is `budget_exhausted`. The
local-search guard (3 × the budget after the start of the solve) is unchanged: it ends an
improvement, never the first placement.

Once `priority.budget.max_labels` labels are placed, the items after them in the total
order are `omitted_by_priority` without trying the ladder: none of them can be placed
(`evict_lower` evicts only lower keys, and none is placed yet), and the ladder made each
of them cost tens of milliseconds.

## Consequences
A slow preparation still yields the greedy result of the most important bands; the total
time of a solve is now bounded by its preparation plus 10 × the budget for the greedy pass.
Solves without a clock (the parity fixtures, `BasicEnv`) and solves whose guard does not
fire are unchanged; no parity fixture changed with the early end at `max_labels` either.
On 20,000 heavy-tailed points with `outlierness` and `max_labels` 40, whose 3,836-item
first band the old guard had skipped, the greedy pass takes 0.2 s (it ran 302 s with the
guard between bands only). The synthetic volcano plot (20,000 labels, a 0.15 ms host
measurement, `max_labels` 20) places 20 labels instead of 0 in the TypeScript core; the
test `time_guard` (Rust and TypeScript) pins the behaviour with a clock that advances only
while labels are measured.
