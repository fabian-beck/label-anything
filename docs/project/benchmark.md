# Benchmark

The real-world benchmark ([`bench/`](gh:bench/README.md)) measures label placement on
problems built from open data, with one evaluator for every solver: the Rust, WebAssembly
and TypeScript implementations of Label Anything and six baselines — `naive`, `greedy`,
[textalloc](https://github.com/ckjellson/textalloc),
[adjustText](https://github.com/Phlya/adjustText), Vega's
[`label` transform](https://vega.github.io/vega/docs/transforms/label/) and
[ggrepel](https://github.com/slowkow/ggrepel). It depends only on the JSON formats, never
on an engine's internals.

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
outside the canvas, hard classes), placement rate and **priority-weighted placement**
(NDCG), **priority inversions** by a removal test, soft coverage per class, leader
statistics, ambiguity, the gap between labels and their shapes, position ranks, text
degradation, runtime, and — for scenario 11 — displacement, flips and nesting between
frames. The full list is in [`bench/README.md`](gh:bench/README.md).

## What the results show

From the quick suite with every baseline (CI, commit fd09957, 2026-10-17): labels placed
of the problem's items, and in parentheses the hard violations the evaluator finds
(overlapping labels, covered marks, crossing leaders, …); "n/a": the tool cannot run the
problem (adjustText's pairwise overlap test would need gigabytes).

| Problem | Label Anything | greedy | textalloc | adjustText | vega-label | ggrepel |
|---|---:|---:|---:|---:|---:|---:|
| Gapminder 2005, 46 bubbles | **32** (0) | 18 (0) | 29 (26) | 46 (128) | 16 (0) | 23 (17) |
| 300 airports, world map | **209** (0) | 175 (0) | 177 (205) | n/a | 84 (0) | 117 (36) |
| 375 POIs on Monaco tiles | **206** (0) | 172 (0) | 67 (61) | n/a | 2 (0) | 76 (21) |
| Les Misérables, 77 nodes | **77** (0) | 77 (0) | 70 (8) | 77 (19) | 39 (0) | 30 (2) |
| 200 points, stress | **199** (0) | 183 (0) | 193 (14) | 200 (41) | 174 (0) | 200 (26) |
| 1,206 classes, strict priority | **57** (0) | 39 (0) | 36 (290) | n/a | 36 (0) | 18 (15) |

* **Guarantees hold.** Every Label Anything result of the benchmark, every frame of the
  sequences included, has 0 hard violations and 0 leader crossings, and the Rust,
  WebAssembly and TypeScript implementations give identical placements. Among the tools
  that avoid every overlap it places the most labels; the tools that place more pay with
  overlaps.
* **Dense data loses labels.** A label that would overlap is left out, with the reason
  and the labels in its way in the result: of 1,000 airports on the world map 501 get a
  label, of 2,000 random points (the performance problem) 872. The label margin of
  [ADR 0028](../adr/0028-label-margin.md) trades labels for space between them: 1–4 % of
  the labels in typical scenes, 10 % of the 2,000 points.
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
  ([where the time goes](../benchmark.md#where-the-performance-targets-stand)).

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

CI runs the quick suite on every pull request and the full suite on release tags
(job `bench`); the job `baselines` runs the quick suite with every baseline and the
performance targets on tags, weekly and on demand, builds the gallery and checks the
release gates on tags. Both upload the report as a workflow artifact.

## Release gates

A release needs 0 hard violations everywhere, no metric regression above 2 % against the
previous release (unless an ADR accepts it) and the performance targets met — see
[release procedure and gates](../benchmark.md).
