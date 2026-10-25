# Benchmark

The real-world benchmark ([`bench/`](gh:bench/README.md)) measures label placement on
problems built from open data, with one evaluator for every solver: the Rust, WebAssembly
and TypeScript implementations of Label Anything and ten baselines — `naive`, `greedy`,
[textalloc](https://github.com/ckjellson/textalloc),
[adjustText](https://github.com/Phlya/adjustText), Vega's
[`label` transform](https://vega.github.io/vega/docs/transforms/label/),
[ggrepel](https://github.com/slowkow/ggrepel), the label layouts of
[d3fc](https://github.com/d3fc/d3fc/tree/master/packages/d3fc-label-layout) and
[Apache ECharts](https://echarts.apache.org/), the simulated annealing of
[D3-Labeler](https://github.com/tinker10/D3-Labeler), and the cost-based outlier labeling of
[Mumtaz et al. (2019)](https://doi.org/10.2312/evs.20191161), reimplemented from the paper.

| # | Scenario | Data |
|---|---|---|
| 01 | software metrics outliers | React Native's Java classes, CK-style metrics |
| 02 | volcano plot | differential expression tables (Galaxy, nf-core) |
| 03 | Gapminder bubbles | vega-datasets gapminder |
| 04 | embedding map | 50,000 WordNet glosses, t-SNE |
| 05 | airports on an SVG world map | OpenFlights, Natural Earth |
| 06 | city POIs on raster tiles | OpenStreetMap (Monaco) |
| 07 | node-link | Les Misérables, Cora |
| 08 | technical / anatomical illustration | scikit-image sample photos |
| 09 | line chart end labels | vega-datasets |
| 10 | stress / scale | airports at 10× density, up to 20,000 anchors |
| 11 | interactive stability | a zoom-and-pan camera path over the airports |
| 12 | priority showcase | metrics and airports with attribute, outlier and coverage priorities |
| 13 | outlier labeling after Mumtaz et al. (2019) | the paper's four figures, digitized, with its published layouts |

## What is measured

The evaluator re-checks every result with exact geometry. Its main measures:

* **Hard violations**: overlapping labels, covered marks, crossing leaders, labels outside
  the canvas or over obstacles that must stay visible.
* **Usable labels**: those left when every label in a conflict is dropped in priority
  order. This puts tools that never omit a label and tools that do on one scale.
* **Priority**: priority-weighted placement (NDCG) and priority inversions, omitted labels
  that would have fit next to the more important ones.
* **Whose a label is**: by how much a label's own point is nearer than any other data
  point, labeled or not; the data points labels cover, whatever the avoidance settings;
  and how close labels stand to each other
  ([ADR project/benchmark-measures](../adr/project/benchmark-measures.md)).
* **Readability**: how evenly labels spread over the data, leader length, clutter (the
  edge density the labels and leaders add), the gap between a label and its mark.
* **Cost**: runtime, peak memory, how runtime grows with the problem size; and for
  animations, how far labels move and how often they switch sides between frames.

[`bench/README.md`](gh:bench/README.md#evaluator-metrics) defines every metric.

## What the results show

The **usable labels** of each tool on the quick suite, with the labels it placed in
parentheses where that is more ("n/a": the tool cannot run the problem; 2026-10-25, Label
Anything with the rule of the unlabeled points, at its default
[aggressiveness](../concepts/candidates.md#aggressiveness) `medium` and at `high`):

| Problem | Label Anything | `high` | greedy | textalloc | adjustText | vega-label | ggrepel | ECharts | d3fc | D3-Labeler |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Gapminder 2005, 46 bubbles | **27** | 32 | 21 | 22 (32) | 20 (46) | 23 | 21 (31) | 12 (24) | 12 (20) | 24 (46) |
| 300 airports, world map | **222** | 228 | 200 | 209 (224) | 185 (300) | 182 (183) | 191 (262) | 126 (182) | 110 (135) | 211 (300) |
| 375 POIs on Monaco tiles | **186** | 187 | 170 | 172 (187) | n/a | 154 | 185 (217) | 84 (113) | 84 (121) | 129 (375) |
| Les Misérables, 77 nodes | **77** | 77 | 77 | 77 | 74 (77) | 77 | 76 (77) | 62 (74) | 73 | 76 (77) |
| 200 points, stress | **200** | 200 | 191 | 195 (199) | 188 (200) | 182 | 190 (200) | 140 (153) | 162 (173) | 189 (200) |
| 1,206 classes, strict priority | 48 | 62 | **51** | 30 (49) | n/a | 47 | 16 (28) | 9 (58) | 19 (58) | 20 (1,206) |

**Where Label Anything is ahead:**

* **The most usable labels** on every problem above but one: 3 % more than the next tool
  on the random points, 5 % on the world map, 27 against 24 among the Gapminder bubbles,
  one more than ggrepel on the city map. On the class chart, greedy keeps 51 labels to its
  48, but 45 % of greedy's are unclear and nearly a quarter stand nearer another class's
  point than their own; with `high`, Label Anything keeps 62. With every means, as `high`
  now selects, it led on all 55 problems of the full suite with `strict` or `weighted`
  omission (2026-10-18), from 10 outliers to 20,000 stress anchors, against the six other
  tools fast enough to run it; with `prefix` omission, on five of seven problems, tying on
  one and losing one to textalloc's longer leaders. Each other tool runs with soft
  obstacles both avoided and ignored, and keeps the better result.
* **Guarantees that hold**: 0 hard violations and 0 leader crossings in every result,
  including every animation frame, and identical placements from the Rust, WebAssembly and
  TypeScript implementations, so all its labels are usable. In dense scenes, adjustText and
  D3-Labeler lose 40–65 % of their labels to conflicts as drawn; ECharts and d3fc, which
  compare labels only with each other, lose a fifth to a half.
* **Clear labels**: on the nine problems of the quick suite that every tool runs
  (2026-10-25), outside the 300-airport map, 0.5 % of its labels are *unclear* — another
  data point is no more than 0.2 em farther from the label than its own — against 9–20 %
  for the other tools, and none stands closer than 0.4 em to another label (other tools: up
  to 55 %).
* **Few free spots left behind**: of the 2,148 labels the other tools place for items Label
  Anything omits on the quick suite, 98 % would break a hard rule in its result; half of
  the 35 others would stand nearer another point than their own or too close to tell, 2
  need a leader longer than the 4 em of `medium`.

**Where it falls short:**

* **Dense data loses labels.** Of 1,000 airports on the world map, 554 get a label (563
  with `high`); of 2,000 random points, 921 (972). The space between labels
  ([ADR placement/margin](../adr/placement/margin.md)) costs a few percent of the labels in
  typical scenes. Where hubs crowd, a big airport's label may cover a smaller hub's dot,
  which then stays unlabeled.
* **Unlabeled points still compete.** Among the 2,917 unlabeled airports of the 300-airport
  map, 39 % of its labels are unclear (textalloc 66 %, ggrepel 68 %, vega-label 92 %): the
  rule that keeps a label clearly nearer its own point sees the background points too
  ([ADR placement/unlabeled-points](../adr/placement/unlabeled-points.md)), but not the
  dots of less important items that the `map` preset lets labels cover, and where the
  points stand too dense for any place beside a mark, only the marks of items.
* **More labels cover more.** Label Anything covers more of what it may cover — 1.3
  background points per label on the airport map, textalloc 1.2. Raise
  `avoid.label.points` where hidden data points matter more.
* **Crowds need leaders.** 10 of the 27 Gapminder labels and 40 of 141 in the Cora network
  sit on leaders, up to 4 em long (`high`: 15 of 32 and 49 of 149, up to 8 em). At the
  crowded ends of the life-expectancy chart, 40 of 62 lines get a label, in a column.
* **Moving labels jump sides.** Re-solved frame by frame from the previous result, labels
  move 1.6–3.6 px per frame, nearly all of it from the 6–20 % that switch to another side
  when a neighbour takes their place. Other tools move as much or more, or keep fewer
  labels.
* **Speed misses its targets for large problems.** Hundreds of labels take milliseconds;
  2,000 labels over 100,000 points take about 300 ms natively on one core (2.3–2.6 times
  the target) and 0.8 s in TypeScript
  ([where the time goes](gh:bench/README.md#where-they-stand)). Memory grows with the
  number of candidates: at most 97 MB for 2,000 labels, 580 MB for 20,000.

**How hard it tries** ([aggressiveness](../concepts/candidates.md#aggressiveness); the 62
problems of the full suite without animations, 2026-10-25):

* The default `medium` places 3.5 % fewer labels than `high` with 9.2 % less clutter, and
  solves in a third less time: the labels it gives up needed smaller type or a leader
  longer than 4 em. `low` places 21 % fewer with 24 % less clutter, in 62 % less time,
  nearly all next to their marks.
* In the animations, labels move 12–35 % less per frame at `medium` than at `high`, and
  30–43 % less at `low`.
* On 10,000 and 20,000 stress anchors, `medium` places more labels than `high` (1,092
  against 977, 990 against 914): `high` spends the time budget on its further means.

The [benchmark report](https://fabian-beck.github.io/label-anything/benchmark-report/) shows
where each labeler stands, every problem with the labelers side by side (three by default,
the others on demand) and what the defaults still do badly
([ADR project/benchmark-report](../adr/project/benchmark-report.md)). Its images mark what
the measures count, where it happens:
conflicts in red, ambiguous labels in orange (a line to the point a label may be taken
for), covered points in magenta and labels too close to each other in purple.

## Running it

```sh
python3 -m venv bench/.venv && bench/.venv/bin/pip install -r bench/requirements.txt
bench/.venv/bin/python -m bench.scenarios fetch        # download and verify the data
bench/.venv/bin/python -m bench.scenarios build        # build the problems (~12 min)
rust/target/release/label-anything bench --suite quick --baselines --perf -o bench-report
```

`bench-report/index.html` is the report: renderings and metrics per problem and solver,
performance and parity, every table value coloured blue (better) or red (worse) against
the median of the solvers; `python -m bench.gallery` adds its figures. CI runs the quick
suite on every pull request and the full suite on release tags. A release needs 0 hard
violations, no metric regression above 2 % against the previous release unless an ADR
accepts it, and the performance targets met
([release gates](gh:bench/README.md#release-gates)). The
[latest report](https://fabian-beck.github.io/label-anything/benchmark-report/) is
published with this site.
