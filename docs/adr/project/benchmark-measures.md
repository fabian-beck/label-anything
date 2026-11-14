# Benchmark measures

The benchmark measures for every solver whose a label is, what it hides and how close
labels stand, with the engine's defaults as thresholds, and measures text as the engine
does.

## Context
The label decisions of 2026-10 (ADR placement/stubs, placement/margin, text/measurement)
started from the economies chart, not from the benchmark, which could not have shown what
was wrong there. Ambiguity counted a label only when another item's shape was strictly
nearer to it than its own. The unlabeled points of a chart given as obstacles never
competed. Covering a mark counted only where the avoidance settings made it a violation.
Labels 0.01 em apart passed every measure. And the benchmark's own text boxes, for the
baselines and the removal test, spanned the font's ascender and descender: 27 % taller
than the engine's at the median.

The near crossings and parallel leaders of a result (`bench/eval/visual.py`) depended on
the order of its items, as an audit found in 2026-11. The index of the leaders kept one
box per leader, that of the segment added last, so a leader with a bend or an underline
was missed where it was the later leader of a pair and the other leader came close to
another of its segments. Parallel leaders were looked for within 1 em of the earlier
leader's font, although the measure takes the larger font of the two. Two items, one
straight leader ending 3 px from the first segment of an elbow leader, had one near
crossing in one order and none in the other; the hard rule `leader_near` counted the pair
in both.

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
- **Leader pairs**, the near crossings and the parallel leaders, are counted whatever the
  order of the items: a leader is indexed once, by the box around all its segments and
  its underline, and pairs are looked for within the largest font size of the result (at
  least 4 px), as for the hard rules `leader_near` and `leader_angle`.
- **Measured as the engine does**: text boxes fit the ink (from the outlines' `glyf`
  bounds) with the lines aligned per `align`, and the removal test keeps the engine's
  label spacing and own-mark rule.
- The report and the regression check of the release gate include the new measures, and
  the images of the report mark every instance where it happens, with the
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

Counting every leader pair (2026-11-14) can only raise the near crossings and the parallel
leaders, and only for results with bent or underlined leaders or with labels of different
font sizes. Values measured before are lower bounds, among them the near crossings quoted
in ADR placement/leaders.
