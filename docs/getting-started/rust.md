# Rust

The crate `label-anything` is the engine itself: the other packages are bindings to it.
It takes a problem as a `serde_json::Value` (or as JSON text) and returns the result the
same way; the [problem](../concepts/problem.md) and [result](../concepts/result.md)
formats are those of every other language.

## Install

```toml
[dependencies]
label-anything = "0.1"
serde_json = "1"
```

The crate is not on crates.io yet. Until then, depend on a clone of the repository (Rust ≥
1.88):

```toml
[dependencies]
label-anything = { path = "../label-anything/rust/crates/label-anything" }
serde_json = "1"
```

| Feature | Default | |
|---|---|---|
| `parallel` | on | data-parallel phases on all cores (rayon); results do not depend on the number of threads |
| `decode` | on | PNG, JPEG and WebP raster backgrounds; raw RGBA works without it |
| `std-clock` | on | the system clock for the solver's time guard; leave it out on `wasm32-unknown-unknown` |

## Place

```rust
--8<-- "rust/crates/label-anything/examples/getting_started.rs:place"
```

`place` validates the problem and solves it. The result has one placement per item, in
input order. `place_json(&str)` does the same on JSON text and returns JSON text; its
error is a JSON array of the errors.

## Invalid problems

An invalid problem is a `PlaceError` with every error: the JSON pointer of the value, a
[code](../concepts/errors.md) and a message. `PlaceError` implements `std::error::Error`,
so `?` works. `validate` returns the same errors without solving, and the warnings.

```rust
--8<-- "rust/crates/label-anything/examples/getting_started.rs:invalid"
```

## Files and the debug overlay

`place` reads the files a problem names (`obstacles.svg.path`, a raster `source`, a font
`file`) relative to the working directory. `place_with` takes the environment of the
solve: `NativeEnv::with_base_dir` resolves relative paths against another directory, and
an environment whose field `allow_files` is `false` reads no files, for problems from an
untrusted source.
`render_svg` draws the [debug overlay](../concepts/debug-overlay.md) of a result.

```rust
--8<-- "rust/crates/label-anything/examples/getting_started.rs:render"
```

## Your own environment

The trait `Env` is everything the engine asks its host: files, the clock, text
measurement, a priority and a cost callback, progress and cancellation. Every method has
a default, so an environment implements only what it changes. Here text is measured as
the host will draw it:

```rust
--8<-- "rust/crates/label-anything/examples/getting_started.rs:env"
```

## The parts

The engine is a set of crates; `label-anything` wires them together.

| Crate | |
|---|---|
| `label-anything-core` | validation, candidates, costs, the solver; no I/O |
| `label-anything-text` | fonts, text measurement, line breaking |
| `label-anything-expr` | the [expression language](../reference/expressions.md) and deterministic math |
| `label-anything-svg` | SVG backgrounds as obstacle geometry |
| `label-anything-raster` | raster backgrounds as coverage grids |
| `label-anything-render` | the debug overlay |
| `label-anything-cli` | the [command line](cli.md) |
| `label-anything-capi` | the [C ABI](c-go.md) |

The program on this page is
[`rust/crates/label-anything/examples/getting_started.rs`](gh:rust/crates/label-anything/examples/getting_started.rs):

```sh
cargo run --manifest-path rust/Cargo.toml -p label-anything --example getting_started
```
