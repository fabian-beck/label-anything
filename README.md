# Label Anything

**A host-independent label placement engine.** Label Anything places labels — text,
icons, or anything with a size — next to selected features in scatterplots, maps,
node-link diagrams and illustrations. It avoids whatever you say should not be covered,
draws leader lines when labels must sit at a distance, and never lets leaders cross.

* **One problem in, one result out.** Anchors, labels, fonts, an optional background
  (nothing, vector shapes, SVG, or a raster image) and an avoidance policy go in; a list
  of placed labels and leaders comes out. The format is a versioned JSON schema
  (`spec/schema/`), so it works from any language.
* **Graded collision policy.** "Never cover outliers; covering other points costs a
  little; never cross a leader" is one line of configuration.
* **You decide what is omitted.** When not everything fits, a priority function (data
  attributes, outlierness, tiers, per-category coverage, or a callback) decides which
  labels are dropped and in which order — and the result explains every omission. Font
  classes set the most important labels larger or bold.
* **Shape-aware.** Labeled items can be circles, ellipses, (rounded, rotated)
  rectangles, polygons, paths or pins; labels touch the true shape, large shapes get
  internal labels, small ones external labels or leaders.
* **Fast, deterministic, everywhere.** A Rust core (native, WASM, Python, C ABI, Java)
  and a pure TypeScript implementation pass the same conformance suite.

> Status: under active development (0.x). See `docs/adr/` for design decisions and
> `bench/` for the real-world benchmark.

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
| Priority | explicit `item.priority`, else input order; omission `strict`; `evict_lower` on |
| Text | 12 px bundled sans (Noto Sans) · padding 0.15 em · buffer 0.3 em |
| Candidates | models adjacent + slider + distant (preset `auto`: distant only when crowded) · perceptual position order (top first) · fan labels for crowds left without labels |
| Leaders | straight, crossings hard, 0.4 em clear of other marks and leaders |
| Label vs. | labels, items, text, canvas edge: **hard** · ink 0.1 per em² |
| Leader vs. | labels, items, leaders **hard** |
| Solver | time budget 100 ms (Rust) / 250 ms (TS) · seed 0 · deterministic |
| Degradation | alternatives → wrap → distant → evict_lower → shrink 0.85 → soft_overlap → omit |

The complete table is `spec/defaults.md`; presets (`scatter`, `map`, `graph`,
`illustration`, `auto`) are in `spec/presets/`.

## Benchmark

`bench/` is a real-world benchmark: twelve scenarios built from open data (scatterplots,
volcano plots, embeddings, airports on a world map, city POIs on map tiles, node-link
diagrams, illustrations, line charts, stress sizes, interactive zooming, priority), an
implementation-independent evaluator, and six baselines — naive, greedy, textalloc,
adjustText, vega-label and ggrepel — scored the same way.
`label-anything bench --baselines --perf` writes `bench-report/index.html`: metric tables,
renderings side by side, runtime-vs-size plots, Rust/TypeScript parity and the performance
targets; `--gate` enforces the release gates (`docs/benchmark.md`, `bench/README.md`, which
also lists where the performance targets stand). `python -m bench.gallery` turns a run into a
[gallery](https://fabian-beck.github.io/label-anything/benchmark-report/gallery/) of
renderings, published with each release's report.

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
