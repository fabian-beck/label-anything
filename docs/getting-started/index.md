# Getting started

Every implementation solves the same problem format (`problem.v1`, a JSON Schema) and
returns the same result format (`result.v1`). Pick the package for your environment:

| Environment | Package | Engine | Page |
|---|---|---|---|
| Python ≥ 3.9 | `label-anything`; plotting helpers `label-anything-extras` | Rust core | [Python](python.md) |
| Browsers, Node, Deno, Bun | `@label-anything/core` | pure TypeScript | [JavaScript and TypeScript](javascript.md) |
| Browsers, Node | `@label-anything/wasm`, the same API | Rust core as WebAssembly | [JavaScript and TypeScript](javascript.md#webassembly) |
| d3, Observable Plot, Vega, Leaflet, MapLibre, Cytoscape, sigma | `@label-anything/extras` | either of the two above | [JavaScript and TypeScript](javascript.md#visualization-libraries) |
| Java 17+ | `io.github.fabian-beck:label-anything` (Maven) | Rust core | [Java](java.md) |
| C, C++, Go, anything with a C FFI | `liblabelanything` and `label_anything.h` | Rust core | [C and Go](c-go.md) |
| Shell, or any language that runs processes or speaks HTTP | `label-anything` (Rust) or `label-anything-ts` (Node) | Rust core or TypeScript | [CLI and HTTP server](cli.md) |
| Rust | the `label-anything` crate (`place(&serde_json::Value)`) | Rust core | [`rust/crates/label-anything`](gh:rust/crates/label-anything/src/lib.rs) |

!!! note "Not in the package registries yet"

    The packages are not published to PyPI, npm, Maven Central or crates.io yet. Until
    they are, each page says how to build its package in a clone of the repository:

    ```sh
    git clone https://github.com/fabian-beck/label-anything
    ```

    Everything but the pure TypeScript packages, which need only Node ≥ 18, needs Rust
    ≥ 1.88 ([rustup](https://rustup.rs)).

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
