--8<-- "CONTRIBUTING.md"

## Documentation

This site is built with [MkDocs](https://www.mkdocs.org/) and
[Material for MkDocs](https://squidfunk.github.io/mkdocs-material/) from `docs/` and
`mkdocs.yml`; code shown on its pages is included from `examples/tutorials/`, which CI
runs. It is written for the people who use Label Anything:

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
* Architecture decisions are `docs/adr/<area>/<name>.md`
  ([ADR project/decision-records](../adr/project/decision-records.md)) and appear in the
  navigation and the [index](decisions.md) by area. The build fails on a record without
  its sections and on a citation of a record that does not exist.
* The home page's header (`docs/_overrides/home.html`) is live only with the playground
  next to the site, as on GitHub Pages: `mkdocs serve` shows its static logo. To see it
  live, build the playground (`npm run build -w @label-anything/playground`), copy
  `ts/packages/playground/dist/` to `site/playground/` after `mkdocs build` and serve
  `site/` ([ADR project/playground](../adr/project/playground.md)).

The site is deployed to GitHub Pages from release tags (`v*`) and on demand
(`.github/workflows/pages.yml`).
