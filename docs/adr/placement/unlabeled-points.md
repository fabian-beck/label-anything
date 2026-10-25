# Unlabeled points

A label beside its mark is never nearer to an unlabeled point than to its own mark, by the
margin of the own-mark rule, unless it hides the point entirely; the rule holds for an item
when some place beside its mark can keep it, and `placement.own_nearest: "items"` keeps it to
items' marks.

## Context
The own-mark rule (ADR placement/margin) kept a label clearly nearer to its own mark than to
the mark of any other item, but the unlabeled points of a chart, given as obstacles, never
competed: covering them cost a weight, standing next to them nothing. The benchmark counts
them as data points (ADR project/benchmark-measures), and they held most of the engine's
unclear labels: 142 of 148 on the 300-airport map.

Mumtaz et al. (*Label Placement for Outliers in Scatterplots*, EuroVis 2019) treat the
unlabeled points of an outlier plot as obstacles that labels must keep clear of. Their four
figures, reconstructed as benchmark scenario 13 with their method as the baseline
`mumtaz2019`, showed the difference: 15 of the engine's 93 labels stood nearer to another data
point than to their own, against 3 of 96 in the paper's published layouts and 3 by the
reimplementation. A higher weight for hiding points, the paper's outward position order, a
buffer ring around labels and softer forms of the rule (below) left most of them.

## Decision
- **The rule**: an adjacent or slider label, with or without a stub, is infeasible when an
  unlabeled point comes nearer to its box than its own mark plus `s`, the `s` of the own-mark
  rule: the margin without a stub, at most the distance between the point's centre and the
  own mark's reference point; 0 with a stub. Labels on distant leaders and internal labels are
  exempt, as before.
- **Unlabeled points** are the discs of vector layers (`points`, `circles`) and the closed
  shapes of class `points` (an SVG background's circles and small markers under the presets'
  rules), of classes labels do not ignore, whose centre lies at least 0.5 px from every item's
  reference point: a point drawn under an item's mark is that mark.
- **Hidden points do not compete**: a point entirely inside the label box is hidden; what that
  costs is its class's weight. A label may hide a point or keep clear of it, not graze it.
- **Only where it can be met**: the rule holds for an item when one of the 8 fixed positions
  (spec §6.1) of its first variant keeps clear of the unlabeled points by it. In a field of
  points so dense that none does, no place beside the mark could: the strict rule put every
  label of 200 among 10,000 random points on a leader and dropped 32 of them, and the labels
  on leaders sat in the same field. Such an item's labels follow the rule for items' marks.
- **The blocker** reported for such a candidate is the point's class.
- **`placement.own_nearest`** takes `true` (default: items and unlabeled points), `"items"`
  (items' marks only, the rule before) or `false`. `"items"` is for charts whose labeled marks
  look unlike the other points, so that no reader takes a label for theirs.

## Consequences
Over the benchmark (66 problems, 87,403 items, solved without a clock, so that only the rule
differs), labels nearer to another data point than their own drop from 4,001 to 3,568 and
unclear labels from 4,986 to 4,385; those unclear because of an unlabeled point from 795 to
249. 36 fewer labels are placed (16,000 of 16,036), 172 more take leaders (4,801), and 88
more labels on leaders end within 0.2 em of a point (1,501). On the reconstructed figures 1 of
94 labels stands nearer to another point (15 of 93 before); on the airport maps 658 instead of
985, 1.1 % fewer labels. Dense fields keep their results: 2,000 labels among 100,000 points
(`bench/perf`) are placed as before, 200 among 10,000 with two leaders more. The leader
tutorial's 12 asteroids among 60 dots place 11 labels with straight leaders (12 before) and 10
with orthogonal ones (9 before). The release gate's allow-list names the configurations whose
measures this moves by more than 2 %.

Each item probes its 8 fixed positions once per solve, and a candidate beside a mark makes
one more query of the primitive index, which stops at the first point too near. The
performance problems (`bench/perf`, steady state) take 4 % longer: 228 instead of 220 ms for
2,000 labels among 100,000 points, 14.3 instead of 13.7 ms for 200 among 10,000; in
TypeScript, which builds no index of the points there otherwise, 40 instead of 36 ms.
Elsewhere in the benchmark runtimes change within noise, except where labels move onto
leaders (the 150-node Cora graph: +5 ms). The labels the rule moves exposed an insertion of
the local search that could invert priorities with weighted omission, now undone (ADR
solver/search).

## Alternatives
- **The rule for every item** (no probe): unclear labels caused by unlabeled points fell from
  795 to 5, but in dense fields every label moved onto a leader (200 among 10,000 points: 164
  placed instead of 196, all on leaders, 26 % slower).
- **Only "not nearer"** (no margin, `s = 0`): 59 % of the labels unclear because of a point
  stayed.
- **A soft term**, the ambiguity cost extended to unlabeled points: half of them stayed.
- **The margin for labels on leaders too**: no more labels on leaders near a point, but 1.2 %
  of all labels lost (13 % on the 300-airport map), and partly covering a point became all
  but hard.
- **A higher weight for hiding points** in the `scatter` preset (0.3 → 1.0 per em²): 30 %
  fewer hidden points on the scatterplot scenarios for one label fewer, but no clearer labels;
  a separate question.
- **The paper's outward position order** (labels on the side away from the chart centre):
  no clearer labels, and more hidden points on two of the four figures.
