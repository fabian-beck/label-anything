# Baselines of the benchmark

Third-party label placement tools run on the same scenario problems as Label Anything and
scored by the same evaluator and renderer (brief §8.3). An adapter translates a problem into
the tool's native input, runs the tool and converts its output back into a `result.v1`
document; every emulation is written into the result's `warnings` (codes
`baseline_emulation` / `baseline_unsupported`) and shown in the report (≈ marks, tooltips).

| solver name | tool | pinned version | runs in | license | leaders | omits labels |
|---|---|---|---|---|---|---|
| `textalloc` | [textalloc](https://github.com/ckjellson/textalloc) `allocate` | 1.2.4 (matplotlib 3.11.2) | Python, in-process | MIT | connector lines | yes (`draw_all=False`) |
| `adjusttext` | [adjustText](https://github.com/Phlya/adjustText) `adjust_text` | 1.4.0 (matplotlib 3.11.2) | Python, in-process | MIT | arrows | never |
| `vega-label` | Vega's [`label` transform](https://vega.github.io/vega/docs/transforms/label/) (vega-label) | vega 6.4.0, vega-label 2.1.3, canvas 3.2.3 | Node ≥ 20, subprocess | BSD-3-Clause | none | yes (opacity 0) |
| `ggrepel` | [ggrepel](https://github.com/slowkow/ggrepel) `geom_text_repel` | ggrepel 0.9.5, ggplot2 3.4.4, R 4.3.3 | Rscript, subprocess | GPL-3 (tool only) | segments | yes (`max.overlaps`) |
| `d3fc` | [d3fc-label-layout](https://github.com/d3fc/d3fc/tree/master/packages/d3fc-label-layout) `layoutRemoveOverlaps(layoutGreedy())` | 7.0.4 (d3-array 3.2.4) | Node ≥ 20, subprocess | MIT | none | yes (hidden) |
| `echarts` | [Apache ECharts](https://echarts.apache.org/) scatter labels, `labelLayout.hideOverlap` | echarts 6.1.0 (zrender 6.1.0), server-side rendering | Node ≥ 20, subprocess | Apache-2.0 | none | yes (hidden) |
| `d3-labeler` | [D3-Labeler](https://github.com/tinker10/D3-Labeler) (simulated annealing) | `labeler.js` at commit `6de8670`, vendored (`vendor/d3-labeler`) | Node ≥ 20, subprocess | MIT | lines to the anchor | never |

`naive` and `greedy` (`bench/solvers/`) are the built-in reference baselines.

The first four tools avoid obstacles; d3fc, ECharts and D3-Labeler — the label layouts of
two widely used chart libraries and the classic simulated-annealing labeler of D3 — avoid
only other labels (D3-Labeler also the labeled anchors), which is how they are used.

## Installation and use

```sh
bench/.venv/bin/pip install -r bench/requirements.txt -r bench/baselines/requirements.txt  # textalloc, adjustText
npm ci --prefix bench/baselines                       # vega, vega-label, canvas (prebuilt binary)
sudo bench/baselines/install-r.sh                     # Ubuntu 24.04: R + r-cran-ggrepel/ggplot2/jsonlite, pinned
bench/baselines/install-r.sh --cran                   # elsewhere (R ≥ 4.1 installed): CRAN archive versions
bench/.venv/bin/python -m bench.baselines --list      # which toolchains are present

bench/.venv/bin/python bench/run.py --baselines --engine rust/target/release/label-anything
bench/.venv/bin/python bench/run.py --solver textalloc --solver vega-label --scenario 05
bench/.venv/bin/python -m bench.baselines ggrepel problem.json -o result.json      # one problem
```

A requested baseline whose toolchain is missing is skipped with a message (and listed in the
report); `--require-baselines` turns that into an error (CI). Baselines run once per problem
by default (`--baseline-runs`); their `stats.runtime_ms` is the tool call itself (allocate,
adjust_text, the label transform, `grid.force()`), the wall time also covers the adapter and,
for vega-label and ggrepel, starting Node or R. Every version is pinned:
`requirements.txt` (exact, transitive), `package.json` + `package-lock.json`, and
`install-r.sh` / `install-r.R` (Ubuntu 24.04 package versions or CRAN archive versions). The
adapters record the versions that actually ran in `stats.implementation`; ggrepel notes a
version that differs from the pins.

## What every adapter does the same way

**Coordinates.** Results are canvas px, y down, like every other solver. Each tool works in its
own space, mapped so that one tool unit is one canvas px:

| tool | space |
|---|---|
| textalloc, adjustText | matplotlib figure of exactly the canvas (`W/72 × H/72` in at 72 dpi), axes = the label area (canvas minus `canvas.padding`, or `canvas.region`), data limits = that area in canvas px with **y flipped** (`y_data = H − y`), so display px = data px. y is flipped in the data instead of inverting the axis because adjustText transforms object bounding boxes corner by corner. |
| vega-label | layout of the label area's size; coordinates = canvas px minus the area's origin (y down, as in Vega). |
| ggrepel | `png(type = "cairo")` device of `W × H` bigpts at `res = 288` (4 device px per canvas px), `theme_void()`, no margins, `coord_cartesian(0..W, 0..H, expand = FALSE)`: the panel is the canvas, data units are canvas px with y flipped. |

**Text measurement.** Every tool reserves exactly the problem's label box: `w × h` from the
spec §5 measurement (bundled Noto Sans, simple shaping with GPOS kerning, `ascent + descent`,
label padding), composite labels their full box. The tools measure text differently
(matplotlib: no GPOS kerning and a line height from the 'lp' glyphs; Vega: height = font size;
grid: string width × height of 'M'; none adds the label padding), so each adapter hands its
tool the box:

* matplotlib: the `Text` objects' `get_window_extent()` returns the box placed by the text's
  position and alignment (`mpl.fix_extent`); textalloc's own measuring call
  (`ax.text(x, y, s).get_window_extent()`) is answered the same way;
* vega-label: `textMetrics.width` (a supported customization point of vega-scenegraph, also
  used by vl-convert) returns the box width and the text mark's `fontSize` is the box height,
  which is all the transform reads;
* ggrepel: R measures the texts itself (Pango, Noto Sans); `box.padding` is the smallest value
  for which every ggrepel box (text extent + padding on each side) contains the label box
  centred on it — about 0.47 em, because grid's text height is the cap height. A label overlap
  the evaluator finds is therefore also an overlap of ggrepel's own, larger boxes.

The fonts are still registered: Noto Sans from `fonts/` with matplotlib (`font_manager.addfont`,
`rcParams["font.family"]`) and for R through a private fontconfig file (`FONTCONFIG_FILE`;
`fc-match` is checked). Font sizes: matplotlib at 72 dpi takes `pt = px · 72 / 72 = px`; R
font sizes are bigpts (1 bigpt = 1 canvas px), ggplot2 `size = px / .pt`.

**Priority.** Items are handed over in the problem's priority order (the evaluator's reference
priority, `bench/eval/priority.py`): textalloc processes `text_list` in order
(`priority_strategy=None`), adjustText's crossing swaps follow input order, ggrepel's
`max.overlaps` keeps earlier rows, vega-label gets `sort` = the rank. `priority.budget.max_labels`
is emulated by handing over only the first *k* items. Results report that reference priority
in `placements[].priority`.

**Obstacles.** Every class the problem does not `ignore` for labels is an obstacle, plus every
item's mark (labels must not cover other marks). Sources:

| source | how it reaches the tools |
|---|---|
| `obstacles.vector` | exact geometry (circles, polylines with width, rects, polygons, positioned shapes) |
| `obstacles.svg` | the scenario's `truth.json` geometry — the classified shapes the host drew — instead of the SVG (emulation: the tools cannot read SVG); without a truth file the SVG is ignored (unsupported) |
| `obstacles.raster` | the per-pixel class masks of spec §4.6 (`bench/common/raster.py`; continuous modes thresholded at 0.5), as occupied cells or pixel runs (emulation) |

**Soft classes.** The tools have no soft costs. A class the problem gives a cost (neither
`hard` nor `ignore`: grid lines, background points, raster ink, …) is either avoided like a
hard one (`hard`) or left out, so labels may cover it (`ignore`); neither is what the problem
asks for, and which comes closer depends on the problem: as hard obstacles, 15 grid lines
under 40-character class names leave vega-label no position at all (`01/cbo-rfc-30-vector`),
and raster ink leaves it two labels of 375 (`06/monaco-ink`). The runner therefore solves
every problem with soft classes both ways and keeps the result under which the tool does
better by its own numbers — more usable labels, priority-weighted (`usable_weighted`), then
fewer conflicts, then `hard` (`bench/run.py --baseline-soft best`, the default; `hard` or
`ignore` force one way; a sequence takes the way chosen on its first frame). The result's
warnings say which (`soft-classes`), and `results.json` keeps what both gave
(`baseline.soft_choice`). Tools told no obstacles (d3fc, ECharts, D3-Labeler) run once.

**Internal labels.** A box that lies inside the item's own shape (shrunk by the 0.5 px
tolerance), where the problem allows internal labels, is reported as an internal label — a
label on a large bubble, not one covering its own mark.

**Results.** Each placed label is the problem's box at the position the tool chose, with the
problem's text layout (`text`, `parts`) so the renderer draws it like any other result. A
connector line becomes a straight `leader` (from the mark's boundary to the box) only when the
tool drew one *and* the box is farther than `offset + 0.5` px from the mark's bounding box along
x or y; the tools' adjacent positions — diagonal ones are offset along both axes — get at most a
short stub, which is not a leader. Labels without a leader get `model: "slider"` and the 8-way
side of their box relative to the anchor.

**Not applicable.** A problem a tool cannot run at all is reported "n/a" with the reason (only
adjustText so far, see below), not as an error.

## textalloc

`textalloc.allocate(ax, x, y, text_list, …)`:

| parameter | value | why |
|---|---|---|
| `x`, `y`, `text_list` | anchors and texts, priority order | |
| `text_scatter_sizes` | mark radius + `placement.offset` | the 12 fixed candidates then touch the mark's offset ring |
| `min_distance` | 0 | (the offset comes from `text_scatter_sizes`) |
| `x_scatter`, `y_scatter`, `scatter_sizes` | every mark (half its bbox), obstacle circles (radius), rect centres (half the shorter side), raster cells (centre, half size; cells of 4 px, doubled until ≤ 25,000) | |
| `x_lines`, `y_lines` | polylines, rect and polygon outlines | lines have no width in textalloc (emulation) |
| `margin` | 0.5 px (as a fraction of the axes width) | covers thin strokes; labels may touch, as in the problems |
| `xlims`, `ylims` | the label area | |
| `draw_lines` | on | connector lines |
| `avoid_label_lines_overlap`, `avoid_crossing_label_lines` | on | leaders vs labels and leader crossings are hard in the problems |
| `draw_all` | False | labels without a free candidate are reported unplaced |
| `nbr_candidates`, `max_distance` | 200, 0.2 (defaults) | |

Deterministic. Cost grows with candidates × (points + lines) per label.

## adjustText

`adjust_text(texts, x, y, objects, …)` on texts placed at their anchors (`ha = va = "center"`):

| parameter | value | why |
|---|---|---|
| `texts` | one `Text` per label, priority order, extent = label box | |
| `objects` | bounding boxes of every mark, obstacle circles and rects, raster cells | adjustText repels from boxes |
| `x`, `y` | points along polylines and polygon outlines | emulation: no line obstacles |
| `avoid_self`, `prevent_crossings`, `ensure_inside_axes` | True | axes = label area |
| `arrowprops` | `{"arrowstyle": "-"}`, `min_arrow_len` 5 (default) | arrows on |
| `iter_lim` | 100 (sequences: see below), `time_lim=None` | deterministic, instead of the default 1-second wall-clock limit |
| other forces, `expand` | defaults | |

The sampling step of lines (2, 4, 8, 16, 32 px) and the raster cell size (twice that, at least
4 px) are the finest for which adjustText's first iteration stays within 1.25 × 10⁸ comparisons.
Every adjustText iteration compares each pair of x-overlapping intervals with each pair of
y-overlapping intervals (a dense `|X| × |Y| × 2` broadcast), so the cost grows with the square
of the number of labels and obstacles: problems that exceed the limit even at the coarsest
emulation (in the quick suite: 05 with 300 labels and 2,921 points, 06 with 375 labels, 12 with
1,206 labels, the 1,000-label frames of 11) would need gigabytes and minutes per iteration and
are reported **n/a** with the estimate. adjustText never omits labels.

**Sequences** (scenario 11) are planned as a whole (`sequence_options`): one sampling step for
every frame, the finest at which every frame stays within the limit (a step that changed from
frame to frame would move the labels by itself), and as many iterations per frame, at most 100,
as 7.5 × 10¹⁰ comparisons allow for the whole sequence (frames × iterations × comparisons of the
first iteration; about ten minutes here). Below 5 iterations per frame the sequence is **n/a**.
The 41 frames of `drag-lesmis` get 18 iterations each (lines every 32 px): with 100, the sequence
took 57 minutes of the CI run. The tool's own default would stop each solve after one second,
about one iteration on these frames. The report notes the iterations of each frame.

## vega-label

A headless Vega view (`vega_label.mjs`, renderer `none`):

| element | value |
|---|---|
| base mark | `path` mark with every labeled item's true mark outline; `avoidBaseMark: true` |
| `avoidMarks` | one mark per obstacle layer: `symbol` circles (area π r²), `rect`s, stroked `path`s for polylines (their width), filled `path`s for polygons, one filled `path` per raster class made of its horizontal pixel runs (exact at raster resolution; 2-px cells beyond 400,000 runs), marks of unlabeled items |
| `anchor` | the 8 adjacent positions in the problem's position order (perceptual unless the preset or problem says otherwise; per-item orders are not supported) |
| `offset` | `placement.offset` |
| `sort` | the priority rank |
| `size`, `padding` | the label area, 0 |

vega-label rasterizes the avoided marks through node-canvas (the `canvas` package) into a
bitmap of at least 1-px cells (coarser above one megapixel) and tests each label against it, so
it places a label only where no avoided pixel is covered. It draws no leaders; where every
adjacent position touches an obstacle (dense raster ink, scenarios 04 and 06) it places few or no
labels. Deterministic.

## ggrepel

`ggrepel.R` builds one `geom_text_repel` layer and reads the result back from the drawn grob
tree (repelled positions only exist at draw time):

1. Device and plot as in the coordinates table; fonts via fontconfig.
2. Rows: the labels in priority order, then the obstacles as rows with empty labels (ggrepel
   repels labels from all data points but labels only rows with text): unlabeled marks,
   obstacle circles, and points sampled from polylines, rect and polygon areas and raster cells
   (emulation), one smallest label height apart (coarser when more than 8,000 points would
   result), since `max.overlaps` counts data points. Composite labels pass their text with
   leading spaces as wide as the icon part.
3. `size` = font px / `.pt`, `point.size` = the `geom_point` size whose circle has the mark's
   radius (`r / (0.375 · .pt)`), `point.padding` = `placement.offset`, `box.padding` as above,
   `xlim` / `ylim` = the label area, `seed = 1`, `max.iter = 10000` (default), `max.time = 60`
   s (instead of 0.5 s, so the iteration cap binds and results do not depend on machine speed;
   a run that reaches it is noted), `max.overlaps = 10` (default), other parameters default.
4. `ggplotGrob(p)`, then `grid.force()` — this runs `makeContent.textrepeltree`, i.e. the
   repulsion, and is the timed part — then the forced tree is drawn and every grob named
   `textrepelgrob<i>` (i = row among the labeled rows) and `segmentrepelgrob<i>` is visited in
   its viewport: `deviceLoc()` turns its `x`/`y` (and the segment's end points) into inches,
   i.e. canvas px / 72 with y up. Rows without a text grob were dropped by `max.overlaps`.
5. The reported box is the label box centred on the text position (hjust = vjust = 0.5); a
   segment becomes a leader ending where it enters that box.

## d3fc

`d3fc_layout.mjs` imports the strategies from the package's published ES sources (its `main`, a
rollup bundle, is not in the npm tarball; a resolve hook adds the `.js` extensions the sources
omit) and runs the README's strategy, `layoutRemoveOverlaps(layoutGreedy().bounds(area))`:

| element | value |
|---|---|
| rects | one per label in priority order: the label box grown by m = mark radius + `placement.offset` on every side, at the anchor point (d3fc puts a corner or an edge midpoint of the rect at the point: 8 positions); the reported box is the rect shrunk back by m — d3fc's own way to keep a label off its point (`layoutTextLabel().padding`) |
| `bounds` | the label area (greedy minimizes overlap area, then the area outside the bounds; it does not enforce them) |
| removeOverlaps | hides the label with the largest overlap area until none overlaps (ties: the earlier one) |

d3fc compares labels only: marks and obstacle classes are not avoided. With large marks the
grown rect is large too (a bubble of radius 60 adds 120 px to each side), so labels of large
bubbles overlap much and are hidden first. Above 2,500 labels the problem is **n/a**
(removeOverlaps is cubic in dense problems). Deterministic.

## ECharts

`echarts_layout.mjs` renders one chart server-side (`echarts.init(null, null, {renderer: 'svg',
ssr: true})`, no DOM) and reads every label's rect and visibility from the scene graph:

| element | value |
|---|---|
| series | one `scatter` series on value axes of exactly the canvas (y inverted, no grid margins, `clip: false`), one data item per label in priority order: `symbol` circle of the mark's diameter (other marks: a `rect` symbol of their bounding box) |
| `label` | `position`: the first position of the problem's order that ECharts has outside a symbol (top / right / bottom / left; a diagonal first position gives its horizontal side), `distance`: `placement.offset`, `padding` 0, `lineHeight` = the box height; the text measurement (`setPlatformAPI({measureText})`) returns the box width, so ECharts lays out exactly the problem's box |
| `labelLayout` | `{hideOverlap: true}`: in order of decreasing symbol area (ECharts' default `priority`; a stable sort, so ties keep the priority order) a label overlapping one already shown is hidden |

ECharts compares labels only and gives every label the same position: marks and obstacle
classes are not avoided, there are no alternatives and no leaders. Deterministic.

## D3-Labeler

`d3_labeler.mjs` loads the original `labeler.js` (Evan Wang, 2013; MIT; vendored at commit
`6de8670`, `vendor/d3-labeler`) into a `d3` global and runs it as its README shows:

| element | value |
|---|---|
| labels / anchors | the labels in priority order, each starting with its baseline-left corner at its anchor; anchors with the mark radius (the tool's label–anchor overlap uses the square of side 2r); layout coordinates = canvas px minus the label area's origin |
| `width`, `height` | the label area (walls keep a label's baseline-left corner inside, not its box) |
| `start(nsweeps)` | 1,000 sweeps (the README's value); fewer when 2 n² energy terms per sweep would exceed 4 × 10⁹ for the run (noted), **n/a** below 100 sweeps (above about 4,500 labels) |
| randomness | `Math.random` replaced by a seeded generator (mulberry32, seed 1): reproducible runs |

Its energy weighs leader length, leader crossings, label–label and label–anchor overlap and an
orientation bias; it never omits a label. A label whose box is away from its mark gets a
straight leader from the mark to the box edge facing it, as the tool's demo draws one. Other
marks and obstacle classes are not avoided.

## Emulations at a glance

| problem feature | textalloc | adjustText | vega-label | ggrepel |
|---|---|---|---|---|
| unlabeled points / circles | native (scatter + sizes) | native (boxes) | native (symbols) | native (empty-label rows) |
| polylines | native, no width | ≈ sampled points | native (stroked paths) | ≈ sampled points |
| rects / polygons | ≈ outlines (+ rect centres) | rects native, polygons ≈ outline points | native | ≈ sampled points |
| raster backgrounds | ≈ cells as points | ≈ cells as boxes | ≈ pixel-run paths | ≈ cell centres |
| SVG backgrounds | ≈ truth geometry | ≈ truth geometry | ≈ truth geometry | ≈ truth geometry |
| soft costs (weights) | ≈ hard or left out | ≈ hard or left out | ≈ hard or left out | ≈ hard or left out |
| area anchors, internal / boundary labels | ≈ pole as a point; n/a | same | same | same |
| composite / icon labels | ≈ box size via measurement | same | same | ≈ padded text |
| leader styles, angles, ports | straight connectors | straight arrows | n/a (no leaders) | straight segments |
| warm start (sequences) | n/a: each frame from scratch | same | same | same |

## Licenses

Benchmark tooling only; nothing here is distributed with Label Anything. Python:
textalloc and adjustText MIT, matplotlib (PSF-style matplotlib license) and its dependencies
BSD / MIT / Apache-2.0 / MPL-2.0 (`requirements.txt`). npm (105 packages in
`package-lock.json`): vega BSD-3-Clause, canvas MIT, d3fc-label-layout MIT, echarts and
zrender Apache-2.0, the rest MIT / ISC / BSD-3-Clause / Apache-2.0 / Unlicense / 0BSD.
Vendored: D3-Labeler MIT (`vendor/d3-labeler/LICENSE`). R: R GPL-2 | GPL-3, ggrepel GPL-3,
ggplot2 MIT, jsonlite MIT.
