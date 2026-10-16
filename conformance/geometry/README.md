# `geometry` fixture

`core-geometry.json` holds deterministic pseudo-random inputs (PCG32, fixed seed) and
the outputs the Rust core (`label-anything-core`) computes for them:

| section | what is evaluated |
|---|---|
| `math` | `minf`, `maxf`, `clampf`, `sign_eps`, `cmp_f64`, `len2d` on special values (±0, ±∞, NaN) |
| `point`, `rect`, `affine` | `P`, `Rect` and `Affine` methods |
| `segment` | `orient`, point–segment and segment–segment distances, proper crossings, Liang–Barsky clipping, segment–rectangle overlap and distance, `bbox_of` |
| `polygon` | signed area, area under both fill rules, centroid, convex hull, winding, containment (even-odd, non-zero), boundary distance, rectangle overlap/containment/distance, polylabel |
| `shape`, `shape_pairs` | the shape kernel for circles, ellipses, rotated rounded rectangles and concave polygons with holes: fields, bbox, area, support (plain and inflated), signed distance, containment, rectangle overlap and distance, segment distance, covered length, boundary points, rectangle containment, outline (length, ends, FNV-1a hash), translation, shape–shape overlap |
| `path` | SVG path flattening with every command (arcs included) and parse errors (offset, message) |
| `grid` | `GridSpec` geometry and `quantize` |
| `raster` | coverage grids of the vector rasterizer (discs, rects, capsules, polygons, shapes, touched segments), byte for byte (base64) |
| `sat` | summed-area tables: integrals, covered areas, `any`, blocks and cells of fractional rectangles |
| `dt` | distance transform values and the free-space seeds (`dt_maxima`) |
| `index` | static and dynamic spatial index query results, in order |

Each section is a list of `{"in": …, "out": …}` cases. Floats are JSON numbers in
shortest round-trip form (exact for `JSON.parse`); the strings `"inf"`, `"-inf"` and
`"nan"` stand for non-finite values. Coverage and occupancy grids are base64 of the
row-major `u8` cells.

* Producer: `rust/crates/la-core/examples/geom_oracle.rs`. Regenerate from `rust/` with
  `cargo run -p label-anything-core --example geom_oracle`; `-- --check` fails when the
  committed file is stale, and so does `cargo test -p label-anything-core --test geom_oracle`.
* Consumer: `ts/packages/core/test/geometry-oracle.test.ts`, which recomputes every output
  with `@label-anything/core` and compares it with `Object.is` (bit-identical, `-0 ≠ +0`).
