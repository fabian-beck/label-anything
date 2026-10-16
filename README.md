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
  labels are dropped and in which order — and the result explains every omission.
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

## Defaults

| Topic | Default |
|---|---|
| Priority | explicit `item.priority`, else input order; omission `strict`; `evict_lower` on |
| Text | 12 px bundled sans (Noto Sans) · padding 0.15 em · buffer 0.3 em |
| Candidates | models adjacent + slider + distant (preset `auto`: distant only when crowded) · perceptual position order (top first) |
| Leaders | straight, crossings hard, clearance 3 px |
| Label vs. | labels, items, text, canvas edge: **hard** · ink 0.5 |
| Leader vs. | labels **hard** · items 2.0 |
| Solver | time budget 100 ms (Rust) / 250 ms (TS) · seed 0 · deterministic |
| Degradation | alternatives → wrap → distant → boundary → evict_lower → shrink 0.85 → soft_overlap → omit |

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
targets; `--gate` enforces the release gates (`docs/benchmark.md`, `bench/README.md`).

## Repository layout

```
spec/          JSON Schemas, prose spec, defaults table, presets, expression grammar
conformance/   language-neutral test cases used by every implementation
fonts/         bundled Noto Sans subset (SIL OFL 1.1)
rust/          performance core: la-core, la-text, la-expr, la-svg, la-raster, la-render,
               la-cli, la-wasm, la-py, la-capi, and the label-anything facade crate
ts/            pure TypeScript implementation (@label-anything/core, text, svg, raster)
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
