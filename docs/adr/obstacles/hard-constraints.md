# Hard constraints

Hard constraints are tested on exact geometry, never on a grid alone, and a final pass
verifies the whole placement.

## Context
A hard constraint must never be violated, and the benchmark's evaluator re-checks every
result with exact geometry. A supersampled grid misses thin geometry.

## Decision
- Tests against vector geometry — item marks, vector and SVG primitives of hard classes,
  placed labels and leaders — are exact geometric predicates on uniform-grid spatial
  indexes. Touching (a distance up to 1e-9 px) is not an overlap.
- Tests against raster classes use their grid conservatively: a label touches the class if
  it overlaps a cell with any coverage.
- Soft costs always come from the coverage grids (ADR obstacles/coverage-grids), so vector
  classes are rasterized for them too.
- After solving, a verification pass re-tests the whole placement exactly and reports
  `stats.hard_violations`, which must be 0, and `stats.leader_crossings`.

## Consequences
Hard rules are pixel-exact for vector classes, and exact up to a grid cell, never
optimistic, for raster classes. A violation found by the verification is a bug; the
offending lower-priority label is removed and reported as omitted.
