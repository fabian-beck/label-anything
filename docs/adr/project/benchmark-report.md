# Benchmark report

The benchmark's results are one interactive page in the structure of a research report:
an abstract, numbered chapters from the questions to the conclusion, and appendices. It
compares Label Anything with three other labelers unless the reader adds more.

## Context
The report was a page of tables, 17 metric columns for every labeler on every problem,
with small result images below them; the gallery was a separate page of figures with
captions, and three problems drawn by every tool. A reader saw numbers without pictures or
pictures without the other labelers, and nothing said where Label Anything stands overall.
Eleven labelers per problem made every comparison crowded, and a 1,800 px world map shown a
quarter of the page wide showed no label at all. A first merged page, ordered by kind of
data with the gallery's figures first, still read as a list of components: it stated no
questions, described the setup only in folded notes, and gave the findings as numbers
without sentences.

## Decision
- **One page**, `bench-report/index.html` (`bench/report_html.py`). `python -m
  bench.gallery` adds the gallery's figures and draws every problem of the run for every
  labeler as a vector image; the gallery's old address leads to the case studies.
- **The structure of a report**: an abstract with the main findings and the contents; 1
  introduction with five questions (validity, completeness, clarity, efficiency,
  stability); 2 benchmark design (methods, problems, measures, procedure); 3 results, an
  overview and one section per question; 4 results by problem; 5 case studies; 6
  limitations; 7 conclusion; appendices for release engineering, runtime measurements and
  reproduction. Tables and figures are numbered, and the text refers to them.
- **Findings computed from the run**: the abstract, the result sections and the conclusion
  state Label Anything's values, the range of the baselines and on how many problems it has
  the best value. The best value follows the rule of the tables (the best of all methods,
  better than their median), so that the text and the tables agree.
- **Results per question**: for each question a table of its measures with a row per
  problem, grouped by data type, and a column per method, coloured against the median of all
  methods on that problem; the last row counts the problems on which a method has the best
  value.
- **Results by problem**, grouped by data type — maps, charts, photographs and
  illustrations, embeddings and networks, priority, scale — show every problem with the
  labelers side by side: their images, their main numbers, and a table. The gallery's
  figures form the case studies; its figures of priority, stability and limits illustrate
  those sections.
- **Three labelers by default**: ggrepel, adjustText and textalloc, the most used tools of
  R and Python. The others join from the bar at the top, which keeps the choice in the
  address (`?vs=`) so a comparison can be shared.
- **The densest part at full size**: a canvas of more than 3.2 times 600 × 400 px shows the
  600 × 400 px window holding the most items, and the viewer opens on it. Flipping between
  labelers keeps the view, so the same spot can be compared.
- **Details on demand**: the other metric columns, the configuration of each baseline,
  further measures, the frames of every labeler and the engineering appendices are folded.
- **Concise academic texts**: declarative sentences; one term per concept (method,
  baseline, item, mark, placed, omitted); no idioms or instructions to the reader beyond
  the controls; every measure defined in one sentence.
- **Self-contained**: styles, script and data inline, Noto Sans next to the page, nothing
  from other servers; without JavaScript the page shows the default labelers and every
  column.

## Consequences
On the quick suite the page is 0.7 MB of HTML; the drawings of all 110 results add 43 MB
and 28 s to the CI job. The table colours and the measures' directions stay the same in
every chapter, whichever labelers are shown. A scenario that no data type names appears
under "Other problems" until one does. A run without the gallery still compares the
labelers, with the run's raster images, and has no case studies. Sentences generated from
the results must handle ties, zero counts and singulars; the tests cover them.

## Alternatives
- **Two linked pages, report and gallery**: the split this replaces.
- **Chapters by kind of data with the gallery's figures first**: the first merged page; no
  questions, no design section, findings only as numbers.
- **Every labeler by default**: eleven images per problem; the differences that matter drown.
- **The best baselines by default**: changes from run to run, and readers compare tools
  they know.
- **Colours relative to the labelers shown**: would change when one is added; against all
  labelers a colour keeps its meaning.
- **Hand-written findings**: go stale with every run; generated sentences state what the
  run measured.
- **A charting library or single-page application**: loads code from elsewhere or needs a
  build step; the page is written by the benchmark in Python and must open from a CI
  artifact.
