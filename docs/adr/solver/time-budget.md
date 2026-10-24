# Time budget

A solve is bounded by an iteration budget rather than the clock, so its result never
depends on machine speed; wall-clock guards and cancellation only cut runaway or unwanted
solves short, and still return a valid result.

## Context
Solves must be deterministic and bounded by `solver.time_budget_ms`. An annealing schedule
driven by the clock would make results depend on the machine and its load. Yet slow
machines, slow host callbacks and huge problems must not hang a solve: a matplotlib helper
that spent 5 s measuring labels through the figure's renderer once placed nothing at all,
and on 20,000 dense anchors each item that found no room ran the whole ladder, about 1 ms,
while the rest waited.

## Decision
- `time_budget_ms` becomes
  `iterations = min(max_iterations, time_budget_ms × rate, 400 × n_items)`, with a rate of
  100 moves per ms in Rust and 40 in TypeScript, whose default budgets (100 and 250 ms)
  both give 10,000 moves. A move costs about 6 µs natively. The annealing schedule follows
  the iteration index.
- Wall-clock guards are the only place where timing enters, and they set
  `stats.time_guard_hit`:
  - the greedy pass stops running bands and ladders 10 × the budget after the pass began
    (checked before every band and every 64 items), so a slow preparation does not count
    against it;
  - the items still undecided then take their best free level-0 position, in priority
    order and without the ladder, for up to another 10 × the budget; the rest are
    `budget_exhausted`;
  - local search stops 3 × the budget after the solve began; it ends an improvement, never
    the first placement.
- Once `priority.budget.max_labels` labels are placed, the remaining items are
  `omitted_by_priority` without running the ladder.
- Cancellation (`Env::cancelled`, an `AbortSignal` in JavaScript) is polled at every band,
  every 64 greedy items, 256 local-search moves and 4,096 exact-search nodes. A cancelled
  solve stops improving but still repairs and verifies, so its result is valid
  (`stats.cancelled`).

## Consequences
Without a clock (`--no-clock`, the parity fixtures) results are fully deterministic, and
with one they are as long as no guard fires. Where the greedy guard fires, as it does
beyond about 2,000 items, the most important items still get the full ladder and the rest
fill the remaining room: the 20,000-anchor stress problem places 914 labels instead of
279. The greedy pass is bounded by 20 × the budget after preparation.
