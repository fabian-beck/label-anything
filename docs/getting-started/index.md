# Getting started

Every implementation solves the same problem format (`problem.v1`, a JSON Schema) and
returns the same result format (`result.v1`). Pick the package for your environment:

| Environment | Package | Engine | Page |
|---|---|---|---|
| Python ≥ 3.9 | `pip install label-anything` (`label_anything`), plotting helpers `label-anything[matplotlib]` / `[plotly]` / `[seaborn]` | Rust core (PyO3) | [Python](python.md) |
| Browsers, Node, Deno, Bun | `npm install @label-anything/core` | pure TypeScript | [JavaScript and TypeScript](javascript.md) |
| Browsers, Node (WebAssembly) | `npm install @label-anything/wasm` | Rust core compiled to WebAssembly, same API | [JavaScript and TypeScript](javascript.md#webassembly) |
| d3, Observable Plot, Vega, Leaflet, MapLibre, Cytoscape, sigma | `npm install @label-anything/extras` | either of the two above | [JavaScript and TypeScript](javascript.md#visualization-libraries) |
| Java 17+ (JNI), 22+ (FFM) | Maven `io.github.fabian-beck:label-anything` | Rust core (`liblabelanything`) | [Java](java.md) |
| C, C++, Go, anything with a C FFI | `liblabelanything` + `label_anything.h` | Rust core | [C and Go](c-go.md) |
| Shell, any language with JSON and processes or HTTP | `label-anything` (Rust) or `label-anything-ts` (Node) | Rust core / TypeScript | [CLI and HTTP server](cli.md) |
| Rust | the `label-anything` crate (`place(&serde_json::Value)`) | Rust core | [`rust/crates/label-anything`](gh:rust/crates/label-anything/src/lib.rs) |

!!! note "Not in the package registries yet"

    The packages are not published to PyPI, npm, Maven Central or crates.io yet, so the
    `pip install`, `npm install` and Maven lines on these pages do not work yet. Until
    they do, [install from this repository](#install-from-this-repository).

## Install from this repository

Clone the repository; every command below runs from its root. You need Rust ≥ 1.88
([rustup](https://rustup.rs)) for everything but the pure TypeScript packages, which
need only Node ≥ 18.

```sh
git clone https://github.com/fabian-beck/label-anything
cd label-anything
```

**Python.** Build the wheel with [maturin](https://www.maturin.rs/), then install it
together with the plotting helpers (`label-anything-extras`) into your environment:

```sh
pip install maturin
maturin build --release -m rust/crates/la-py/Cargo.toml
pip install rust/target/wheels/label_anything-*.whl bindings/python-extras
pip install matplotlib plotly seaborn      # the plotting libraries you use
```

**JavaScript and TypeScript.** Build the workspace and pack the packages as tarballs, then
install them into your project *together*: `@label-anything/core` depends on its sibling
packages `text`, `svg` and `raster`, which npm cannot fetch from the registry yet.

```sh
npm ci && npm run build
mkdir -p ../la-packages
npm pack -w @label-anything/text -w @label-anything/svg -w @label-anything/raster \
         -w @label-anything/core -w @label-anything/extras --pack-destination ../la-packages
cd ../my-project && npm install ../la-packages/*.tgz
```

The WebAssembly package needs a Rust toolchain for WebAssembly as well: see
[building `@label-anything/wasm`](../bindings/wasm.md#building-from-source).

**Command line.** `cargo install --path rust/crates/la-cli` puts `label-anything` on your
`PATH`.

**Java, C and Go.** Build the native library with
`cargo build --release --manifest-path rust/Cargo.toml -p label-anything-capi` (add
`--features jni` for Java); the [Java](java.md) and [C and Go](c-go.md) pages continue
from there.

## The smallest problem

A problem needs only `items`: each has an `anchor` (where the labeled feature is) and a
`label` (what to place). Everything else has a default (the
[defaults table](../reference/defaults.md)); without a `canvas`, the canvas is taken from
a background image or left unbounded.

```json
{
  "canvas": { "width": 400, "height": 300 },
  "items": [
    { "id": "a", "anchor": { "type": "point", "x": 100, "y": 100 }, "label": { "type": "text", "text": "Alpha" } },
    { "id": "b", "anchor": { "type": "point", "x": 104, "y": 102 }, "label": { "type": "text", "text": "Beta" } }
  ]
}
```

The result has one placement per item, in input order: the label `box` in canvas pixels
(origin top-left, y down), where it sits relative to its anchor (`anchor_side`), the
candidate `model` (`adjacent`, `slider`, `internal`, `distant`, `boundary`), a `leader`
when it has one, and for omitted labels a `reason`. `stats` summarizes the solve; its
`hard_violations` and `leader_crossings` come from an independent verification pass and
are 0.

Next: the [tutorials](../tutorials/index.md) solve typical tasks step by step; the
[concepts](../concepts/index.md) explain the format section by section.
