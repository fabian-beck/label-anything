# Conformance suite

Language-neutral test cases shared by every implementation. Runners:

* Rust: `cargo test -p label-anything --test conformance` (reads this directory)
* TypeScript: `npm run conformance` from the repository root after `npm run build` (the
  `place` cases, with the same independent re-checks); `npx vitest run` runs the
  `validate`, `place`, `parity` and the other suites of the TypeScript packages
* Python (schema cross-check + evaluator): `python3 conformance/check_schema.py`

Every file is one JSON object with a `kind`:

| directory | kind | what is tested |
|---|---|---|
| `problems/` | — | sample problems (valid). Referenced by cases, used by `validate` acceptance (M0). |
| `validate/` | `validate` | `validate(problem)` → valid flag, error/warning pointers and codes |
| `place/` | `place` | `place(problem)` → properties of the result |
| `text/` | `text` | text widths (±0.01 px), line breaking, wrapping, truncation |
| `raster/` | `raster` | image decoding, background estimation, pixel modes, coverage grids (byte for byte); see `raster/README.md` |
| `expr/` | `expr` | expression language results and errors |
| `svg/` | `svg` | SVG parsing, styles, geometry flattening, selectors and classification; see `svg/README.md` |
| `math/` | `math` | deterministic math (`det_math`) and PCG32, bit-exact vectors (see `math/README.md`) |
| `geometry/` | `geometry` | geometry kernel, rasterizer, SATs, distance transform and spatial indexes of the core: inputs and Rust outputs, reproduced bit for bit (see `geometry/README.md`) |
| `parity/` | `parity` | the Rust core's complete `place` result for every sample problem and inline `place` case, which the TypeScript core reproduces bit for bit |

## `validate` cases

```jsonc
{
  "kind": "validate",
  "name": "duplicate ids",
  "problem": { ... } | "problem_file": "../problems/scatter-basic.json"
             | "problem_files": ["../problems/a.json", "..."],   // each must satisfy expect
  "expect": {
    "valid": false,
    "errors": [ { "pointer": "/items/1/id", "code": "duplicate_id" } ],   // must all be reported
    "warnings": [ { "pointer": "/avoid/label/outlierz", "code": "unknown_class" } ],
    "exact": false            // true: no other errors may be reported
  }
}
```

Error codes (shared by all implementations):

| code | meaning |
|---|---|
| `parse` | not valid JSON |
| `type` | wrong JSON type |
| `required` | missing required property |
| `unknown_property` | property not allowed here |
| `enum` | value not one of the allowed values |
| `const` | value must equal a constant (e.g. `version`) |
| `range` | number out of range (minimum, maximum, exclusive bounds, integer) |
| `length` | array or string too short / too long |
| `pattern` | string does not match the required pattern |
| `unit` | invalid length string |
| `exclusive` | mutually exclusive alternatives (e.g. `svg.source` and `svg.path`) or none given |
| `unique` | duplicate entries where uniqueness is required |
| `duplicate_id` | two items with the same id |
| `unknown_ref` | reference to an unknown item id (`keep_with`) |
| `expr_syntax`, `expr_unknown_identifier`, `expr_arity` | expression errors |
| `unsupported` | reserved for a later version (e.g. anchor type `line`) |
| `invalid_value` | semantically invalid (non-finite number, degenerate polygon, …) |

Warning codes: `unknown_class` (an `avoid` key that no source produces and that is not
reserved), `unknown_attr` (a `priority.terms` attribute that no item has in its `attrs`),
`ignored` (an option that has no effect in this context).

Pointers are RFC 6901 JSON Pointers into the problem. For `unknown_property` the pointer
points at the offending property; for `required` at the missing property (e.g.
`/items/0/anchor/y`); for `exclusive` at the object whose alternatives conflict.

`check_schema.py` validates every problem with the JSON Schema itself (Python
`jsonschema`, Draft 2020-12) and checks that the expected `valid` flags agree with it.

## `place` cases

```jsonc
{
  "kind": "place",
  "name": "...",
  "problem": { ... } | "problem_file": "...",
  "expect": {
    "hard_violations": 0,              // stats + independent re-check by the runner
    "leader_crossings": 0,
    "priority_inversions": 0,
    "placed_min": 3, "placed_max": 5, "placed": 4,
    "placed_ids": ["a", "b"], "unplaced_ids": ["z"],
    "reasons": { "z": "no_feasible_candidate" },
    "omission_order": ["z", "y"],
    "anchor_side": { "a": "top" }, "model": { "a": "adjacent" },
    "has_leader": { "b": true },
    "stub": { "a": true },             // the label's leader is a stub (placement.stubs)
    "own_nearest": true,               // circle marks: no other item's mark is nearer to a
                                       // label without a distant leader than its own
    "max_bends": 1,                    // every leader of every placed label bends at most so often
    "underline": { "b": true },        // baseline port: the underline starts at the leader's
                                       // end on a side edge, horizontal, in the box's lower half
    "inside_canvas": true,             // every box inside canvas minus padding
    "prefix": true,                    // placed set is a prefix of the priority order
    "deterministic": true,             // two runs give identical placements
    "touch_gap_max": 0.5,              // adjacent labels (without a stub) touch their inflated mark
    "text_lines": { "a": ["org.example.", "Foo"] },
    "font": { "a": { "size": 15, "weight": 700, "class": 0 } },  // text.font_size (± 1e-6),
                                       // text.font_weight, priority.font_class (null: none)
    "box": { "a": { "x": 10, "y": 20, "w": 30, "h": 16, "tol": 0.01 } }
  }
}
```

All listed properties must hold; unlisted properties are not checked. Runners also
re-check independently that no two placed labels overlap (when `avoid.label.labels` is
hard, the default) and that no two leaders cross (when `avoid.leader.leaders` is hard).
The cases are generated by `tools/conformance/make_place_cases.py` (`--check` verifies
that the committed files are current).

## `parity` cases

The whole solve pipeline of the TypeScript core must make the same decisions as the Rust
core (ADR 0007). `parity/` holds the Rust result of every problem in `problems/`
(`<stem>.json`) and of every `place/` case with an inline problem (`place-<stem>.json`):

```jsonc
{ "kind": "parity",
  "problem_file": "../problems/scatter-basic.json",   // or "problem": { ... }
  "result": { "version": "1", "placements": [ ... ], "stats": { ... } } }
```

The results are computed without a clock (`now_ms() = 0`: no deadline, the iteration
budgets alone decide), and `stats.runtime_ms`, `stats.phases_ms` and
`stats.implementation` are left out. A runner solves the problem the same way (no clock,
the Rust budget constants) and compares the result without those three fields by deep
equality: numbers bit for bit (`-0` ≠ `0`), arrays and objects structurally, strings
exactly (key order is not compared).

The files are written by `cargo run --release -p label-anything --example place_oracle`
(`-- --check` verifies that they are current; the CI `generated` job runs it). Runner:
`ts/packages/core/test/parity.test.ts`. `ts/packages/core/test/random-problems.test.ts`
extends the comparison to random problems by running the Rust CLI
(`label-anything place - --no-clock`) when it is built.

## `text` cases

Generated by `tools/text/gen_text_cases.py` from independent references (fontTools,
checked against HarfBuzz for widths; a Python transcription of spec §5.3 for wrapping).

```jsonc
{ "kind": "text", "name": "...",
  "font": { "family": "default", "weight": 400 }      // or { "file": "fonts/x.ttf" } (relative to text/)
  "size": 12,
  "metrics": { "units_per_em": 1000, "ascender": 1069, "descender": -293, "line_gap": 0 },
  "widths": [ { "text": "AV", "units": 1199, "ink": [0, 717], "width": 14.388, "tol": 0.01 } ],
  "breaks": [ { "text": "org.example.Foo", "breaks": [3, 11] } ],   // a line may end after code point k
  "wrap": [ { "text": "org.example.Foo", "max_width": 60, "lines": ["org.example.", "Foo"] } ],  // greedy
  "balanced": [ { "text": "...", "lines_target": 2, "max_width": null, "lines": ["...", "..."] } ],
  "truncate": [ { "text": "...", "max_width": 50, "mode": "end", "result": "org.exa…" },
                { "text": "...", "max_width": 50, "mode": "middle", "max_lines": 1, "lines": ["org…Foo"] } ],
  "variants": [ { "text": "...", "options": { "max_width": 60, "max_lines": 2, "balance": true, "truncate": "end" },
                  "variants": [ { "lines": ["..."], "widths": [41.2], "truncated": false } ] } ],
  "extra_variants": [ { "text": "...", "max_lines": 2, "variants": [ ... ] } ] }
```

`units` (advance in font units) must match exactly, and so must `ink` (the lowest yMin and
the highest yMax of the text's glyphs with an outline, font units, from the font's `LAvb`
table, spec §5.2; `null`: the font has no glyph bounds, or no glyph of the text has an
outline); widths (also inside variants) within `tol` (default 0.01 px). Line feeds are
ordinary whitespace (no mandatory breaks).

## `expr` cases

```jsonc
{ "kind": "expr", "name": "...",
  "context": { "attrs": { "category": "core" } },   // optional default for all cases
  "cases": [
    { "expr": "attrs.cbo > 10 && attrs.category == 'core'",
      "context": { "attrs": { "cbo": 41, "category": "core" }, "id": "a", "index": 0 },
      "value": true, "truthy": true, "term": 1 },
    { "expr": "attrs.x +", "error": "expr_syntax", "offset": 9 }
  ] }
```

* `context` fields: `attrs` (any JSON, default `{}`), `id` (default `""`), `index`
  (default `0`), `text` (default `""`), `priority` and `tier` (number or `null`, default
  `null`), `x`, `y` (default `0`). A case's `context` overrides the file's field by field.
* `value`: the exact result. Numbers must be identical bit for bit (`-0.0` ≠ `0`; JSON
  `-0.0` denotes negative zero), strings, lists and objects structurally.
* `truthy` (optional): expected truthiness of the value; `term` (optional): expected term
  value (`number`, booleans as 1/0, `null` = missing).
* `error`: the parse must fail with this code; `offset` (optional): the error offset in
  code points. Messages are not compared.
* `note` is a comment. Runners: `cargo test -p label-anything-expr --test conformance_expr`,
  `npx vitest run packages/core/test/expr` (from `ts/`).
