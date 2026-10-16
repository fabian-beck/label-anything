# CLI and HTTP server

`label-anything` is the command-line interface of the Rust engine: `place`, `render`,
`validate`, `bench` and `serve`. `label-anything-ts` (npm `@label-anything/cli`) offers
`place`, `validate` and `render` on the TypeScript engine. Both read `-` as stdin and
write `-` as stdout.

```sh
cargo install --path rust/crates/la-cli      # or: cargo build --release -p label-anything-cli
npm install -g @label-anything/cli           # label-anything-ts
```

## Place, render, validate

```sh
--8<-- "examples/tutorials/cli/basics.sh:place"
```

* `place problem.json -o result.json`: solve. `--debug-svg out.svg` also writes the
  [debug overlay](../concepts/debug-overlay.md) with the cost heatmaps; `--time` sets
  `solver.time_budget_ms`, `--seed` `solver.seed`, `--strategy` `solver.strategy`
  (`greedy` skips the local search), `--pretty` indents the JSON. Relative file paths in
  the problem resolve against the problem file's directory.
* `render problem.json result.json -o overlay.svg` draws the overlay of an existing
  result; `-o overlay.png` rasterizes it (with the bundled Noto Sans).
* `validate problem.json` prints errors and warnings and exits with 1 when the problem is
  invalid; `--json` prints the report.

Exit codes: 0 success, 1 invalid problem, 2 any other error.

```sh
--8<-- "examples/tutorials/cli/basics.sh:pipes"
```

## Anchors from a CSV file

`place --anchors file.csv` builds the problem from a CSV with `x`, `y` and label columns
(`--x-col`, `--y-col`, `--labels-col`, `--id-col`, `--priority-col`); other numeric
columns become `attrs`. `--background` adds an SVG or raster file, `--preset`,
`--canvas WxH`, `--font-size`, `--omission` and `--max-labels` set the corresponding
options.

```sh
--8<-- "examples/tutorials/cli/basics.sh:csv"
```

## Invalid problems

```sh
--8<-- "examples/tutorials/cli/basics.sh:invalid"
```

```text
error   /items/0/anchor/y [required] missing required property 'y'
error   /items/0/label [required] missing required property 'label'
exit code 1
```

## HTTP server

`label-anything serve` answers `POST /place` (the result, or HTTP 422 with
`{"errors": [...]}`) and `POST /validate` with a problem as the request body, and
`GET /health`. Responses allow any origin (CORS). It listens on 127.0.0.1:7077 by default
(`--host`, `--port`); relative file paths in problems resolve against its working
directory.

```sh
--8<-- "examples/tutorials/cli/serve.sh:serve"
```

## The TypeScript CLI

```sh
--8<-- "examples/tutorials/cli/ts-cli.sh:ts"
```

## Benchmark

`label-anything bench` runs the real-world benchmark (`bench/run.py`) with this binary as
the `rust` solver: `--suite quick|full`, `--baselines`, `--perf`, `--gate`,
`--previous results.json`; see the [benchmark](../project/benchmark.md).

All scripts on this page are in [`examples/tutorials/cli`](gh:examples/tutorials/cli) and
run in CI.
