# 0028 — Labels touch their own mark and keep a margin from everything else

* Status: accepted
* Date: 2026-10-17
* Area: Candidates, leaders and costs
* Affects: spec §4.4, §6.6, §6.7, §6.8; `defaults.margin`, `placement.offset`
* Amends: [ADR 0016](0016-warm-start-and-stability.md),
  [ADR 0025](0025-warm-starts-follow-anchors.md),
  [ADR 0027](0027-nudges-kept-leaders-near-moves.md) (warm-start candidates need half the
  margin)

## Context
An adjacent label sat 2 px (`placement.offset`) from its own mark, but nothing kept it
away from the rest: hard `labels` and `items` only forbade overlaps, so labels touched
each other and other items' marks. On six test scenes (Les Misérables in the force layout
and dragged, 400 European airports, 100 software metrics, Cora, the 40 cities of the
priority tutorial) 38–43 % of the labels (cora 7 %, the cities 68 %) came within 0.25 em
of another label, and 2–12 % of the adjacent labels were closer to another item's mark
than to their own. A label is read as belonging to what it is closest to: it should be
clearly nearer its own mark than anything else.

The soft terms could not do this. Four times the ambiguity weight left the labels as
close together as before (38–73 % within 0.25 em, cora 5 %) and still 1–9 % ambiguous; a buffer
ring of 0.5 em that weighs other labels and marks 4 each spread the labels (2–29 %) but
pushed them against other marks instead (ambiguous on the cities 12 → 21 %, the dragged
graph 6 → 10 %): where space is short, a cost trades against other costs.

## Decision
* **Margin.** `defaults.margin` (0.2 em) is a hard distance: with hard `labels`, two
  label boxes keep the larger margin of their items apart; with hard `items`, a label
  keeps its margin from other items' marks (spec §4.4). Boxes exactly the margin apart,
  up to `EPS`, do not conflict, so that stacked columns can use it as their gap: boundary
  and fan columns stack with the larger of `placement.boundary.gap` and the margin.
* **Offset 1 px** (was 2): the labels come closer to their own mark.
* **Near marks.** From another mark the label keeps at most as much as that mark keeps
  from the bounding box of its own mark. Without that, items on top of or right next to
  each other could not be labeled at all: three points at the same place got no label
  (conformance case `priority-strict`).
* **Staying needs half.** Warm-start candidates (the previous box at any size, and its
  nudges, ADR 0027) need half the margin: from each other and from other marks. A label
  takes a new place only with the whole margin and leaves its place only when its
  neighbours come closer than half of it. Without this rule a tight fit breaks with every
  small move: on seven warm-started sequences (Les Misérables in three force layouts and
  four drags, with the font classes of the demo) the margin raised the mean displacement
  from 2.56 to 2.82 px and the jumps from 5.0 to 5.4 % of the labels per solve.

## Alternatives considered

Measured on the six scenes (placed labels, share within 0.25 em of another label, share of
ambiguous adjacent labels):

| margin, offset | placed | within 0.25 em | ambiguous |
|---|---|---|---|
| 0, 2 px (before) | 77, 73, 376, 60, 149, 34 | 0.07–0.68 | 0.020–0.118 |
| 0.1 em, 1 px | 77, 74, 370, 60, 149, 32 | 0.07–0.53 | 0–0.017 |
| **0.2 em, 1 px** | 76, 70, 364, 59, 149, 29 | 0.01–0.21 | 0–0.003 |
| 0.2 em, 2 px | 76, 70, 365, 58, 147, 29 | 0.01–0.14 | 0–0.029 |
| 0.3 em, 1 px | 76, 69, 362, 57, 147, 27 | 0 | 0–0.003 |
| 0.4 em, 1 px | 75, 68, 354, 56, 147, 26 | 0 | 0–0.015 |

* *0.1 em*: half the cities' labels still crowd each other. *0.3 and 0.4 em*: more labels
  lost for little visible gain over 0.2 em (padding adds 0.15 em on each side of the
  text). *Offset 2 px*: labels further from their mark and more often ambiguous.
* *No margin at all for warm-start labels* (instead of half): slightly steadier (2.38 px)
  but kept labels drift until they touch (0.4 pairs per frame).

## Consequences
On the six scenes, old → new: labels are 0.10–0.11 em from their own mark (was 0.20–0.23;
the cities 0.14 → 0.07), within 0.25 em of another label for 1–14 % of the labels (was
7–43 %; the cities 68 → 21 %) and of another mark for 0–3 % (was 3–10 %; the cities
18 → 14 %, the near-mark rule), ambiguous for at most 0.3 % (was 2–12 %). They cost
labels where space is short: 1–4 % (lesmis, airports, metrics; cora none), 15 % of the
40 cities, 26 % on the densest conformance problem (80 random points on 300 × 200 px,
50 → 37). In the cities, five items can no longer be labeled anywhere
(`no_feasible_candidate`, blocked by `items`): next to them a label comes within the
margin of another city.

Moving labels, warm-started with the previous result, before → after:

* The seven sequences with the demo's font classes: mean displacement 2.56 → 2.45 px,
  jumps 5.0 → 4.8 % per solve, labels per frame 73.0 → 71.4; no two labels come closer
  than 0.1 em (before 9.4 pairs per frame), 4.0 pairs per frame between 0.1 and 0.2 em
  (before 16.1 closer than 0.2 em). Labels are added and removed more often (0.58 → 0.75
  per solve in the solves in which the median node moves less than 1 px, 4.0 → 4.6 in the
  others), as fewer fit.
* The stability sequences of the benchmark (scenario 11, default font): the running force
  layout 2.28 → 2.57 px, jumps 5.5 → 5.1 %; the dragged node 2.32 → 2.33 px, 4.8 → 4.8 %;
  pan and zoom over 1,000 airports 2.79 → 3.43 px, 7.9 → 9.1 %, over 3,000 3.46 → 3.69 px,
  10.1 → 10.4 %. Labels per frame drop by 1.5, 1.9, 4.6 and 8.5 %; leadered labels per
  frame rise from 3.5, 4.1, 23 and 49 to 5.6, 8.1, 34 and 66, and labels with leaders move
  more. It is the spacing between labels that costs where labels are dense: without any
  margin from marks the pan and zoom over 1,000 airports still moves 3.24 px.
* The 40 cities of the interactive-maps tutorial under pan and zoom: 13.1 px per frame
  instead of 6.8 (margin 0.1 em: 6.9 px; no margin: 4.5 px).

`defaults.margin: 0` with `placement.offset: 2` gives the previous results exactly (the
conformance problem `strict-repair`, found by a search over random problems, keeps them).
Conformance cases with geometry that depended on the old values were adjusted
(`explain-blocked-by-labels`, `fan-always`, `fan-max-labels`, `font-class-shrink-floor`,
`warm-start-nudge`).
