# Coverage costs

Coverage costs count what a label hides in em², so a weight is the price of hiding one em²
of a class, whatever the label's size.

## Context
Coverage costs used to be fractions of the label: a 1 px line across a long label is a
small fraction of it, so covering data was cheaper than any alternative, and a long label
could hide more for the same cost than a short one. Labels lay on the lines of line charts
and on scatterplot points.

## Decision
- Labels pay `w · covered / em²` per class and leaders `w · covered_len / em` (likewise
  `canvas_edge`, soft `items` and the relaxed costs of `soft_overlap`). A weight is the
  cost of hiding one em² of its class; `weights.leader` = 1 costs as much as hiding one
  em² of weight 1.
- Internal labels of point items pay no soft class costs: their mark already hides what
  lies beneath it.
- The weights were recalibrated for em²: `avoid.label.ink` 0.1 and `avoid.leader.ink`
  0.05.
- The `illustration` preset, meant for callouts in the margins, weighs ink 1.0 for labels:
  an em² of the picture costs as much as one leader. At 0.15 every callout of the two
  benchmark illustrations sat on the photo, next to the region it names.

## Consequences
Over the benchmark, labels hide 18 % fewer points and 19 % less line length. User weights
tuned for fractions act 3–10 times stronger on typical labels: an old weight `w`
corresponds to about `w / area` with the label's area in em². In the illustrations most
callouts moved to the margins, while regions in the middle of a picture keep labels close
by.

## Alternatives
- **A higher ink weight for illustrations** (2 or more): a few more labels in the margins,
  with leaders across the whole picture.
- **Hard ink for labels**: a region in the middle of a picture without free space nearby
  could never be named.
