# 0006 — Exact hard constraints

* Status: accepted
* Date: 2026-10-16
* Area: Obstacles and backgrounds

## Context
Hard constraints must never be violated, and the evaluator re-checks them with exact
geometry (0.5 px tolerance). A supersampled grid alone can miss thin geometry.

## Decision
* Hard tests against **vector** geometry (item marks, vector/SVG primitives of classes
  that are hard for labels or leaders, placed labels, placed leaders) are exact geometric
  predicates through uniform-grid spatial indexes. Touching (distance ≤ 1e-9 px) is not
  an overlap.
* Hard tests against **raster** classes use the grid conservatively: a label touches the
  class iff its covered area > 0, i.e. it overlaps a cell that contains ink.
* Soft costs always use the coverage grids (vector classes are rasterized too).
* A final verification pass re-tests the whole placement exactly and fills
  `stats.hard_violations` (expected 0) and `stats.leader_crossings`.

## Consequences
Vector-defined hard classes are pixel-exact; raster-defined hard classes are exact up
to the grid cell (never optimistic).
