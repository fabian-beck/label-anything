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
  cell follows the smallest font) and the candidates. The `shrink` ladder step starts from
  the class size.
* `placements[].priority.font_class` reports the class.

Considered and rejected:
* *Sizes set by the host*: two solves, or a second implementation of the priority function.
* *Sizes continuous in the score* (word-cloud style): no visible hierarchy, label sizes
  that are hard to predict; a host can still set per-item sizes for that.
* *Class boundaries at score thresholds*: scores depend on the terms' normalization; ranks
  are what the priority function promises.
* *Priorities recomputed after scaling*: circular through the `label_size` term.
* *Scaling icons and boxes with the class*: classes are about type; a host sizes its icons.

## Consequences
Scenarios 01–07 of the benchmark opt in with two sets (`bench/common/scenario.py`): charts
with room to spare (volcano, embeddings, node-link) give the top 5 % of their labels bold
type at 1.3 × and the next 20 % 1.1 ×; dense charts and maps (software metrics, gapminder,
airports, Monaco) the top 5 % bold at 1.25 × and the rest 0.9 ×. Against the same
problems without classes (deterministic solves, the engine otherwise unchanged):

* placed 3 579 → 3 775 (+196), 0 hard violations and 0 priority inversions in both: world
  airports 920 → 1 029 of 3 000 and 531 → 566 of 1 000, European airports 375 → 381, Monaco
  209 → 219 (pins) and 231 → 237, React Native classes 61 → 67 of 100, gapminder 1955 56 → 58,
  Cora 148 → 149; the volcano plots and embeddings place what they placed before.
  `placed_weighted` rises in every changed problem (world airports 0.320 → 0.350, React
  Native 0.689 → 0.734). Shrunk labels: React Native 26 → 16 %, Monaco 15.6 → 13.1 %.
* Larger top labels need room: the ambiguity rate rises in some problems (software metrics
  30: 0.10 → 0.13, gapminder 1955: 0.20 → 0.24, world airports: 0.37 → 0.39) and falls in
  others (gapminder 2005: 0.42 → 0.31, Monaco: 0.21 → 0.16); the mean position rank of React
  Native rises 2.63 → 3.28; leader lengths in em rise where the rest is smaller (gapminder
  p90 5.8 → 8.0 em). In the Monaco pins a POI that has a near-duplicate of equal key at the
  same spot gives way to it, so NDCG@k drops 0.967 → 0.902.
* The evaluator applies the classes with the result's ranks (with the reference priority
  for the baselines, whose labels get the class sizes), so a class size is not counted as
  shrunk. The release-gate allow list names this ADR for the metric changes above.
* Conformance: `font-classes` (sizes, weights, classes and boxes of four labels, the
  offset in em following the class) and its parity fixture.
