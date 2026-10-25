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
* **Readability**: how evenly labels spread over the data, leader length and clutter, the
  gap between a label and its mark.
* **Cost**: runtime, peak memory, how runtime grows with the problem size; and for
  animations, how far labels move and how often they switch sides between frames.

[`bench/README.md`](gh:bench/README.md#evaluator-metrics) defines every metric.

## What the results show

The **usable labels** of each tool on the quick suite, with the labels it placed in
parentheses where that is more ("n/a": the tool cannot run the problem; commit 25b543f,
2026-10-18; Label Anything at commit 4e6684e):

| Problem | Label Anything | greedy | textalloc | adjustText | vega-label | ggrepel | ECharts | d3fc | D3-Labeler |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Gapminder 2005, 46 bubbles | **32** | 18 | 21 (30) | 21 (46) | 20 | 21 (28) | 11 (22) | 9 (18) | 22 (46) |
| 300 airports, world map | **215** | 175 | 197 (208) | 176 (300) | 163 | 165 (213) | 109 (151) | 105 (129) | 179 (300) |
| 375 POIs on Monaco tiles | **203** | 170 | 172 (187) | n/a | 154 | 185 (217) | 84 (113) | 84 (121) | 129 (375) |
| Les Misérables, 77 nodes | **77** | 77 | 77 | 73 (77) | 77 | 74 (77) | 58 (65) | 67 (69) | 76 (77) |
| 200 points, stress | **197** | 183 | 191 (193) | 182 (200) | 174 | 179 (200) | 125 (135) | 154 (163) | 173 (200) |
| 1,206 classes, strict priority | **57** | 39 | 18 (36) | n/a | 36 | 13 (18) | 4 (47) | 12 (51) | n/a |

**Where Label Anything is ahead:**

* **The most usable labels** on every problem above: 3 % more than the next tool on the
  random points, 9–10 % on the maps, 45 % among the Gapminder bubbles. The same holds on
  all 55 problems of the full suite with `strict` or `weighted` omission, from 10 outliers
  to 20,000 stress anchors, against the six other tools fast enough to run it. With
  `prefix` omission, it leads on five of seven problems, ties on one and loses one to
  textalloc's longer leaders. Each other tool runs with soft obstacles both avoided and
  ignored, and keeps the better result.
* **Guarantees that hold**: 0 hard violations and 0 leader crossings in every result,
  including every animation frame, and identical placements from the Rust, WebAssembly and
  TypeScript implementations, so all its labels are usable. In dense scenes, adjustText and
  D3-Labeler lose 40–65 % of their labels to conflicts as drawn; ECharts and d3fc, which
  compare labels only with each other, lose a fifth to a half.
* **Clear labels**: on the quick suite (2026-10-24), outside the 300-airport map, 1.5 % of
  its labels are *unclear* — another data point is no more than 0.2 em farther from the
  label than its own — against 9–20 % for the other tools, and none stands closer than
  0.4 em to another label (other tools: up to 43 %).
* **No free spot left behind**: where another tool labels an item that Label Anything
  omits, that label does not fit into Label Anything's result; on six problems, all but one
  such label would break a hard rule there.

**Where it falls short:**

* **Dense data loses labels.** Of 1,000 airports on the world map, about 580 get a label;
  of 2,000 random points, 1,003. The space between labels
  ([ADR placement/margin](../adr/placement/margin.md)) costs a few percent of the labels in
  typical scenes. Where hubs crowd, a big airport's label may cover a smaller hub's dot,
  which then stays unlabeled.
* **Unlabeled points still compete.** Among the 2,917 unlabeled airports of the 300-airport
  map, every tool leaves half or more of its labels unclear (Label Anything 62 %, textalloc
  66 %, ggrepel 68 %, vega-label 92 %): the rule that keeps a label clearly nearer its own
  point sees only the marks of items, not background points given as obstacles, nor the
  dots of less important items that the `map` preset lets labels cover.
* **More labels cover more.** Label Anything covers more of what it may cover — 1.5
  background points per label on the airport map, textalloc 1.2. Raise
  `avoid.label.points` where hidden data points matter more.
* **Crowds need leaders.** 12 of the 30 Gapminder labels and 31 of 150 in the Cora network
  sit on leaders, up to 8 em long. At the crowded ends of the life-expectancy chart, 41 of
  62 lines get a label, in a column.
* **Moving labels jump sides.** Re-solved frame by frame from the previous result, labels
  move 2–4 px per frame, nearly all of it from the 7–15 % that switch to another side when
  a neighbour takes their place. Other tools move as much or more, or keep fewer labels.
* **Speed misses its targets for large problems.** Hundreds of labels take milliseconds;
  2,000 labels over 100,000 points take about 300 ms natively on one core (2.3–2.6 times
  the target) and 0.8 s in TypeScript
  ([where the time goes](gh:bench/README.md#where-they-stand)). Memory grows with the
  number of candidates: at most 97 MB for 2,000 labels, 580 MB for 20,000.

The [gallery](https://fabian-beck.github.io/label-anything/benchmark-report/gallery/) shows
the renderings of all labelers side by side, and what the defaults still do badly. The
images of the report and the gallery mark what the measures count, where it happens:
conflicts in red, ambiguous labels in orange (a line to the point a label may be taken
for), covered points in magenta and labels too close to each other in purple.

## Running it

```sh
python3 -m venv bench/.venv && bench/.venv/bin/pip install -r bench/requirements.txt
bench/.venv/bin/python -m bench.scenarios fetch        # download and verify the data
bench/.venv/bin/python -m bench.scenarios build        # build the problems (~12 min)
rust/target/release/label-anything bench --suite quick --baselines --perf -o bench-report
```

`bench-report/index.html` is the report: metrics and renderings per scenario and solver,
performance and parity; `python -m bench.gallery` adds the gallery. CI runs the quick
suite on every pull request and the full suite on release tags. A release needs 0 hard
violations, no metric regression above 2 % against the previous release unless an ADR
accepts it, and the performance targets met
([release gates](gh:bench/README.md#release-gates)). The
[latest report](https://fabian-beck.github.io/label-anything/benchmark-report/) is
published with this site.
