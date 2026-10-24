# Columns

Crowds get their labels in a column beside them with fanning leaders, and boundary labels
form one aligned column per side; both are built after the search.

## Context
Where anchors crowd, as at the ends of a line chart or in a dense cluster, adjacent
positions run out, and distant labels find few places once their leaders must keep the
clearance (ADR placement/leaders). Hand-made charts put such labels in a column beside the
crowd, in the crowd's order, with one leader each (excentric labeling, line-end columns).
The search cannot find a column: every candidate is one label, and a column only works
when its labels move together. Boundary labels had the same limit along the canvas sides,
each item's candidates standing near its own height, and their right-aligned labels left
ragged leader ends.

## Decision
- **Fans** (`placement.fan`, default `auto`): after the search, items left without a label
  seed crowds — anchors within half the label heights vertically and one em horizontally,
  up to 24 items. Their labels are stacked beside the crowd, on a side the seed's position
  order allows, far enough out that leaders are at most 45° steep.
- **Boundary columns**: the labels on a side align on the column's line facing the picture
  and are matched to their slots by the length of their actual leaders, which keeps
  straight leaders from crossing. After the search a side's labels are re-stacked as one
  column, then items without a label join it one at a time, in priority order, bringing
  labels in their way into the column.
- **Shared rules**: a column is applied only when it places more labels, keeps the label
  budgets, removes no label without placing it again and inverts no priority. Columns
  stack at the larger of `placement.boundary.gap` and the margin, keep every hard rule,
  and evaluate at most `max(20 000, 20 × n)` labels. None with `prefix` omission, after a
  cancellation or the time guard; no fans with the `angles` leader style.

## Consequences
Line charts gain most: the unemployment chart labels all 14 series ends instead of 10, the
life-expectancy chart 35 of 62 ends instead of 22, all in one column. Two-dimensional
scatter crowds get few columns, as their leaders would cross the marks around them.
Columns are rebuilt in every frame, so warm-started sequences move a few percent more. The
fan pass takes under 70 ms up to 5,000 items.

## Alternatives
- **Fan candidates in the search**: a column is a joint decision; one label's slot depends
  on the others.
- **A global "crowded" mode**: crowds are local, such as one bundle of line ends in an
  otherwise sparse chart; seeding from unlabeled items finds them wherever they are.
- **Right-aligned boundary columns**: leaders to ragged ports come too close to each other
  (28 instead of 35 labels in the life-expectancy chart).
- **Fans with `angles` leaders**: the diagonals from close ends run parallel and closer
  than the clearance; no fan formed in four test problems.
