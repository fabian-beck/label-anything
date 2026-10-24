# 0005 — Coverage grids and summed-area tables

* Status: accepted
* Date: 2026-10-16
* Area: Obstacles and backgrounds

## Context
§5.2 asks for per-class cost grids with SATs (O(1) rectangle cost) within a memory budget
of `cells × classes × 4 B`.

## Decision
* Coverage per cell is quantized to `u8` (0..255); a cell touched by geometry stores at
  least 1, so "any coverage" is conservative.
* The SAT is `u32` with **wrapping** arithmetic: rectangle sums are exact whenever the
  true sum < 2³² (≥ 16.8 M fully covered cells), which covers every realistic grid. The
  `u8` grid is dropped after the SAT is built (single cells are SAT differences), so
  memory is exactly 4 B per cell and class.
* Arbitrary (non grid-aligned) rectangles: coverage is piecewise constant, so its
  integral is exact with a 3 × 3 block decomposition (interior, edges, corners) weighted
  by fractional overlaps — 16 SAT lookups, integer block sums, one float combination.
  (Bilinear interpolation of the SAT would be equally exact but needs non-wrapping
  values.)
* Grid cell: `clamp(min_font_size/4, 1, 4)` px (brief), overridable.

## Consequences
Soft costs are continuous in the label position (good for local search), exact for the
rasterized coverage, and cheap. Coverage resolution is 1/255 of a cell.
