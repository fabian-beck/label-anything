# 0030 — Boundary labels form one column per side, filled after the search

* Status: accepted
* Date: 2026-10-17
* Area: Candidates, leaders and costs
* Affects: spec §6.6, §7, §10.3
* Amends: [ADR 0019](0019-visual-quality-defaults.md) (boundary leaders near their start)

## Context
Boundary labels (spec §6.6) are meant to stack along a side, as in technical illustrations
or line charts whose line ends crowd. The engine generated each item's boundary candidates
at its anchor's height and up to three label heights above and below it, and after the
search re-stacked only the labels already placed. A crowd of anchors could therefore never
get more boundary labels than fit around its own height: of the 62 line ends of the
benchmark's life-expectancy chart (scenario 09, `adjacent` and `boundary` models, labels on
the right) 23 got a label — 8 at the canvas edge, the others as fan, adjacent and distant
labels — and the right margin below them stayed empty. Ten line ends 4 px apart got none at
all: next to an end a label overlaps the neighbouring marks, a boundary label at an end's
height leaves no room for its neighbours, and a boundary leader leaving the crowd passes
the neighbouring marks closer than `leaders.clearance`.

Two further details stood in the way. Labels on the right side were right-aligned at the
canvas edge, so their ports, and the ends of their leaders, were ragged: the matching of
items to slots by total leader length measured to the edge, not to the ports, and could
not keep the leaders from crossing. And only fan leaders (spec §6.8) were allowed to pass
the marks next to their start.

## Decision
* **One column per side.** The labels on a side align on the column's line facing the
  picture (the widest label's width from the margin) and are matched to the slots by the
  length of their actual leaders, to ports on that line, which keeps straight leaders from
  crossing. The re-stacking of the placed boundary labels uses this layout.
* **Filling.** After the re-stacking, items without a label that may take a boundary label
  join their side's column one at a time, in priority order, when the column laid out
  again with them stays feasible and free. A placed label in the way of a member, whose
  item may take a boundary label and whose label stands on the column's side of its
  anchor, moves into the column too (it keeps a label). The priority rule, the label
  budgets and the work limit of the fans apply.
* **Boundary leaders leave crowds like fan leaders:** a mark closer than the clearance to
  the leader's start they must only not cross. Other leaders keep the clearance: giving
  every leader the same exemption (a leader keeps from a mark no more than that mark keeps
  from its own) placed 116 more labels in the 55 static problems of the benchmark (+1 %),
  but leaders touched marks 662 times instead of 41, as in the relaxable rule ADR 0019
  rejected.

## Alternatives considered

*Right-aligned columns* (labels flush with the canvas edge, as before, matched by the
length of the leaders to their ragged ports): with the fill, 28 instead of 35 labels on
the life-expectancy chart and 8 instead of 10 in the conformance case, as leaders to
ragged ports come too close to each other.

## Consequences
In the 55 static problems of the benchmark only the three with boundary labels change; the
other 52 give the same placements. The life-expectancy chart places 35 of its 62 labels
(was 23), all in one column at the right; the 27 left out are ends of the densest band,
whose leaders would come closer than the clearance to each other. In the fundus photograph
5 of the 10 labels are boundary labels (was 2); the portrait keeps its layout, its leaders
shorter (90th percentile 21.5 → 17.1 em) as the columns align toward the picture. The new
conformance case `boundary-column` (ten ends 4 px apart) places all ten (was none).
Boundary leaders have no length limit, as before (spec §7 now says so).
