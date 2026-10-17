# 0023 — Font classes: type size by importance

* Status: accepted (new option, off by default; spec §9.4)
* Date: 2026-10-17

## Context
The priority function (§9) decides which labels are shown, but every shown label looks
the same: the capital and the village, the hub airport and the airstrip, the most
significant gene and the borderline one. Hand-made maps and charts give the most important
labels larger or bolder type — a few classes of type size, the cartographic convention.
A host can set `label.font.size` per item, but the importance order is the engine's (terms,
normalization, tiers, coverage, ties): the host would have to solve once to read the ranks
and solve again with the sizes (the prototype of this ADR did that), or re-implement the
priority function.

## Decision
`priority.font_classes` (spec §9.4), a list of classes `{first, scale, weight}`:

* **By rank.** Classes take consecutive stretches of the total order: each ends at its
  `first` — a number of items or a share (`"5%"`), cumulative — the last may take the rest;
  items after the last class keep their size. A group label takes the class of its
  best-ranked member.
* **The type scales.** `scale` multiplies the font size of the item and of all texts of its
  label, host-measured text sizes and wrap widths (lines break as at the nominal size, like
  the `shrink` step); `weight` replaces the font weight. Lengths in em follow the scaled
  size (offset, padding, distances, leader lengths and clearance); lengths in px, icons
  and boxes keep their size.
* **Priorities of the nominal sizes.** The priorities are computed first, from the nominal
  labels, then the labels are scaled and measured again, before the obstacles' grid (whose
  cell follows the smallest font) and the candidates.
* **Shrinking stops at the nominal floor.** The `shrink` ladder step starts from the class
  size, but `degrade_options.min_scale` still bounds the size relative to the size before a
  smaller class (factors down to `min_scale / scale` for `scale < 1`): the classes may make
  text smaller, the ladder must not make it smaller than it could without them.
* `placements[].priority.font_class` reports the class.

Considered and rejected:
* *Sizes set by the host*: two solves, or a second implementation of the priority function.
* *Sizes continuous in the score* (word-cloud style): no visible hierarchy, label sizes
  that are hard to predict; a host can still set per-item sizes for that.
* *Class boundaries at score thresholds*: scores depend on the terms' normalization; ranks
  are what the priority function promises.
* *Priorities recomputed after scaling*: circular through the `label_size` term.
* *Scaling icons and boxes with the class*: classes are about type; a host sizes its icons.
* *Shrinking from the class size down to `min_scale` of it*: with a rest class of 0.9 the
  benchmark placed 3 775 instead of 3 579 labels, but by shrinking labels to 0.65 of their
  nominal size (5.9 px on the 9 px airport maps); the gain was the ladder's, not the
  classes'.

## Consequences
Scenarios 01–07 of the benchmark opt in with two sets (`bench/common/scenario.py`): charts
with room to spare (volcano, embeddings, node-link) give the top 5 % of their labels bold
type at 1.3 × and the next 20 % 1.1 ×; dense charts and maps (software metrics, gapminder,
airports, Monaco) the top 5 % bold at 1.25 × and the rest 0.9 ×. Against the same
problems without classes (deterministic solves, the engine otherwise unchanged):

* Placed 3 579 → 3 563 (−0.4 %), 0 hard violations and 0 priority inversions in both: the
  larger top labels cost a few labels in the densest maps (world airports 920 → 911 of
  3 000, 531 → 527 of 1 000; Monaco 231 → 228), the smaller rest wins a few elsewhere
  (gapminder 1955 56 → 57, European airports 375 → 376, Cora 148 → 149); the volcano plots
  and embeddings place what they placed before. The classes buy hierarchy, not labels.
* Fewer labels are shrunk by the ladder, because the floor now counts from the nominal
  size: React Native classes 26 → 7 %, world airports 14 → 7 % (1 000) and 22 → 13 %
  (3 000), Monaco 16 → 8 %, gapminder 6 → 0 %. The smallest text drawn rises from
  0.7225 to 0.765 of the nominal size.
* Ambiguity falls in most dense problems (gapminder 2005: 0.42 → 0.29, Monaco: 0.21 → 0.18,
  world airports 300: 0.23 → 0.18) and rises in some others (software metrics 30:
  0.10 → 0.14, gapminder 1955: 0.20 → 0.25, volcano 50: 0.08 → 0.10). NDCG@k falls where a
  large top label gives way to its equal-key neighbours (world airports 3 000: 0.818 →
  0.794; in the Monaco pins a POI with a near-duplicate of equal key at the same spot gives
  way to it: 0.967 → 0.895); leader lengths in em of the smaller labels rise (gapminder
  p90 5.8 → 8.0 em).
* The evaluator applies the classes with the result's ranks (with the reference priority
  for the baselines, whose labels get the class sizes), so a class size is not counted as
  shrunk. The release-gate allow list names this ADR for the metric changes above.
* Conformance: `font-classes` (sizes, weights, classes and boxes of four labels, the
  offset in em following the class) and `font-class-shrink-floor` (a label of a 0.9 class
  is not shrunk below 0.7 of its nominal size), with their parity fixtures.
