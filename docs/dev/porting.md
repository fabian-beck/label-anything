# Porting the Rust core to TypeScript

`ts/packages/core` (`@label-anything/core`) is a line-by-line port of
`rust/crates/la-core`. Rust is the reference: an algorithm is written and tested in
Rust first and ported right afterwards (ADR 0001). The port uses the same algorithms in
the same order with the same arithmetic, so that, for the same iteration counts, both
implementations make the same decisions. Results may still differ when the time budget
cuts a search at different points (the budgets and move rates differ, ADR 0007), but the
hard-constraint guarantees never do.

## Files

| Rust (`rust/crates/la-core/src/`) | TypeScript (`ts/packages/core/src/`) |
|---|---|
| `x.rs` | `x.ts` |
| `dir/mod.rs` | `dir/index.ts` |
| `index.rs` (spatial index) | `spatial.ts` |
| `lib.rs` (pipeline) | `place.ts`; public exports in `index.ts` |
| `generated/spec_data.rs` | `generated/spec-data.ts` (by `tools/codegen.mjs`) |
| `#[cfg(test)] mod tests` in `x.rs` | `test/x.test.ts` (same test names) |

`detmath.ts`, `pcg.ts` and `expr/` mirror `la-expr` (`det_math`, `Pcg32`, the expression
language). Text measurement comes from `@label-anything/text`, raster modes from
`@label-anything/raster`, SVG geometry from `@label-anything/svg`.

Wrapping and truncation take a `la_text::Measure`: `Measure::Font { font, size }` is a
`FontMeasure` (`{ font, size }`) in TypeScript, `Measure::Callback(&f)` a plain function.
`Measurer::wrap_measure` picks the font measure when there is no host measurement
(`Env::has_measure_callback()` is `false`; in TypeScript: no `PlaceOptions.measure`) and
shaping is `simple`, or `auto` for a text without complex scripts (ADR 0018). Both measures
give identical results, so where TypeScript lacks full shaping either choice is correct.

## Names

* Functions, methods, fields and locals: `snake_case` → `camelCase`
  (`dist_rect` → `distRect`, `even_odd` → `evenOdd`). Short field names stay
  (`x0`, `y0`, `w`, `h`).
* Types, traits and enum variants keep their names (`Rect`, `Shape`, `Block.Items`).
* Constants keep `SCREAMING_CASE`.
* A Rust method stays a method (`r.w()` → `r.w()`); do not turn methods into getters.

## Types

| Rust | TypeScript |
|---|---|
| `f64`, integers up to 2^53 | `number` |
| `u64` | only inside `Pcg32` (see `pcg.ts`) |
| `Vec<f64>` / `Vec<u8>` / `Vec<u32>` in hot paths (grids, SAT, distance transform, per-candidate arrays) | `Float64Array` / `Uint8Array` / `Uint32Array` |
| other `Vec<T>` | `T[]` |
| `Option<T>` | `T \| null` (never `undefined`) |
| `Result<T, E>` | return `T`, throw a typed error class (`BuildError`, `PlaceError`) |
| struct | `class` (with methods) or `interface` (plain data) |
| unit-only enum | `const X = { A: 0, B: 1 } as const` + `type X = (typeof X)[keyof typeof X]` in hot code; string literal unions where the Rust enum maps to a schema string |
| enum with data | discriminated union on `kind` (`{ kind: "polygon", rings, evenOdd }`) |
| trait | `interface` (optional methods for defaulted trait methods) |
| `BTreeMap<String, T>` / `BTreeSet<String>` | `Map` / `Set`, **iterated in sorted key order** with `cmpStr` |
| `HashMap` | `Map` (never iterate it for decisions) |
| `&mut Vec<u32>` result buffers of index queries | `IdList` (`spatial.ts`), reused across queries |

## Arithmetic (determinism)

* Keep the evaluation order of every expression; do not "simplify" `a * b / c` to
  `a * (b / c)` or reorder sums. Use only `+ − × ÷` and `Math.sqrt`; everything else goes
  through `detmath.ts` (`ln`, `exp`, `pow`, `sinCosDeg`, `atan2Deg`, `roundHalfAway`, …),
  which is bit-identical to `la_expr::det_math`. Never use `Math.sin`, `Math.log`,
  `Math.pow`, `**`, `Math.hypot` or `Math.round` in core code.
* Rust `f64::min`/`max` ignore a NaN operand; `Math.min`/`max` propagate it. Use
  `minf`/`maxf` from `math.ts` where Rust uses `.min()`/`.max()` on floats.
* `x as usize` / `as u32` truncate toward zero and **saturate** (negative and NaN → 0,
  too large → max). Port as `Math.trunc` plus explicit clamping (`toIndex` in `math.ts`).
  `as i64` likewise. Integer division `a / b` → `Math.trunc(a / b)`.
* `.round()` (half away from zero) → `roundHalfAway`; `.floor()`/`.ceil()`/`.trunc()`
  → `Math.floor`/`Math.ceil`/`Math.trunc` (exact).
* `wrapping_add`/`wrapping_sub` on `u32` → `(a + b) >>> 0` / `(a - b) >>> 0`.
* `f64::total_cmp` / `cmp_f64` → `cmpF64` from `math.ts`.
* Sorting: Rust `sort`/`sort_by` and JS `Array.prototype.sort` are both stable; port the
  comparator exactly. Never sort numbers without a comparator.
* Strings: Rust compares strings by UTF-8 bytes, JS by UTF-16 code units; they disagree
  above U+FFFF. Compare with `cmpStr` (code point order) wherever Rust compares or sorts
  strings. `s.len()` is UTF-8 bytes, `s.chars().count()` is code points
  (`Array.from(s).length` or a code point loop); JSON Schema lengths count code points.
* The workspace enables `serde_json`'s `preserve_order`, so Rust objects keep the key
  order of the JSON text, like JavaScript objects. They disagree only for integer-like
  keys (`"10"`), which JavaScript moves to the front; the schema has no ordered data under
  such keys (classmap keys are colours, `avoid` keys are class names).

## Performance

The TypeScript targets are in the brief (§5.8): 200 labels + 10k points ≤ 60 ms,
2,000 labels + 100k points ≤ 600 ms. Hot loops (candidate evaluation, SAT queries,
spatial index scans, rasterization) must not allocate: no closures, spreads,
`Array.map` or temporary objects per candidate; reuse scratch typed arrays. Prefer
struct-of-arrays where the Rust code uses flat arrays. The geometry kernel offers scalar
forms of its predicates for such loops (`distPointSegXY`, `segSegDistXY`,
`segOverlapsRectXY`, `Shape.signedDistanceXY`, `MaskRaster.discXY`, …): same operations,
no `P` arguments. In V8, doubles passed to or returned from a call that is not inlined
are boxed, so keep the innermost helpers small and call them from a single site in a
loop rather than from several unrolled ones. `ts/packages/core/bench/geom-bench.mjs`
(against `rust/crates/la-core/examples/geom_bench.rs`) times the geometry hot paths.

## Tests

Each Rust unit test is ported with the same name and expectations. In addition, the
TypeScript conformance runner reads the same files under `conformance/` as the Rust
runners. When a result legitimately differs (time-budget cuts), compare properties, not
placements.
