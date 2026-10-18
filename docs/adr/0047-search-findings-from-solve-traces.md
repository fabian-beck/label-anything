# 0047 — Findings from solve traces: a lookahead bound, a true-cost restore, explanations from evaluated candidates

* Status: accepted (spec §10.1, §10.2; Rust `la-core` and TypeScript `@label-anything/core`; conformance case `search-restore-true-total`)
* Date: 2026-10-18

## Context
The solve traces of ADR 0046 show every decision of the solver with its numbers. Read over
the 67 parity fixtures, the explainer's scenes and a few hundred generated crowded
problems, they showed five things:

1. **Lookahead work that cannot matter.** The greedy pass computes the lookahead of the 8
   cheapest free candidates (by static + dynamic cost). The lookahead is never negative
   (`weights.lookahead`, `weights.starve` ≥ 0), so a candidate whose cost alone exceeds the
   best total so far cannot win, nor can any later one; 65 % of the lookahead
   evaluations (2,520 of 3,884) were of such candidates.
2. **A search that compares its running sum with true totals.** A local-search move's `Δ`
   counts the moved labels' own costs, static and dynamic against the other labels, but
   not what the move changes in the other labels' dynamic costs: with the default
   `avoid.buffer.leaders` (0.5), a leader through another label's buffer ring is part of
   that label's cost. The running sum then drifts from the total: in 20 of 34 solves with
   crowded leaders by about 0.1 %. The end of the search compared the true final total
   with the running sum's best and, when it was lower, restored the snapshot without
   knowing its true total.
3. **Unevaluated candidates read as feasible.** Ladder candidates are evaluated lazily, and
   a candidate's `feasible` is `true` until it is. The explanation of an omitted item
   (`explain`) and the result's report of it (`blocking`, `blocked_by`) read the item's
   kept candidates without evaluating them, so a never-evaluated one counted as statically
   feasible, at cost 0. No problem we tried has one (in the greedy pass a kept ladder
   candidate is free when it is made, so it is evaluated at once); keep_with roll-backs
   and evictions can leave one.
4. **The lookahead's cut-off at 8 is a fair heuristic.** In 32 of 561 choices a candidate
   without a lookahead cost less by itself than the chosen one's total (the 8 cheapest are
   often slider positions along one side). Taking the exact minimum over all candidates
   changed 8 of 101 greedy-only results (3 better, 5 worse) and 5 with local search (4
   better, 1 worse, the European map's total cost up from 8.95 to 12.57).
5. **Draws without a move.** 44 % of the local-search iterations (65,817 of 148,000) made
   no move: a relocation of an item without a label (15 %), of its own candidate or one it
   may not use (19 %), an insertion that drew a labeled item (5 %). Drawing only labeled
   items, usable candidates and unlabeled items for insertion improved 16 and worsened 5
   of 101 results at the same number of moves, but every move is then a real one: the same
   budget took about 1.8 × as long.

## Decision
* **Bound the lookahead** (1): stop at the first candidate whose cost exceeds the best
  total. The choices are the same (101 of 101 results identical, the parity fixtures
  unchanged). The greedy phase of the performance problems: p200 9.5 → 8.5 ms (Rust,
  minimum of 40 runs) and 75 → 66 ms median for the whole TypeScript solve, p2000 222 →
  214 ms (Rust); the lookahead is 2.4 % of the TypeScript p2000 profile, the ladder's
  candidate generation 28 % and the explanations of omitted items 8 %.
* **Restore by true totals** (2): when the walk ended above the best state, that state is
  restored and its total computed; when it is not lower than the walk's, the walk's state
  stays. Without drift the decision is the old one (the parity fixtures are unchanged);
  with drift, 20 of 600 generated crowded problems changed, 14 to a lower total cost and 6
  to an equal one, none to a higher. The conformance case `search-restore-true-total` is one
  of them, so that Rust and TypeScript are held to the same decision.
* **Explain from evaluated candidates** (3): `explain` and the report of an omitted item
  evaluate the item's never evaluated candidates first, as every other reader of
  feasibility does (local search, exact search, `evict_lower`, priority repair).
* The spec states the lookahead bound, how `T₀` is taken (the median *increase* of the
  static cost over 50 random relocation probes, not the median |Δ|), what `Δ` covers and
  the restore rule.

Not adopted, for a decision on the benchmark: the exact lookahead minimum (4), which is
as often worse as better; draws without idle iterations (5), a trade of time for quality
per move that the release gates' timing targets have to weigh; and a `Δ` that includes the
other labels' dynamic costs (2), which would make the running sum exact but costs two
dynamic-cost evaluations per neighbour of every move involving a leader.

## Consequences
Results are unchanged except where the search's running sum drifted, and there they are
never worse. The explainer shows fewer lookahead values per choice (only those computed).
