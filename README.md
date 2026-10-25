<h1>
  <a href="https://fabian-beck.github.io/label-anything/">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/assets/logo-lockup-dark.svg">
      <img src="docs/assets/logo-lockup.svg" alt="Label Anything" width="360">
    </picture>
  </a>
</h1>

**Website: [fabian-beck.github.io/label-anything](https://fabian-beck.github.io/label-anything/)** ·
[Playground](https://fabian-beck.github.io/label-anything/playground/) ·
[How it works](https://fabian-beck.github.io/label-anything/playground/explain.html) ·
[Getting started](https://fabian-beck.github.io/label-anything/getting-started/) ·
[Tutorials](https://fabian-beck.github.io/label-anything/tutorials/)

> [!WARNING]
> **Experimental, developed by AI.** Label Anything is still experimental and under active
> development, not production-ready software. It is written mostly by an AI coding assistant
> (Claude Code) with limited human oversight, code and documentation alike: expect mistakes,
> and check the results that matter to you. The problem format, the APIs of the language
> bindings and the placements themselves can change without deprecation. Try it and report
> what you find.

**Label placement for charts, maps and diagrams, from any language.** Label Anything
decides where labels go: it places text, icons, or anything with a size next to selected
points and areas of scatterplots, maps, node-link diagrams and illustrations. It avoids
whatever you say should not be covered, draws leader lines when labels must sit at a
distance, and never lets leaders cross.

The *anything* is the host and the label: one engine and one problem format for any
chart, map or diagram, any label with a size and every language, where adjustText
(matplotlib), ggrepel (ggplot2) or vega-label (Vega) each serve one plotting library.
Labels go to points and areas of any shape; lines such as roads or rivers are obstacles,
not labeled features. Label Anything places labels in graphics: it is not a tool for
labeling data, and it is unrelated to the few-shot segmentation model of the same name
(De Marinis et al., ECAI 2025).

**Try it in your browser:** the [playground](https://fabian-beck.github.io/label-anything/playground/)
runs the engine live — a world map, a network, charts, moving objects and photographs, with
every option in reach — and [How it works](https://fabian-beck.github.io/label-anything/playground/explain.html)
steps through a real solve: candidates and their costs, the greedy pass, local search.

* **One problem in, one result out.** Anchors, labels, fonts, an optional background
  (nothing, vector shapes, SVG, or a raster image) and an avoidance policy go in; a list
  of placed labels and leaders comes out. The format is a versioned JSON schema
  (`spec/schema/`), so it works from any language.
* **Graded collision policy.** "Never cover outliers; covering other points costs a
  little; never cross a leader" is one line of configuration.
* **You decide how hard it tries.** One option, `placement.aggressiveness`, trades labels
  for calm: `high` uses every means that keeps a label clear — long leaders, fan columns,
  smaller type — `medium` (the default) keeps the type size and short leaders, `low` keeps
  labels next to their marks, with room around them.
* **You decide what is omitted.** When not everything fits, a priority function (data
  attributes, outlierness, tiers, per-category coverage, or a callback) decides which
  labels are dropped and in which order — and the result explains every omission. Font
  classes set the most important labels larger or bold.
* **Shape-aware.** Labeled items can be circles, ellipses, (rounded, rotated)
  rectangles, polygons, paths or pins; labels touch the true shape, large shapes get
  internal labels, small ones external labels or leaders.
* **Deterministic, everywhere.** A Rust core (native, WASM, Python, C ABI, Java) and a
  pure TypeScript implementation pass the same conformance suite and give the same
  placements. Hundreds of labels take milliseconds, thousands a few hundred milliseconds.

Design decisions are recorded in `docs/adr/`, the real-world benchmark is in `bench/`.

## Five lines

```python
import label_anything as la
res = la.place(anchors=[(120, 80), (130, 85), (400, 300)], labels=["Alpha", "Beta", "Gamma"],
               canvas=(800, 600))
for p in res.placements:
    print(p.id, p.box, p.leader)
```

```ts
import { place } from "@label-anything/core";
const res = place({
  canvas: { width: 800, height: 600 },
  items: points.map((p) => ({ id: p.id, anchor: { type: "point", x: p.x, y: p.y },
                              label: { type: "text", text: p.name } })),
});
```

```sh
label-anything place problem.json -o result.json --debug-svg overlay.svg
```

## Packages

| Language | Package | What it is |
|---|---|---|
| Rust | `label-anything` (crate) | the engine; data-parallel phases on all cores |
| CLI | `label-anything` (`rust/crates/la-cli`) | `place`, `validate`, `render`, `bench`, `serve` (HTTP) |
| Python ≥ 3.9 | `label-anything` (PyPI; `rust/crates/la-py`) | the Rust engine; extras for matplotlib, Plotly, seaborn (`bindings/python-extras`) |
| JavaScript / TypeScript | `@label-anything/core` | the engine in pure TypeScript, bit-identical to Rust |
| JavaScript (WebAssembly) | `@label-anything/wasm` | the Rust engine compiled to WebAssembly, same API as `core` |
| JavaScript helpers | `@label-anything/extras` | d3, Observable Plot, Vega, Leaflet, MapLibre, Cytoscape, sigma, Web Workers |
| Java ≥ 17 | `io.github.fabian-beck:label-anything` | the Rust engine through FFM (JDK 22+) or JNI |
| C, Go, … | `label_anything.h` (`rust/crates/la-capi`) | C ABI; `examples/c`, `examples/go` |

The packages are not published to the registries yet; build them from this repository
(see the getting-started pages).

## Documentation

The documentation site is **<https://fabian-beck.github.io/label-anything/>** (built from
`docs/` with MkDocs; every code example on it is a program in `examples/tutorials/` that
CI runs):

* [Getting started](https://fabian-beck.github.io/label-anything/getting-started/) —
  Python (incl. matplotlib, Plotly, seaborn), JavaScript/TypeScript and WebAssembly,
  Java, C and Go, the CLI and the HTTP server;
* [Tutorials](https://fabian-beck.github.io/label-anything/tutorials/) — outliers in five
  lines, SVG and raster backgrounds, leaders, priority and omission, shapes, interactive
  maps, node-link diagrams;
* [Concepts](https://fabian-beck.github.io/label-anything/concepts/) — the problem and
  result formats, avoidance, candidates and the degradation ladder, presets, the solver;
* [Reference](https://fabian-beck.github.io/label-anything/reference/) — specification,
  defaults, presets, expressions, JSON Schemas, the API of each language;
* [Benchmark](https://fabian-beck.github.io/label-anything/project/benchmark/) and
  [architecture decisions](https://fabian-beck.github.io/label-anything/project/decisions/).

## Defaults

| Topic | Default |
|---|---|
| Aggressiveness | `medium`: labels keep their type size and the hard classes, distant labels stay within 4 em · `low`: no leaders but short ones of the models, 0.6 em between labels · `high`: every means (long leaders, fans, smaller type, relaxed overlaps) |
| Priority | explicit `item.priority`, else input order; omission `strict`; `evict_lower` on |
| Text | 12 px bundled sans (Noto Sans) · padding 0.15 em · buffer 0.3 em |
| Spacing | 1 px from the own mark · 0.2 em from other marks · 0.4 em from other labels · clearly nearer to the own mark than to any other |
| Candidates | models adjacent + slider + distant up to 4 em (preset `auto`: distant only when crowded) · perceptual position order (top first) · fan labels for crowds left without labels |
| Leaders | straight, crossings hard, 0.4 em clear of other marks and leaders |
| Label vs. | labels, items, text, canvas edge: **hard** · ink 0.1 per em² · across a light–dark border of a raster background 0.5 per em² |
| Leader vs. | labels, items, leaders **hard** |
| Solver | time budget 100 ms (Rust) / 250 ms (TS) · seed 0 · deterministic |
| Degradation | alternatives → wrap → distant → evict_lower → omit (`high`: … → shrink 0.85 → soft_overlap → omit) |

The complete table is `spec/defaults.md`; presets (`scatter`, `map`, `graph`,
`illustration`, `auto`) are in `spec/presets/`.

## Benchmark

`bench/` is a real-world benchmark: twelve scenarios built from open data (scatterplots,
volcano plots, embeddings, airports on a world map, city POIs on map tiles, node-link
diagrams, illustrations, line charts, stress sizes, interactive zooming, priority), an
implementation-independent evaluator, and nine baselines — naive, greedy, textalloc,
adjustText, vega-label, ggrepel, the label layouts of ECharts and d3fc, and D3-Labeler —
scored the same way.
`label-anything bench --baselines --perf` writes `bench-report/index.html`: metric tables,
renderings side by side, runtime-vs-size plots, Rust/TypeScript parity and the performance
targets; `--gate` enforces the release gates (`bench/README.md`, which also has the release
procedure and where the performance targets stand). `python -m bench.gallery` turns a run into a
[gallery](https://fabian-beck.github.io/label-anything/benchmark-report/gallery/) of
renderings, published with each release's report.

How good the results are, in short: no overlaps and no crossing leaders anywhere in the
benchmark, and more usable labels than any other tool on every problem of the quick suite but
one at the default aggressiveness, and with every means (`high`) on 60 of the 62 of the full
suite — often by a few percent only, once their overlapping labels are discounted; but in dense
data many labels are left out or need leaders, labels in animations move a few pixels per
frame, and the largest performance problems miss their targets. The numbers are on the
[benchmark page](https://fabian-beck.github.io/label-anything/project/benchmark/#what-the-results-show).

## Repository layout

```
spec/          JSON Schemas, prose spec, defaults table, presets, expression grammar
conformance/   language-neutral test cases used by every implementation
fonts/         bundled Noto Sans subset (SIL OFL 1.1)
rust/          performance core: la-core, la-text, la-expr, la-svg, la-raster, la-render,
               la-cli, la-wasm, la-py, la-capi, and the label-anything facade crate
ts/            pure TypeScript implementation (@label-anything/core, text, svg, raster, the
               label-anything-ts CLI) and the WebAssembly package (@label-anything/wasm)
bindings/      Java (FFM/JNI), Python extras (matplotlib, Plotly), JS extras (d3, Vega, …)
bench/         real-world benchmark: scenarios, evaluator, baselines, report, perf targets, gates
docs/          documentation and architecture decision records (docs/adr)
examples/      runnable examples per language and background type
tools/         code generation and maintenance scripts
```

## License

MIT (see `LICENSE`). The bundled font is under the SIL Open Font License 1.1 (see
`NOTICE` and `fonts/OFL.txt`). Please cite the methods Label Anything builds on
(`CITATION.cff`).
