# 0056 — The benchmark measures whose a label is, what it hides and how close labels stand

* Status: accepted (`bench/eval/association.py`; `bench/eval/metrics.py`: stub counts and the removal test; `bench/common/text.py`: ink boxes and line alignment; report columns; `bench/README.md`)
* Date: 2026-10-24

## Context
The work of ADR 0050–0055 started from looking at the economies chart, not from the
benchmark, and the benchmark could not have shown what was wrong there:

* **Ambiguity was all or nothing.** `ambiguity.rate` counted a label only when another
  item's shape was *strictly* nearer to it than its own. North Korea's label, 1.0 px from
  its bubble and 1.4 px from Cameroon's, and Norway's, under Singapore's bubble with only
  its corner at its own (1.0 against 2.2 px), passed.
* **Only items competed.** The unlabelled points of a chart given as obstacle layers —
  the other classes of the software metrics, the other genes of the volcano plot, the
  airports without a label — never counted, though a reader takes a label beside such a
  point for its label as readily.
* **Hiding data was measured per avoidance setting.** A label over another item's mark was
  a hard violation only with `items` hard; over the circles of a soft class it counted in
  `labels_over` (touching, not hiding), over the marks of less important items (the
  `lower_items` of the `map` preset) nowhere.
* **Labels standing close together passed every metric**, 0.2 em apart or 0.01 em.
* **The benchmark measured boxes the old way.** Its text measurement (for the baselines and
  the removal test) kept the ascender-to-descender boxes that ADR 0052 replaced: over the
  1,925 text labels of the quick suite the baselines placed boxes 27 % taller than the
  engine's at the median (up to 64 % for labels without descenders), and
  `test_measured_sizes_match_the_conformance_case` failed. The removal test (priority
  inversions) still kept labels only the margin apart and knew nothing of the clear-nearest
  rule, so it could count an item the engine rightly left out as an inversion.

## Decision
The evaluator gets a module `bench/eval/association.py`, measured for every solver:

* **Data points** are the marks of point items, labeled or not, and the circles of every
  vector class that labels do not ignore. A circle within 0.5 px of an item's point is that
  item's own mark.
* **Clarity.** For a label without a leader (internal labels aside), the margin
  `m = d(other point, box) − d(own shape, box)` (signed distances) over the data points that
  are neither its own nor of its group, in em of the label's font. A label is
  *misattributed* below 0, *unclear* below 0.2 em (the label margin, which the engine's
  rule asks for) and *weak* below 0.5 em; each threshold is capped by the distance between
  the two points, so that points closer than 0.5 px are one spot, as in the engine's rule
  (spec §4.4). The counts are split by whether an item's mark or only background points
  made a label unclear. A point that lies entirely inside the label box is *hidden*, not a
  competitor: under the opaque box no reader takes it for the label's point (the next
  metric counts it); one partly under the box's edge competes. A label with a leader is
  *leadered unclear* when another data point comes within 0.2 em of its box: the leader
  says whose it is, its place says another point's.
* **Points covered.** The data points that a label other than their own overlaps (the box
  shrunk by 0.5 px, as the hard tests), whatever the avoidance settings say, and those
  entirely inside a label box (`hidden`); the labels that cover any.
* **Label spacing.** The gap from each label to the nearest other label in em of the
  larger font of the two: labels closer than 0.4 em (the engine's default spacing) and
  pairs closer than 0.2 em (the margin). Labels exactly at a threshold, up to 0.001 px of
  rounding, pass, as the stacked labels of columns and fans.
* **Stubs** are counted (`leaders.stubs`, `stub_rate`).
* **The benchmark measures as the engine does.** Its text measurement takes the ink of the
  glyph outlines (from `glyf`, the same bounds as the engine's `LAvb` table): a text box
  spans from the ink top of the first line to the ink bottom of the last, the lines
  aligned per `align` (default `center`, ADR 0055); composite parts keep the ascent and
  descent, as in the engine. The baselines get the engine's boxes. The removal test keeps
  the label gap (`defaults.spacing`, twice the margin unless set) between labels, and with
  `placement.own_nearest` a candidate counts as free only when it is clearly nearer to its
  own mark than to any mark it may not cover.
* The report shows the unclear rate, the points covered and the labels close in the
  per-scenario tables and in the summary per solver; every new summary key is a metric of
  the regression check of the release gate.

The thresholds are the engine's defaults (margin 0.2 em, spacing 0.4 em): every labeler is
measured by the picture a reader sees, not by its own settings.

## Consequences
The quick suite (11 problems, 2026-10-24, default budgets), run with the engine of this
branch (`rust`), the engine of the main branch before ADR 0050 (`rust-main`) and every
baseline; totals over the 9 problems every solver ran (adjustText cannot run the Monaco
map and the 1,206-item priority problem):

| solver | placed | usable | unclear | by items / background | points covered (items) | labels close |
|---|---:|---:|---:|---:|---:|---:|
| rust | 631 | 631 | 152 (24.1 %) | 48 / 104 | 395 (34) | 0 |
| rust-main | 617 | 617 | 182 (29.5 %) | 72 / 110 | 507 (34) | 136 (22.0 %) |
| textalloc | 627 | 598 | 215 (34.3 %) | 121 / 94 | 265 (0) | 93 (14.8 %) |
| adjustText | 719 | 560 | 179 (24.9 %) | 104 / 75 | 620 (137) | 269 (37.4 %) |
| ggrepel | 666 | 573 | 238 (35.7 %) | 146 / 92 | 451 (60) | 126 (18.9 %) |
| vega-label | 554 | 553 | 224 (40.4 %) | 108 / 116 | 250 (1) | 66 (11.9 %) |
| d3fc | 490 | 446 | 183 (37.3 %) | 108 / 75 | 322 (94) | 0 |
| ECharts | 516 | 419 | 230 (44.6 %) | 168 / 62 | 611 (203) | 137 (26.6 %) |
| D3-Labeler | 719 | 588 | 222 (30.9 %) | 137 / 85 | 656 (69) | 392 (54.5 %) |

* The airports map dominates the totals: 144 of the engine's 152 unclear labels stand
  among its 2,917 unlabelled airports, where every solver leaves half or more of its labels
  unclear (the engine 63 %, textalloc 66 %, ggrepel 68 %, vega-label 92 %). On the other 8
  problems the engine has 8 unclear labels of 404 (2.0 %), the main branch 22 (5.5 %), the
  other tools and the greedy baseline 9–20 % (naive: 31 %); no engine label stands closer
  than 0.4 em to another (main: 70, 17 %; the others up to 43 %, naive 48 %).
* The old `ambiguity.rate` saw 47 of the engine's labels; `misattributed` sees 125, as it
  counts background points and points partly under a label.
* **What the engine does not see yet.** Its clear-nearest rule (ADR 0054) protects only the
  marks a label may not cover: 104 of its 152 unclear labels stand by background points
  (the airports, the other classes of the software metrics), and the other 48 by the marks
  of less important items, which the `map` preset lets labels cover (`lower_items: 10`,
  ADR 0040). Over all 11 problems every one of the engine's 91 labels made unclear by an
  item's mark is of that kind (airports 44, Monaco 43, stress 4): 42 lie partly on the mark
  of an unlabeled item, 16 beside one, and 33 beside the mark of an item labeled elsewhere,
  whose own label then competes with them. Extending the rule to background points and to
  the less important marks a label does not hide is the next engine change these numbers
  suggest.
* Stubs are `off` by default (ADR 0050), so no problem of the benchmark uses them and
  `stub_rate` is 0. With `placement.stubs: "auto"` the engine places 45 stubs over the
  quick problems and has 266 weak labels instead of 308 (unclear: 188 instead of 195),
  placing 878 labels instead of 880.
* The removal test of the old evaluator counted one inversion of the engine (TLS on the
  airports map): its only free position was 4.35 px from Madrid's label, beyond the margin
  but within the engine's spacing. It counts none now.
* Fan labels stacked exactly 0.4 em apart read 3.5999999999999943 px apart: the spacing
  counts ties within 0.001 px as kept.
* The three measures add at most 0.1 s to the evaluation of a quick problem (the volcano
  plot, with 16,406 data points), next to nothing on the others.
* The new summary keys have no values in earlier `results.json` files: the release gate's
  regression check starts comparing them with the next release.
