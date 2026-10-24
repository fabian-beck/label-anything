# Margin

A label touches its own mark and keeps a margin of 0.2 em from every other label and mark,
so it is clearly nearer its own mark than anything else.

## Context
A label is read as belonging to what it is closest to. With overlaps forbidden but nothing
more, labels touched each other and the marks of other items: on six test scenes 38–43 %
of the labels came within 0.25 em of another label, and 2–12 % of the adjacent labels were
closer to another item's mark than to their own. Soft costs could not fix it: where space
is short, a cost trades against other costs.

## Decision
- `defaults.margin` = 0.2 em is a hard distance: two labels keep the larger margin of
  their items apart, and a label keeps its margin from other items' marks. Boxes exactly
  the margin apart do not conflict, so columns stack at that gap.
- `placement.offset` = 1 px brings adjacent labels close to their own mark.
- From another mark a label keeps at most what that mark keeps from the bounding box of
  its own mark, so that items on top of or next to each other can still be labeled.
- Warm-start candidates need only half the margin (ADR motion/warm-starts).

## Consequences
On the six scenes, labels sit about 0.1 em from their own mark, at most 0.3 % of them are
ambiguous (2–12 % before), and 1–14 % of them come within 0.25 em of another label (7–43 %
before). Space costs labels where it is short: 1–4 % on the graphs, maps and charts, 15 %
on a crowded map of 40 cities. `defaults.margin: 0` with `placement.offset: 2` gives the
previous results.

## Alternatives
- **0.1 em**: half the labels of the city map still crowd each other.
- **0.3 or 0.4 em**: more labels lost for little visible gain, as label padding already
  adds 0.15 em around the text.
- **An offset of 2 px**: labels farther from their mark and more often ambiguous.
- **Stronger soft terms** (four times the ambiguity weight, a buffer ring): labels stayed
  as close, or were pushed against other marks.
