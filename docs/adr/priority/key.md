# Priority key

Priority is a key `(required, tier, reserved, band(score))`; the greedy pass places one
band after another, each with its own ladder, so strict priority holds by construction.

## Context
The brief defines the key `(required, tier, score, tie)` and three omission modes: strict
(no omitted item could be placed if only more important labels existed), prefix and
weighted. The greedy pass may reorder items only within equal keys, the ladder runs for
items that cannot be placed, and `evict_lower` displaces labels of lower key.

## Decision
- Strictness is defined on `(required, tier, reserved, band(score))`; the tie rule only
  orders processing and the prefix. Without priorities every item has the same key, and
  the solver is free to maximize the number of labels.
- Coverage (`priority.coverage`) sets `reserved` between tier and score, so a reserved
  item outranks the other items of its tier; otherwise "never leave a category unlabeled
  while space exists" could not be guaranteed.
- The greedy pass runs the ladder per band: a level-0 pass (undegraded labels) over the
  band, most constrained item first, then the ladder for the band's leftovers. No label of
  lower key exists yet while a band runs, so strictness holds without eviction;
  `evict_lower` matters for local search, warm starts and `keep_with` roll-backs.
- `weighted` uses `max(score, 0) + 1e-6`, the ε preferring more labels; `placed_weighted`
  uses the NDCG gain `1 / log2(rank + 2)`, defined without priorities too.

## Consequences
`stats.priority_inversions = 0` in strict and prefix mode is a theorem of the greedy pass
and an invariant of the local search; the verification checks it again with the removal
test. The passes after the search keep it too (ADR priority/repair).
