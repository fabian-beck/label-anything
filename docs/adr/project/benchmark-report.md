# Benchmark report

The benchmark's results are one interactive page that leads with pictures and a few
measures, compares Label Anything with three other labelers unless the reader adds more,
and folds the engineering details.

## Context
The report was a page of tables, 17 metric columns for every labeler on every problem,
with small result images below them; the gallery was a separate page of figures with
captions, and three problems drawn by every tool. A reader saw numbers without pictures or
pictures without the other labelers, and nothing said where Label Anything stands overall.
Eleven labelers per problem made every comparison crowded, and a 1,800 px world map shown a
quarter of the page wide showed no label at all.

## Decision
- **One page**, `bench-report/index.html` (`bench/report_html.py`). `python -m
  bench.gallery` adds the gallery's figures and draws every problem of the run for every
  labeler as a vector image; the gallery's old address leads to the page.
- **The top answers where Label Anything stands**: its headline numbers next to the range
  of the other labelers, then one strip per measure (usable labels, hard violations,
  unclear labels, points covered, labels too close, time) with every labeler as a dot,
  further right always better.
- **Chapters by kind of data** — maps, charts, photos and illustrations, embeddings and
  networks, priority, scale — hold the gallery's figures and then every problem of the run
  with the labelers side by side: their images, their main numbers, and a table coloured
  against the median of all labelers on that problem.
- **Three labelers by default**: ggrepel, adjustText and textalloc, the most used tools of
  R and Python. The others join from the bar at the top, which keeps the choice in the
  address (`?vs=`) so a comparison can be shared.
- **The densest part at full size**: a canvas of more than 3.2 times 600 × 400 px shows the
  600 × 400 px window holding the most items, and the viewer opens on it. Flipping between
  labelers keeps the view, so the same spot can be compared.
- **Details on demand**: the other metric columns, the engineering details (performance
  targets, release gates, runtime, implementation parity, changes against the previous
  release, the other labelers' methods), what the measures mean and how to read the
  images are folded away.
- **Self-contained**: styles, script and data inline, Noto Sans next to the page, nothing
  from other servers; without JavaScript the page shows the default labelers and every
  column.

## Consequences
On the quick suite the page is 0.7 MB of HTML; the drawings of all 110 results add 43 MB
and 28 s to the CI job. The table colours and the measures' directions stay the same in
every chapter, whichever labelers are shown. A scenario that no chapter names appears
under "More problems" until one does. A run without the gallery still compares the
labelers, with the run's raster images.

## Alternatives
- **Two linked pages, report and gallery**: the split this replaces.
- **Every labeler by default**: eleven images per problem; the differences that matter drown.
- **The best baselines by default**: changes from run to run, and readers compare tools
  they know.
- **Colours relative to the labelers shown**: would change when one is added; against all
  labelers a colour keeps its meaning.
- **A charting library or single-page application**: loads code from elsewhere or needs a
  build step; the page is written by the benchmark in Python and must open from a CI
  artifact.
