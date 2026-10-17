# 0021 — Distant labels keep to the sides of an explicit position order

* Status: accepted (behaviour change; spec §6.4)
* Date: 2026-10-17

## Context
The line charts of the benchmark allow only positions to the right of the series ends
(`09-line-end-labels/unemployment-14-vector`: `right`, `top-right`, `bottom-right`;
`life-62-boundary`: `right` and a stack in the right margin). The ladder's `distant` step
generated distant candidates in every direction, so where the ends crowd, labels went to the
left, onto the line bundle, with leaders across it: in the unemployment chart 4 labels
(36 em of line length under labels, leaders touching other lines 29 times), in the life
expectancy chart 8 (80 em, 30 touches). The renderings show exactly what the problem's
position order was meant to prevent.

## Decision
When an item's `position_order` lists fewer than the 8 fixed positions, its distant
candidates keep to the listed sides: only rays, and free-space seeds seen from the
reference point, within 22.5° of a listed position's direction are generated
(`u·v ≥ cos 22.5° · |u|·|v|` less 10⁻⁹, so that a ray between two octants belongs to both).
The default orders (`perceptual`, `cartographic`) list all 8 positions and change nothing.

Considered and rejected:
* *A soft cost for distant labels on unlisted sides*: soft costs never prevent a placement
  (the objective is lexicographic, ADR 0019); a label whose only room is on the left would
  still go there.
* *±45° per listed position*: `["right"]` would allow straight up and down, where half of
  the label box lies over the lines left of the end.
* *Changing the two benchmark problems* (no `distant` step): users who set a position order
  would still get labels on the other side.

## Consequences
Full suite, deterministic solves, default budgets: line length hidden by labels 2,856 →
2,735 em (the two line charts 116 → 0 em), leader–line touches 1,107 → 1,049. The
unemployment chart keeps 10 of 14 labels (was 14), life expectancy 22 of 62 (was 27): the
others are `omitted_by_priority`, with no room right of the ends beside the labels already
there (the `exact` strategy also places 10 of 14 there). No other problem of the benchmark
has an explicit position order with fewer than 8 positions. The conformance case
`distant-keeps-sides` checks that an item restricted to `right` is omitted rather than
labeled on the left, and is labeled up-right when there is room.
