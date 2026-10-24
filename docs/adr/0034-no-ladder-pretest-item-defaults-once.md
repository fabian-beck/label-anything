# 0034 — No ladder pretest; item option defaults resolved once

* Status: accepted
* Date: 2026-10-18
* Area: Solver
* Affects: performance; no behaviour change

## Context
The 2,000-label performance problem (`bench/out/perf/scatter-2000.json`) misses its target
(`docs/benchmark.md`). The literature notes (`docs/project/literature.md`, S1) suggested
detecting labels without room before the ladder runs, so that their wrapped, distant and
shrunk variants are never built. Instruction counts of one solve (callgrind, one thread,
time budget raised so that the guard does not fire): 1,428 M instructions, of which the
greedy pass takes 997 M and the ladder's candidate generation 570 M.

Instrumented, the ladder runs for 1,509 items: 381 are placed (352 at `shrink`, 29 at
`wrap`), 1,128 omitted. It builds 832,018 boxes, 560 per omitted item (median). The
occupancy grids (ADR 0015) reject 93 % of them; 58,615 reach the exact test and 19,822
pass it. A sound pretest must reject an item only when no box of it could pass the grids:
that holds for 18 of the 1,128 omitted items (1 % of the boxes). Per label variant and
model, families of boxes without any survivor hold 172,160 of 297,160 adjacent and slider
boxes and 140,688 of 668,633 distant ones (ladder and on-demand distant candidates):
even a test as tight as the boxes themselves would skip a third of them, and a test over
the continuous region the boxes come from (the ring around the mark, the annulus of the
distant rings) much less, since a free spot somewhere in it rarely means a free candidate
position. The labels fail on the discrete positions and on the exact tests — the label
margin, overlaps thinner than a cell — which no cheaper test captures.

The same profile shows the solve resolving the same options again and again: every item
looked up the problem-wide defaults (`defaults.padding`, `placement.offset`, …, 18 keys)
through string-keyed maps and parsed their lengths anew.

## Decision
* No pretest before the ladder.
* The problem-wide item option defaults are resolved once per problem (`ItemDefaults` in
  `model/mod.rs`, `itemDefaults` in `model/index.ts`); items fall back to them as before.

## Alternatives considered

* *A whole-item or per-family fit test* on the occupancy grids (summed-area or bit-parallel
  window search over the reach of the smallest variant): measured ceiling above, while the
  test itself costs a window search per item and variant.
* *A margin-aware placed-label grid* (each placed box marked grown by its margin as a
  cross, so that boxes closer than the margin are rejected before the exact test): −1.2 %
  instructions, for an invariant (the grid may serve only candidates that are not
  warm-start boxes, whose spacing is halved) that every later user of the grid would have
  to keep.
* *No distant candidates for shrunk variants* (half of the ladder's boxes): 44 of the 381
  ladder placements are such candidates; it changes results.

## Consequences
scatter-2000: 1,428.5 M → 1,381.8 M instructions per solve (−3.3 %). Placements are
identical on every static benchmark problem (as built at commit 69fc5fb) and every parity
fixture. The target is still
missed: the time of an omitted label is the number of its candidate boxes, not the cost of
testing one (about 55 instructions in the grid), and fewer boxes means fewer labels.
