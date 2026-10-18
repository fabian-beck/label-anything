# 0046 — A level-0 pass after the greedy guard

* Status: accepted (amends ADR 0007 and ADR 0042; Rust `la-core`, TypeScript `@label-anything/core`)
* Date: 2026-10-18

## Context
The greedy pass stops 10 × `time_budget_ms` after it began (ADR 0042), and every item it
had not decided was `budget_exhausted`. On large problems that guard is the normal case,
not the pathological one: in the full benchmark it fires on every problem with more than
about 2,000 items (the 3,000-airport map, the 3,221-airport priority problems, the stress
problems from 5,000 anchors), because each item that finds no free normal position runs
the whole degradation ladder — wrapped, distant and shrunk variants, a few hundred boxes
each (ADR 0034), about 1 ms per item in the dense stress problems — before the next item
gets its turn.

The result got worse as the input grew. The stress scenario (airports at 10× density)
placed 855 labels for 5,000 anchors, 529 for 10,000 and 279 for 20,000, where 19,148 items
were `budget_exhausted`: the guard stopped after about 850 items in priority order. With
the guard lifted the 20,000-anchor problem places 1,134 labels, after 25 s in the greedy
pass; without the ladder (`--degrade omit`) it places 923, with half a second for its
greedy pass. Which items made it before the guard also depended on the machine.

## Decision
When the greedy guard passes, the items still undecided — in total order, except
`keep_with` members (placed together or not at all) and items whose level-0 attempt in
their band already failed (their candidates only lose room) — are visited once more and
take their best free level-0 candidate exactly as in a band's level-0 pass (static +
dynamic cost, lookahead, on-demand distant candidates), without the ladder and without
explaining a failure. This pass has a guard of its own, another 10 × `time_budget_ms`
from its start (checked every 64 items); every item still undecided after it is
`budget_exhausted`. With `prefix` omission the first item without a free level-0
candidate ends the prefix, so the placed labels stay a prefix of the total order.

Considered and rejected:
* *Switching to level 0 earlier* (at 5 × the budget, keeping the 10 × total): it moves
  problems whose greedy pass takes 5–10 × the budget — today deterministic on a fast
  machine — into the timing-dependent regime.
* *Cheaper ladders for every item* (fewer variants, no distant candidates for shrunk
  ones): changes results everywhere and places fewer labels (ADR 0034).

## Consequences
Solves without a clock (the parity fixtures, `BasicEnv`, `--no-clock`) and solves whose
greedy guard does not fire are unchanged. Where it fires, the most important items still
get the full ladder first, and the rest fill the room that is left instead of being
dropped: the stress scenario places 942 labels for 5,000 anchors, 906 for 10,000 and 914
for 20,000 (from 818–855, 529 and 279), the greedy pass of the 20,000-anchor problem takes
1.3 s instead of 1.0 s, and the 3,221-airport problems leave fewer items
`budget_exhausted` (e.g. 568 instead of 716 with coverage reservations). A
`budget_exhausted` item may now have been tried at level 0: its ladder did not run. A
solve's greedy pass is bounded by 20 × the budget (it was 10 ×); the level-0 pass rarely
needs its share — it uses candidates built in the preparation. The tests `time_guard`
(Rust and TypeScript) pin the behaviour with a clock that advances whenever it is read.
