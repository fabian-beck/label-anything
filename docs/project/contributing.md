--8<-- "CONTRIBUTING.md"

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

Notes for working on the engine sit next to what they cover:

* [`bench/README.md`](gh:bench/README.md) — running the benchmark, the release procedure,
  the state of the performance targets;
* [`ts/packages/core/PORTING.md`](gh:ts/packages/core/PORTING.md) — how the TypeScript
  engine mirrors the Rust core;
* [`docs/project/literature/`](gh:docs/project/literature/README.md) — what the research
  literature suggests, and where the engine's building blocks come from.

## Documentation

This site is built with [MkDocs](https://www.mkdocs.org/) and
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) from `docs/` and
`mkdocs.yml`. It is written for the people who use Label Anything:

* **Short, exact sentences**: one statement each, no filler, and the precise term (an item
  is *omitted*, not "left without a label").
* **One place per topic**, linked rather than repeated. Each language has one page; the
  concepts pages explain the formats and the engine; the specification and the defaults
  table hold the exact rules and constants.
* **Tutorials show a task**: what you want, the tested code, its result and what to
  change — not the mechanics behind it.
* **Measurements belong to the benchmark page**, with their date; other pages state the
  behaviour.
* **Notes for those who work on the engine** — profiles, procedures, research, test
  inventories — go next to what they are about (`bench/README.md`, a package's README,
  `ts/packages/core/PORTING.md`, `docs/project/literature/`), and a decision goes into its
  ADR.

```sh
python3 -m venv .venv-docs && .venv-docs/bin/pip install -r docs/requirements.txt
.venv-docs/bin/mkdocs serve                  # http://127.0.0.1:8000, rebuilds on change
.venv-docs/bin/mkdocs build --strict         # as in CI
python3 examples/tutorials/run.py cli --cli rust/target/release/label-anything   # the tutorial programs
python3 examples/tutorials/make_figures.py --cli rust/target/release/label-anything   # the figures
python3 examples/showcase/make_showcase.py --cli rust/target/release/label-anything   # the home page's figures
```

* Change a tutorial's code in `examples/tutorials/<language>/`; the page includes it by
  section (`--8<-- [start:name]` … `[end:name]` comments in the file).
* `examples/tutorials/data/make_data.py` writes the tutorial data; CI checks that the
  committed files are current (`--check`).
* The specification, defaults, presets, expression grammar and API definitions are
  included from their source files: change them there.
* Architecture decisions appear in the navigation and the [index](decisions/index.md) by area;
  the build fails on a record without its sections.
* The home page's header (`docs/_overrides/home.html`) is live only with the playground
  next to the site, as on GitHub Pages: `mkdocs serve` shows its static logo. To see it
  live, build the playground (`npm run build -w @label-anything/playground`), copy
  `ts/packages/playground/dist/` to `site/playground/` after `mkdocs build` and serve
  `site/` ([ADR project/playground](../adr/project/playground.md)).

The site is deployed to GitHub Pages after the CI run of a release tag (`v*`), after the
weekly CI run of `main`, and on demand (`.github/workflows/pages.yml`).
