# 0035 — (1,2)-swaps in the local search: measured, not adopted

* Status: rejected (optimization)
* Date: 2026-10-18

## Context
The local search adds little over the greedy pass with its ladder (+0.7 % priority-weighted
placement, M4 in `docs/benchmark.md`). In the independent-set literature the workhorse of
local search is the (1,2)-swap: remove one element of the solution, insert two
(Andrade, Resende, Werneck 2012; `docs/project/literature.md`, O4). The local search here
inserts labels, relocates them and evicts strictly lower-priority ones, but never trades
one label for two.

With `strict` omission the objective compares the placed keys lexicographically, most
important first. Removing label `j` for two labels of lower keys makes it worse; if one of
the two has a higher key than `j`, inserting it by evicting `j` is already a move. The
default priorities (input order, or scores from priority terms) give every item its own
key, so on every problem of the benchmark except the `weighted` ones a swap cannot improve
anything. It can where weights add up (`weighted`: two labels together outweigh one) or
where keys tie (equal priorities: as many labels as possible).

A prototype tried, for an unplaced item `u`, its cheapest candidates blocked by one placed
label `j` only, removed `j`, placed `u` and placed the cheapest free candidate of another
unplaced item near `j`'s box, kept when the objective improved (10 % of the moves, enabled
only for `weighted` or tied keys). Deterministic solves at the default 10,000 moves: the
three `weighted` airport problems 537 → 542, 532 → 536 and 519 → 524 labels (+1 %); equal-
priority copies of the Monaco POIs 206 → 209, the 2,000 random points 872 → 874, 1,000
airports 494 → 495, 400 European airports 366 → 367; nine other problems unchanged; cost
per label unchanged. One to three swaps are accepted per solve. With five times the moves
the gains stay the same (+1 to +4 labels), and letting the second item use all its stored
candidates instead of its level-0 ones changes nothing.

## Decision
The local search keeps its moves; no (1,2)-swap.

## Consequences
None. After the greedy pass, the ladder and the insertion moves, few such swaps remain
among the stored candidates — ladder candidates blocked when they were generated are not
stored (ADR 0015), so an omitted item seldom has a candidate in the room a removed label
leaves. Re-optimizing a neighbourhood with candidates generated afresh (POPMUSIC with the
exact search, literature O2) would address that, at a larger cost.
