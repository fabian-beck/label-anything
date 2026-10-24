# CLI and HTTP server

`label-anything` is the command-line interface of the Rust engine: `place`, `render`,
`validate`, `bench` and `serve`. `label-anything-ts` (npm `@label-anything/cli`) offers
`place`, `validate` and `render` on the TypeScript engine. Both read `-` as stdin and
write `-` as stdout.

```sh
cargo install --path rust/crates/la-cli      # or: cargo build --release --manifest-path rust/Cargo.toml -p label-anything-cli
npm install -g @label-anything/cli           # label-anything-ts
```

`cargo build` leaves the binary in `rust/target/release/label-anything`; `cargo install`
puts it on your `PATH`, as the examples below assume.

The npm package is not published yet: pack it with its siblings as described for
[JavaScript](javascript.md#install) (add `-w @label-anything/cli`) and `npm install -g`
the tarballs.

## Place, render, validate

The examples run in [`examples/tutorials/data`](gh:examples/tutorials/data), where their
input files are (`outliers.csv`, `scatter.png`; the problems in `../problems/`).

```sh
--8<-- "examples/tutorials/cli/basics.sh:place"
```

* `place problem.json -o result.json`: solve. `--debug-svg out.svg` also writes the
  [debug overlay](../concepts/debug-overlay.md) with the cost heatmaps; `--time` sets
  `solver.time_budget_ms`, `--seed` `solver.seed`, `--strategy` `solver.strategy`
  (`greedy` skips the local search), `--degrade` the degradation ladder (comma-separated
  steps, e.g. `wrap,distant,omit`; `omit` alone turns it off), `--pretty` indents the
  JSON. Validation errors and warnings go to stderr. Relative file paths in the problem
  resolve against the problem file's directory; paths given on the command line
  (`--background`) against the current directory.
* `render problem.json result.json -o overlay.svg` draws the overlay of an existing
  result; an output ending in `.png` rasterizes it (with the bundled Noto Sans). The
  problem must be valid and the result one of this problem (a placement per item, in
  order).
* `validate problem.json` prints errors and warnings and exits with 1 when the problem is
  invalid; `--json` prints the report. Files the problem references (backgrounds, fonts)
  are read only by `place`.

The options of `place` (`--time`, `--preset`, `--canvas`, …) set their fields in a JSON
problem as well as in one built from a CSV; `--canvas WxH` sets the width and height and
keeps the other canvas options. JSON and CSV files may start with a UTF-8 byte order mark.

Exit codes: 0 success, 1 invalid problem or input (a problem that fails validation or is
not JSON, an invalid CSV, a result of another problem), 2 any other error (unreadable
files, backgrounds or fonts that cannot be loaded).

```sh
--8<-- "examples/tutorials/cli/basics.sh:pipes"
```

## Anchors from a CSV file

`place --anchors file.csv` (`-` for stdin) builds the problem from a CSV with `x`, `y`
and label columns (`--x-col`, `--y-col`, `--labels-col`, `--id-col`, `--priority-col`);
the other columns become `attrs`, as numbers where they parse as numbers. Rows with an
empty label get no label: their points become obstacles of class `points`. Coordinates
and priorities must be finite numbers (an empty priority cell leaves the item without
one); errors name the CSV row and column. `--background` adds an SVG or raster file,
`--preset`, `--canvas WxH`, `--font-size`, `--omission` and `--max-labels` set the
corresponding options.

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
`{"errors": [...]}`, also for malformed JSON) and `POST /validate` (the report; malformed
JSON is a `parse` error in it) with a problem as the request body, and `GET /health`. Responses allow any origin (CORS), and `OPTIONS` answers the preflight of
browser requests. It listens on 127.0.0.1:7077 by default (`--host`, `--port`); relative
file paths in problems resolve against its working directory. Problems may read files
(backgrounds, fonts) only when it listens on a loopback address, or with `--allow-files`:
on another `--host`, anyone who can reach the server could otherwise read files of the
machine. Requests are solved side by side, one per worker (`--workers`, default: the number
of CPUs), so a long solve does not hold up the others.

```sh
--8<-- "examples/tutorials/cli/serve.sh:serve"
```

## The TypeScript CLI

`label-anything-ts` runs the TypeScript engine with the same `place`, `validate` and
`render` options, input handling and exit codes as `label-anything` (no CSV input, PNG
output or server).

```sh
--8<-- "examples/tutorials/cli/ts-cli.sh:ts"
```

## Benchmark

`label-anything bench` runs the real-world benchmark (`bench/run.py`) with this binary as
the `rust` solver: `--suite quick|full`, `--baselines`, `--perf`, `--gate`,
`--previous results.json`; see the [benchmark](../project/benchmark.md).

All scripts on this page are in [`examples/tutorials/cli`](gh:examples/tutorials/cli) and
run in CI.
