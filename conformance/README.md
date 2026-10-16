# Conformance suite

Language-neutral test cases shared by every implementation. Runners:

* Rust: `cargo test -p label-anything --test conformance` (reads this directory)
* TypeScript: `npm --prefix ts run conformance`
* Python (schema cross-check + evaluator): `python3 conformance/check_schema.py`

Every file is one JSON object with a `kind`:

| directory | kind | what is tested |
|---|---|---|
| `problems/` | — | sample problems (valid). Referenced by cases, used by `validate` acceptance (M0). |
| `validate/` | `validate` | `validate(problem)` → valid flag, error/warning pointers and codes |
| `place/` | `place` | `place(problem)` → properties of the result |
| `text/` | `text` | text widths (±0.01 px), line breaking, wrapping, truncation |
| `expr/` | `expr` | expression language results and errors |
| `math/` | `math` | deterministic math (`det_math`) and PCG32, bit-exact vectors (see `math/README.md`) |

## `validate` cases

```jsonc
{
  "kind": "validate",
  "name": "duplicate ids",
  "problem": { ... } | "problem_file": "../problems/scatter-basic.json",
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
reserved), `ignored` (an option that has no effect in this context).

Pointers are RFC 6901 JSON Pointers into the problem. For `unknown_property` the pointer
points at the offending property; for `required` at the object missing it.

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
    "inside_canvas": true,             // every box inside canvas minus padding
    "prefix": true,                    // placed set is a prefix of the priority order
    "deterministic": true,             // two runs give identical placements
    "touch_gap_max": 0.5,              // adjacent labels touch their inflated mark
    "text_lines": { "a": ["org.example.", "Foo"] },
    "box": { "a": { "x": 10, "y": 20, "w": 30, "h": 16, "tol": 0.01 } }
  }
}
```

All listed properties must hold; unlisted properties are not checked.

## `text` cases

```jsonc
{ "kind": "text", "name": "...", "font": { "family": "default", "weight": 400 },
  "size": 12,
  "widths": [ { "text": "Hello, World", "width": 71.244, "tol": 0.01 } ],
  "wrap": [ { "text": "org.example.Foo", "max_width": 60, "max_lines": 3,
              "lines": ["org.example.", "Foo"] } ],
  "balanced": [ { "text": "...", "lines_target": 2, "lines": ["...", "..."] } ],
  "truncate": [ { "text": "...", "max_width": 50, "mode": "middle", "result": "org…Foo" } ] }
```

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
