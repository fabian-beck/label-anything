# Getting started

Every package reads the same problem (`problem.v1`) and returns the same result
(`result.v1`), both JSON. Pick the one for your environment:

| Environment | Package | Page |
|---|---|---|
| Python ≥ 3.9 | `label-anything`; plotting helpers `label-anything-extras` | [Python](python.md) |
| Browsers, Node, Deno, Bun | `@label-anything/core` (TypeScript) or `@label-anything/wasm` (the Rust core) | [JavaScript and TypeScript](javascript.md) |
| d3, Observable Plot, Vega, Leaflet, MapLibre, Cytoscape, sigma | `@label-anything/extras` | [JavaScript and TypeScript](javascript.md#visualization-libraries) |
| Java 17+ | `io.github.fabian-beck:label-anything` (Maven) | [Java](java.md) |
| C, C++, Go, anything with a C FFI | `liblabelanything` and `label_anything.h` | [C and Go](c-go.md) |
| Shell, or any language that runs processes or speaks HTTP | `label-anything` or `label-anything-ts` | [CLI and HTTP server](cli.md) |
| Rust | the `label-anything` crate (`place(&serde_json::Value)`) | [`rust/crates/label-anything`](gh:rust/crates/label-anything/src/lib.rs) |

!!! note "Not in the package registries yet"

    The packages are not yet on PyPI, npm, Maven Central or crates.io. Until they are,
    each page shows how to build its package from a clone of the repository:

    ```sh
    git clone https://github.com/fabian-beck/label-anything
    ```

## The smallest problem

A problem needs only `items`, each with an `anchor` (where the labeled feature is) and a
`label` (what to place); everything else has a [default](../reference/defaults.md).

```json
{
  "canvas": { "width": 400, "height": 300 },
  "items": [
    { "id": "a", "anchor": { "type": "point", "x": 100, "y": 100 }, "label": { "type": "text", "text": "Alpha" } },
    { "id": "b", "anchor": { "type": "point", "x": 104, "y": 102 }, "label": { "type": "text", "text": "Beta" } }
  ]
}
```

The result has one placement per item, in input order: the label's `box` (canvas pixels,
origin top-left, y down), its `leader` if it has one, or, for an omitted label, the
`reason`; `stats` summarizes the solve ([the result format](../concepts/result.md)).

Next: the [tutorials](../tutorials/index.md) solve typical tasks step by step; the
[concepts](../concepts/index.md) explain the format section by section.
