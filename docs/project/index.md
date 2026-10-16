# Project

Label Anything is open source under the MIT License
([repository](https://github.com/fabian-beck/label-anything)); the bundled font, Noto Sans,
is under the SIL Open Font License 1.1. It is under active development (0.x).

* [Benchmark](benchmark.md) — the real-world benchmark, its scenarios, metrics and report;
  [release procedure and gates](../benchmark.md).
* [Architecture decisions](decisions.md) — why things are the way they are.
* [Contributing](contributing.md) — ground rules (spec first, both implementations, one
  behaviour), development commands, these docs.
* [Porting the core to TypeScript](../dev/porting.md) — how the TypeScript engine mirrors
  the Rust core.

## Repository layout

```text
spec/          JSON Schemas, prose spec, defaults table, presets, expression grammar
conformance/   language-neutral test cases used by every implementation
fonts/         bundled Noto Sans subset (SIL OFL 1.1)
rust/          the core and its bindings: la-core, la-text, la-expr, la-svg, la-raster,
               la-render, la-cli, la-wasm, la-py, la-capi, and the label-anything facade
ts/            pure TypeScript implementation (@label-anything/core, text, svg, raster, cli)
               and the WebAssembly package (@label-anything/wasm)
bindings/      Java (FFM/JNI), Python extras (matplotlib, Plotly, seaborn), JS extras
bench/         real-world benchmark: scenarios, evaluator, baselines, report, gates
docs/          this site, the binding guides and the ADRs
examples/      runnable examples per language, the tutorials of this site
tools/         code generation and maintenance scripts
```

## Citing

If you use Label Anything in research, please cite the methods it builds on; the
repository's [`CITATION.cff`](gh:CITATION.cff) lists them.
