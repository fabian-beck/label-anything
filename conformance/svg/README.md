# `svg` conformance cases

Cases for SVG backgrounds (spec §4.5): parsing, styling, geometry, text boxes and
classification. Both implementations run every file in this directory:

* Rust: `cargo test -p label-anything-svg --test conformance` (from `rust/`)
* TypeScript: `npx vitest run packages/svg` (from `ts/`)

Expected values are derived analytically (areas, lengths and boxes of the ideal shapes),
not copied from an implementation; the tolerances absorb curve flattening.

## Format

```jsonc
{
  "kind": "svg",
  "name": "short name",
  "description": "what is tested and how the expectations were derived",
  "svg": "<svg …>…</svg>",          // or an array of lines, joined with "\n"
  "canvas": { "width": 400, "height": 100 },  // optional target canvas size
  "tolerance": 0.1,                  // optional flattening tolerance (default 0.25 px)
  "classes": [ { "selector": "circle", "class": "points" } ],  // class rules, first match wins
  "preset": "auto",                  // instead of "classes": spec/presets/<preset>.json#svg_classes
  "default_class": "ink",            // default "ink"; may be "ignore"
  "expect": { … }                    // see below; every listed property must hold
}
```

Without `classes` and `preset` the rule list is empty (everything gets `default_class`).

### `expect`

| key | meaning |
|---|---|
| `error` | `parse(svg)` must fail with this code (nothing else is checked) |
| `classify_error` | `classify` must fail with this code (class checks are skipped) |
| `width`, `height` | viewport size in px (±1e-6 relative) |
| `canvas_width`, `canvas_height` | canvas size |
| `element_count` | number of elements (all XML elements, document order) |
| `warnings` | multiset of warning codes (exact) |
| `classes` | per class: a **summary** (below) of its classified primitives |
| `exact_classes` | default `true`: no other class may occur |
| `elements` | by `id`: `tag`, `drawn`, `filled`, `stroked` (exact), `bbox` (`[x, y, w, h]` or `null`) |
| `select` | list of `{ "selector", …summary, "outline": summary }` or `{ "selector", "error": code }` |
| `geometry` | list of `{ "id", …summary, "outline": summary }` for `element_geometry`; `"missing": true` if the id must not exist |
| `regions` | list of `{ "selectors", "count", "order", "elements" }` for `regions` (spec §4.8): `count` fills in all, `order` the ids of the region elements in order of their first fill, and per region element (by id) its `rule` and a summary of its fills; or `{ "selectors", "error": code }` |
| `tol` | `{ "area", "length", "bbox" }` overrides of the tolerances below |

A **summary** of a list of primitives may contain:

| key | meaning | tolerance |
|---|---|---|
| `count` | number of primitives | exact |
| `polygons`, `polylines`, `rects` | number by type | exact |
| `vertices` | total points of polygon rings and polylines | exact |
| `fill_area` | Σ area of the polygons, each under its fill rule | ±1 % (at least ±0.5 px²) |
| `stroke_length` | Σ length of the polylines (closed ones include the closing edge) | ±1 % (at least ±0.05 px) |
| `stroke_width` | `[min, max]` of the polyline widths | ±1 % |
| `bbox` | `[x, y, w, h]` of all polygon/polyline points and rect corners (stroke width not included) | ±0.5 px |

**Area under a fill rule** (same algorithm in both runners): collect the non-horizontal
edges of all rings; events are all vertex ordinates plus the ordinates of proper edge
intersections; between consecutive events the covered width is linear, so the area is
`Σ (y₁ − y₀) · width((y₀ + y₁)/2)`, where `width(y)` sums the x-intervals between sorted
edge crossings whose winding number is non-zero (`nonzero`) or odd (`evenodd`). Overlapping
primitives are summed, not unioned.

## Error codes

| code | when |
|---|---|
| `parse` | not well-formed XML (message contains line and column) |
| `invalid_value` | the root is not `<svg>`, the viewport has no positive size, or invalid options |
| `pattern` | selector syntax error (class rules, `select`, `from_svg` selectors) |
| `limit` | nesting deeper than 1024 elements, more than 1 000 000 elements, `<use>` expansion beyond 2 000 000 rendered elements, more than 8 000 000 points |

Warnings (`Scene.warnings`): `ignored` (a `<use>` with a missing, external or circular
reference) and `limit` (content deeper than 384 render levels was skipped).

## Parity of the two implementations

The cases above check properties; beyond them, the Rust crate and the TypeScript package
must produce *identical* results. `ts/packages/svg/scripts/parity.mjs` runs every case of
this directory and a seeded stream of random documents (valid, invalid and truncated
markup, DTD entities, namespaces, CSS, `<use>`, `<switch>`, text, …) through both and
compares the complete scenes (every element, flag, box, vertex and warning code), the
classification and `select` results; numbers must agree to 1e-9 relative, error and
warning codes exactly (messages are not compared). From `ts/`:

```sh
npx tsc -b packages/svg
node packages/svg/scripts/parity.mjs 2000 1   # count, seed
```

It builds the Rust example `dump` (`--features serde`), which prints scenes as the same
JSON the TypeScript package returns.
