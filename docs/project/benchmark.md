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

CI runs the quick suite on every pull request and the full suite on release tags
(job `bench`); the job `baselines` runs the quick suite with every baseline and the
performance targets on tags, weekly and on demand, and checks the release gates on tags.
Both upload the report as a workflow artifact.

## Release gates

A release needs 0 hard violations everywhere, no metric regression above 2 % against the
previous release (unless an ADR accepts it) and the performance targets met — see
[release procedure and gates](../benchmark.md).
