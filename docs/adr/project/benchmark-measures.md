# Benchmark measures

The benchmark measures for every solver whose a label is, what it hides, how close labels
stand and how much clutter they add, with the engine's defaults as thresholds, and measures
text as the engine does.

## Context
The label decisions of 2026-10 (ADR placement/stubs, placement/margin, text/measurement)
started from the economies chart, not from the benchmark, which could not have shown what
was wrong there. Ambiguity counted a label only when another item's shape was strictly
nearer to it than its own. The unlabeled points of a chart given as obstacles never
competed. Covering a mark counted only where the avoidance settings made it a violation.
Labels 0.01 em apart passed every measure. And the benchmark's own text boxes, for the
baselines and the removal test, spanned the font's ascender and descender: 27 % taller
than the engine's at the median. Placing fewer labels to calm a picture (ADR
placement/aggressiveness) needs a measure of what more labels cost: the number of labels
and of leaders, and leader lengths, each tell one part.

## Decision
- **Data points** are the marks of point items, labeled or not, and the circles of every
  vector class labels do not ignore.
- **Clarity**: for a label without a leader, the margin by which its own mark is nearer
  than any other data point, in em: *misattributed* below 0, *unclear* below 0.2 em (the
  margin), *weak* below 0.5 em, each capped by the distance between the two points. A
  point entirely under the label is hidden, not a competitor. A label with a leader is
  unclear when another point comes within 0.2 em of its box.
- **Points covered**: data points under a label other than their own, whatever the
  avoidance settings, and those hidden entirely.
- **Label spacing**: labels nearer than 0.4 em to another, and pairs nearer than 0.2 em;
  ties within 0.001 px pass, as in stacked columns.
- **Stubs** are counted.
- **Clutter**: the edge density the labels and leaders add, from their geometry: the
  outline length of the glyphs of every placed text at its font size, twice the length of
  every leader and underline (the two edges of a stroke) and the perimeter of icon and box
  labels, per canvas pixel. Edge density predicts how complex a picture looks (Mack &
  Oliva 2004), visualizations too (Chu et al. 2025), and how clutter slows visual search
  as well as feature congestion and subband entropy do (Rosenholtz, Li & Nakano 2007;
  Henderson, Chanceaux & Smith 2009). Reported with the share of leaders and the edge
  length per label in em; for information, not in the release gate, since more labels add
  clutter.
- **Measured as the engine does**: text boxes fit the ink (from the outlines' `glyf`
  bounds) with the lines aligned per `align`, and the removal test keeps the engine's
  label spacing and own-mark rule.
- The report and the regression check of the release gate include the new measures, and
  the images of the report and the gallery mark every instance where it happens, with the
  conflicts: a reader sees what a number counts.

The thresholds are the engine's defaults: every labeler is judged by the picture a reader
sees, not by its own settings.

## Consequences
On the quick suite (2026-10-24, the 9 problems every solver runs), 23.4 % of Label
Anything's labels are unclear (29.5 % before the label decisions), those of the other tools
25–45 %, and none stands nearer than 0.4 em to another label (the other tools up to 54 %).
The 300-airport map holds 142 of the engine's 148 unclear labels, among 2,917 unlabeled
airports that its own-mark rule does not see; on the other 8 problems it has 1.5 %. The
measures add at most 0.1 s to the evaluation of a problem. Earlier results have no values
for them, so the release gate compares them from the next release on.

On 469 results of eight settings of the engine over the benchmark, the clutter measure
agrees with the Canny edge density of the rendered labels and leaders (Pearson r = 0.991;
0.993 for the changes between settings of one problem), which counts a leader as 2.5 times
its length against text outlines, close to the two edges assumed. The share of the canvas
the label boxes cover agrees less (r = 0.961), the number of labels much less (r = 0.601):
a long name or a leader adds more than a short label beside its mark. The 90th percentile
of the edge density in windows of 8 em agrees least (r = 0.840): taking leaders away
raises it where labels then stay in the crowd. The measure counts what labels add, not
what they hide, which `points` and `labels_over` count.
