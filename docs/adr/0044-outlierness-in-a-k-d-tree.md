# 0044 — Outlierness in a k-d tree

* Status: accepted
* Date: 2026-10-18
* Area: Priority
* Affects: Rust `la-core`, TypeScript `@label-anything/core`; no change to results

## Context
The `outlierness`, `isolation` and `crowding` priority terms need every item's k-th
nearest gap to the other marks (spec §9.1). They searched a uniform grid whose cell size
came from the average density over the bounding box, doubling a query square until it
held k neighbours. On heavy-tailed data — a dense core and far outliers, as in volcano
plots and embeddings — the bounding box is large and almost every point sits in a few
core cells, so each core query collected and sorted thousands of gaps: O(n²) in effect.
Preparing 20,000 Student-t distributed points took 60 s in the TypeScript core and
6–10 s in Rust, all of it in this search.

## Decision
A k-d tree over the disc centres (median splits on the wider side, leaves of at most 8)
answers each query: nodes are visited nearer child first and skipped when their lower
bound — the distance from the anchor to the node's box, minus its largest radius and the
item's radius — exceeds the k-th smallest gap found so far. Every gap is computed with the
same expression as before, and the bound never exceeds a gap inside the node (IEEE
rounding is monotone), so the k-th smallest gap, and with it every priority, is exactly
the one of the grid search; only the work changes.

## Consequences
Profile (20,000 Student-t points, `outlierness`, `max_labels` 40, CI container):
preparation 60.5 s → 0.86 s in TypeScript, the whole solve 1.7 s in Rust. No parity
fixture changed. `kd_tree_finds_the_exact_kth_gap` (Rust and TypeScript) compares the
tree with a search over all discs on heavy-tailed points with mixed radii.
