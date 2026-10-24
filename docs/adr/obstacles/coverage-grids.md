# Coverage grids

Soft costs read obstacle coverage from one grid per class with a summed-area table:
constant time per rectangle, exact for the rasterized coverage, and continuous as a label
moves.

## Context
The cost of every candidate needs the area of each obstacle class under its box. Spec §4.1
asks for per-class grids with summed-area tables within a memory budget of
`cells × classes × 4 B`.

## Decision
- Coverage per cell is a `u8` (0–255); a cell touched by geometry stores at least 1, so
  "any coverage" is conservative.
- The summed-area table holds `u32` sums with wrapping arithmetic: rectangle sums stay
  exact while the true sum is below 2³² (16.8 M fully covered cells), which covers every
  allowed grid. The `u8` grid is dropped once the table exists, so a class costs exactly 4
  B per cell.
- A rectangle not aligned to the grid is integrated exactly by splitting it into interior,
  edges and corners weighted by their fractional overlap: 16 lookups, integer block sums,
  one floating-point combination.
- The cell is `clamp(min_font_size / 4, 1, 4)` px unless set.

## Consequences
Costs change continuously as a label moves, which local search needs, are exact for the
rasterized coverage, and cost 16 lookups per class. Coverage resolution is 1/255 of a
cell. Hard constraints do not use the grids (ADR obstacles/hard-constraints).
