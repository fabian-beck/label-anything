# CLI and HTTP server

`label-anything` is the command-line interface of the Rust engine, with the commands
`place`, `render`, `validate`, `bench` and `serve`. `label-anything-ts` (npm
`@label-anything/cli`) runs `place`, `validate` and `render` on the TypeScript engine. For
both, `-` means stdin or stdout.

```sh
cargo install --path rust/crates/la-cli      # or: cargo build --release --manifest-path rust/Cargo.toml -p label-anything-cli
npm install -g @label-anything/cli           # label-anything-ts
```

`cargo build` leaves the binary in `rust/target/release/label-anything`; `cargo install`
puts it on your `PATH`, as the examples below assume. The npm package is not published
yet: pack it with its siblings as for [JavaScript](javascript.md#install) (adding
`-w @label-anything/cli`) and `npm install -g` the tarballs.

## Place, render, validate

The examples run in [`examples/tutorials/data`](gh:examples/tutorials/data), next to their
input files (`outliers.csv`, `scatter.png`; the problems are in `../problems/`).

```sh
--8<-- "examples/tutorials/cli/basics.sh:place"
```

`place problem.json -o result.json` solves a problem and prints validation errors and
warnings to stderr. Relative paths in the problem resolve against the problem file's
directory; paths on the command line (`--background`) against the current directory.
Options, for a JSON problem as for one built [from a CSV file](#anchors-from-a-csv-file):

* `--debug-svg out.svg` also writes the [debug overlay](../concepts/debug-overlay.md),
  with cost heatmaps;
* `--time`, `--seed` and `--strategy` set `solver.time_budget_ms`, `solver.seed` and
  `solver.strategy` (`greedy` skips the local search);
* `--degrade` sets the degradation ladder as comma-separated steps (`wrap,distant,omit`;
  `omit` alone turns it off);
* `--preset`, `--canvas WxH`, `--font-size`, `--omission` and `--max-labels` set those
  options; `--canvas` keeps the other canvas options;
* `--pretty` indents the JSON.

`render problem.json result.json -o overlay.svg` draws the overlay of an existing result,
as a PNG if the output name ends in `.png`. The problem must be valid and the result must
belong to it: one placement per item, in order.

`validate problem.json` prints errors and warnings and exits with 1 if the problem is
invalid; `--json` prints the report instead. Only `place` reads the files a problem names
(backgrounds, fonts).

Exit codes: 0 for success; 1 for invalid input (a problem that fails validation or is not
JSON, an invalid CSV, the result of another problem); 2 for any other error (unreadable
files, backgrounds or fonts that cannot be loaded).

```sh
--8<-- "examples/tutorials/cli/basics.sh:pipes"
```

## Anchors from a CSV file

`place --anchors file.csv` (`-` for stdin) builds the problem from a CSV file with `x`,
`y` and label columns; `--x-col`, `--y-col`, `--labels-col`, `--id-col` and
`--priority-col` name the columns. Other columns become `attrs`, as numbers where they
parse as numbers. Rows with an empty label become obstacles of class `points`.
Coordinates and priorities must be finite numbers; an empty priority cell leaves the item
without one. Errors name the row and column. `--background` adds an SVG or raster file.

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

`label-anything serve` answers HTTP requests with a problem as the request body:

| Request | Response |
|---|---|
| `POST /place` | the result, or HTTP 422 with `{"errors": [...]}` (also for malformed JSON) |
| `POST /validate` | the report (malformed JSON is a `parse` error in it) |
| `GET /health` | `{"name": "label-anything", "version": …}` |

* It listens on 127.0.0.1:7077 (`--host`, `--port`) and allows any origin (CORS).
* Problems may read files (backgrounds, fonts) only while it listens on a loopback address,
  or with `--allow-files`: on another `--host`, anyone who can reach the server could
  otherwise read files of the machine. Relative paths resolve against its working
  directory.
* Requests are solved side by side, one per worker (`--workers`, default: the number of
  CPUs).

```sh
--8<-- "examples/tutorials/cli/serve.sh:serve"
```

## The TypeScript CLI

`label-anything-ts` takes the same options as `label-anything` and returns the same exit
codes, but has no CSV input, PNG output or server:

```sh
--8<-- "examples/tutorials/cli/ts-cli.sh:ts"
```

## Benchmark

`label-anything bench` runs the [real-world benchmark](../project/benchmark.md)
(`bench/run.py`) with this binary as the `rust` solver; options: `--suite quick|full`,
`--baselines`, `--perf`, `--gate`, `--previous results.json`.

The scripts on this page are in [`examples/tutorials/cli`](gh:examples/tutorials/cli).
