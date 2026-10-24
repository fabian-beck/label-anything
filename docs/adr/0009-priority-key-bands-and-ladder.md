# 0009 — Priority key, bands, and the per-band ladder

* Status: accepted
* Date: 2026-10-16
* Area: Priority

## Context
§4.4 defines the key `(required, tier, score, tie)` and strict/prefix/weighted omission.
§5.6/§5.7 say greedy may reorder only within equal-key bands, the ladder runs for items
that cannot be placed, and `evict_lower` displaces lower-key labels.

## Decision
* Strictness is defined on `key = (required, tier, reserved, band(score))`; the tie
  rule only orders processing and defines prefix order. With no priorities at all, every
  item has the same key, so the solver is free to maximize the number of labels; ties
  then decide the processing order and `omission_order`.
* Coverage (`priority.coverage`) is a `reserved` flag between tier and score, so a
  reserved item outranks all non-reserved items of its tier (otherwise "never leave a
  category unlabeled while space exists" cannot be guaranteed).
* Greedy processes bands in key order and runs the **ladder per band**: first a level-0
  pass over the band (most-constrained-first), then the ladder for the band's leftovers.
  Because no lower-key label exists yet when a band is processed, strictness holds by
  construction; `evict_lower` matters for local search, warm starts and keep_with
  roll-backs and is implemented generally.
* `weighted` uses weight `max(score, 0) + 1e-6` (the ε prefers more labels; with no
  priorities it maximizes the count).
* `placed_weighted` = Σ placed g(rank) / Σ all g(rank) with `g(r) = 1/log2(r + 2)` (the
  NDCG gain), so it is defined even without explicit priorities.

## Consequences
`stats.priority_inversions = 0` in strict/prefix is a theorem of the greedy phase and an
invariant of local search; the verification pass re-checks it with the removal test.
