# Benchmark

The real-world benchmark ([`bench/`](gh:bench/README.md)) measures label placement on
problems built from open data, with one evaluator for every solver: the Rust, WebAssembly
and TypeScript implementations of Label Anything and nine baselines — `naive`, `greedy`,
[textalloc](https://github.com/ckjellson/textalloc),
[adjustText](https://github.com/Phlya/adjustText), Vega's
[`label` transform](https://vega.github.io/vega/docs/transforms/label/),
[ggrepel](https://github.com/slowkow/ggrepel), the label layouts of
[d3fc](https://github.com/d3fc/d3fc/tree/master/packages/d3fc-label-layout) and
[Apache ECharts](https://echarts.apache.org/) (`labelLayout.hideOverlap`), and the
simulated annealing of [D3-Labeler](https://github.com/tinker10/D3-Labeler). It depends
only on the JSON formats, never on an engine's internals.

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

## What is measured

The evaluator (`python -m bench.eval`) re-checks every result with exact geometry and a
0.5 px tolerance: **hard violations** (label overlaps, covered marks, crossings, labels
outside the canvas, hard classes), split into **conflicts** — overlaps any labeler must
avoid — and the **spacing** rules of Label Anything (leader clearance and angles);
placement rate and **priority-weighted placement** (NDCG); **usable labels**, those left
when the conflicts are dropped in priority order, which puts tools that never omit a
label and tools that do on one scale; **priority inversions** by a removal test; how
evenly the labels spread over the data (the share of populated regions with a label);
soft coverage per class, leader statistics, ambiguity, the gap between labels and their
shapes, position ranks, text degradation; runtime, peak memory and how runtime grows with
the problem size; and — for scenario 11 — displacement, flips and nesting between frames.
The full list is in [`bench/README.md`](gh:bench/README.md).

## What the results show

From the quick suite with every baseline (commit 25b543f, 2026-10-18, on a 4-core cloud VM):
the **usable labels** of each tool — those left when every label in a conflict (an
overlap with another label, a mark or a hard obstacle, a crossing leader, …) is dropped in
priority order — and in parentheses the labels it placed, where that is more. "n/a": the
tool cannot run the problem (adjustText's pairwise overlap test would need gigabytes,
D3-Labeler's annealing hours).

| Problem | Label Anything | greedy | textalloc | adjustText | vega-label | ggrepel | ECharts | d3fc | D3-Labeler |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Gapminder 2005, 46 bubbles | **32** | 18 | 21 (30) | 21 (46) | 20 | 21 (28) | 11 (22) | 9 (18) | 22 (46) |
| 300 airports, world map | **213** | 175 | 197 (208) | 176 (300) | 163 | 165 (213) | 109 (151) | 105 (129) | 179 (300) |
| 375 POIs on Monaco tiles | **203** | 170 | 172 (187) | n/a | 154 | 185 (217) | 84 (113) | 84 (121) | 129 (375) |
| Les Misérables, 77 nodes | **77** | 77 | 77 | 73 (77) | 77 | 74 (77) | 58 (65) | 67 (69) | 76 (77) |
| 200 points, stress | **197** | 183 | 191 (193) | 182 (200) | 174 | 179 (200) | 125 (135) | 154 (163) | 173 (200) |
| 1,206 classes, strict priority | **57** | 39 | 18 (36) | n/a | 36 | 13 (18) | 4 (47) | 12 (51) | n/a |

* **Most usable labels, by less than it looked.** Label Anything keeps the most usable
  labels on every problem, ahead of the best other tool by 3 % on the 200 random points
  (textalloc 191), 8 % on the airport map (textalloc 197), 10 % on the Monaco tiles
  (ggrepel 185) and 45 % among the Gapminder bubbles (D3-Labeler 22). Until 2026-10 the
  benchmark handed every soft obstacle — grid lines, background points, graph edges,
  raster ink — to the other tools as a hard one, which no user of them would do, and
  counted labels inside their own bubble as covering it: vega-label labeled 2 of the 375
  POIs that way and 39 of the 77 nodes, ggrepel 30 nodes. Now each tool runs with soft
  obstacles both avoided and left out, and keeps whichever serves it better
  ([`bench/baselines/README.md`](gh:bench/baselines/README.md)).
* **Guarantees hold.** Every Label Anything result of the benchmark, every frame of the
  sequences included, has 0 hard violations and 0 leader crossings, and the Rust,
  WebAssembly and TypeScript implementations give identical placements: its usable labels
  are all its labels. The other tools' numbers above already assume a host that finds and
  removes their conflicts; as drawn, adjustText and D3-Labeler, which never omit a label,
  lose 40–65 % of theirs to conflicts in dense scenes, and the label layouts of ECharts and
  d3fc, which compare labels only, a fifth to half to the marks and obstacles they do not
  see.
* **The price of more labels.** Soft costs are costs: to place more labels, Label Anything
  covers more of what it may cover — on the airport map 2.1 background points per label
  where textalloc, leaving them out, covers 1.7.
* **Dense data loses labels.** A label that would overlap is left out, with the reason
  and the labels in its way in the result: of 1,000 airports on the world map about 520
  get a label, of 2,000 random points (the performance problem) 872. The label margin of
  [ADR 0028](../adr/0028-label-margin.md) trades labels for space between them: 1–4 % of
  the labels in typical scenes, 10 % of the 2,000 points. On very large inputs the greedy
  pass reaches its time guard; the items it has not reached then still get their normal
  positions, in priority order ([ADR 0048](../adr/0048-level-0-pass-after-the-greedy-guard.md)):
  914 labels for 20,000 anchors, where only the first 279 got one before.
* **Leaders where it is crowded.** In crowded scenes many labels need leaders (14 of the
  32 Gapminder labels, 58 of 149 in the Cora network), up to 8 and 11 em long, some
  across large marks; crowded line ends get a column in the margin
  ([ADR 0030](../adr/0030-boundary-columns.md)), 35 of the 62 life-expectancy lines.
* **Moving labels move.** Solving each frame of an animation warm-started with the
  previous result, labels move 2.3 px per frame on average while one node of the Les
  Misérables graph is dragged, 2.6 px in a running force layout and 3.4 px while panning
  and zooming over 1,000 airports. vega-label, whose labels keep to fixed positions,
  moves them less in the graph (0.8 and 1.2 px) but labels only half of its nodes, and
  more over the airports (4.1 px); textalloc and ggrepel 3–22 px.
* **Not as fast as the brief asks.** Hundreds of labels take milliseconds; 2,000 labels
  over 100,000 points take about 300 ms natively on one core (2.3 to 2.6 times the
  target) and 0.8 s in TypeScript (1.4 times its target)
  ([where the time goes](../benchmark.md#where-the-performance-targets-stand)). Up to
  2,000 labels the runtime grows about as n^1.4 on the stress scenario, as more labels
  run the degradation ladder where it is denser. Memory follows the candidates, about
  0.7 KB each in the native CLI: 97 MB at its peak for 2,000 labels, 580 MB for 20,000.

The [gallery](https://fabian-beck.github.io/label-anything/benchmark-report/gallery/) shows
the renderings, and what the defaults still do badly.

## Running it

```sh
python3 -m venv bench/.venv && bench/.venv/bin/pip install -r bench/requirements.txt
bench/.venv/bin/python -m bench.scenarios fetch        # download and verify the data
bench/.venv/bin/python -m bench.scenarios build        # build the problems (~12 min)
rust/target/release/label-anything bench --suite quick --baselines --perf -o bench-report
```

`bench-report/index.html` shows the summary per solver, the performance targets, runtime
against problem size, the parity of the implementations, the changes against a previous
run, and per scenario the metric tables with every solver's rendering side by side.

## Gallery

`bench/.venv/bin/python -m bench.gallery --engine rust/target/release/label-anything --run
bench-report` adds `bench-report/gallery/`: one page of vector images of real-data problems —
hub-first airport maps, charts, photos, embeddings, networks, priority — solved by the engine,
with the evaluator's numbers, the omitted labels by reason and the problem's settings under
each, the same problems by the other labelers, frames of an interactive zoom, and, with
figures, what the engine still does badly. It is published with the latest report: [the
gallery](https://fabian-beck.github.io/label-anything/benchmark-report/gallery/).

## In CI

CI runs the quick suite on every pull request and push to main and the full suite on
release tags (job `bench`); the job `baselines` runs the quick suite with every baseline and the
performance targets on tags, weekly and on demand, builds the gallery and checks the
release gates on tags. Both upload the report as a workflow artifact.

## Release gates

A release needs 0 hard violations everywhere, no metric regression above 2 % against the
previous release (unless an ADR accepts it) and the performance targets met — see
[release procedure and gates](../benchmark.md).
