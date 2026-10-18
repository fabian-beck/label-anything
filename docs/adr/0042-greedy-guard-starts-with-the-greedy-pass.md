# 0042 — The greedy guard starts with the greedy pass

* Status: accepted (amends ADR 0007; Rust `la-core`, TypeScript `@label-anything/core`)
* Date: 2026-10-18

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
The greedy guard runs from the start of the greedy pass: it stops opening new bands
10 × `time_budget_ms` after the pass began. The local-search guard (3 × the budget after
the start of the solve) is unchanged: it ends an improvement, never the first placement.

## Consequences
A slow preparation still yields the greedy result of the most important bands; the total
time of a solve is now bounded by its preparation plus 10 × the budget for the greedy pass.
Solves without a clock (the parity fixtures, `BasicEnv`) and solves whose guard does not
fire are unchanged. The synthetic volcano plot (20,000 labels, a 0.15 ms host
measurement, `max_labels` 20) places 20 labels instead of 0 in the TypeScript core; the
test `time_guard` (Rust and TypeScript) pins the behaviour with a clock that advances only
while labels are measured.
