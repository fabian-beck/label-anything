# Project

Label Anything is open source under the MIT License
([repository](https://github.com/fabian-beck/label-anything)); the bundled font, Noto Sans,
is under the SIL Open Font License 1.1.

* [Benchmark](benchmark.md) — how Label Anything compares with nine other labelers on
  real-world data, and where it still falls short.
* [Architecture decisions](decisions.md) — why the engine and the project are the way
  they are.
* [Contributing](contributing.md) — ground rules, development commands, these docs.

Notes for working on the engine live in the repository, next to what they cover:

* [`bench/README.md`](gh:bench/README.md) — running the benchmark, the release procedure,
  the state of the performance targets;
* [`ts/packages/core/PORTING.md`](gh:ts/packages/core/PORTING.md) — how the TypeScript
  engine mirrors the Rust core;
* [`docs/project/literature/`](gh:docs/project/literature/README.md) — what the research
  literature suggests, and where the engine's building blocks come from.

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
docs/          this site and the architecture decision records
examples/      runnable examples per language, the tutorials of this site
tools/         code generation and maintenance scripts
```

## Citing

If you use Label Anything in research, please cite the methods it builds on; the
repository's [`CITATION.cff`](gh:CITATION.cff) lists them.
