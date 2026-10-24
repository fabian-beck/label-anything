# Errors and validation

Every implementation validates a problem completely before solving it and reports **all**
errors at once, each as an issue:

```json
{
  "valid": false,
  "errors": [
    { "pointer": "/items/0/anchor/y", "code": "required", "message": "missing required property 'y'" },
    { "pointer": "/defaults/padding", "code": "unit", "message": "invalid length \"3qq\": use a number (px) or <number>px|pt|em" }
  ],
  "warnings": [
    { "pointer": "/avoid/label/lnies", "code": "unknown_class", "message": "class 'lnies' is not produced by any obstacle source" }
  ]
}
```

`pointer` is a JSON Pointer (RFC 6901) into the problem; `code` is stable and the same in
every implementation (CI checks the validators against the JSON Schema and each other);
`message` is for humans and may change.

## Validating

| | Validate | An invalid problem when solving |
|---|---|---|
| Python | `la.validate(problem)` → `Report(valid, errors, warnings)`, never raises | `la.ValidationError` (a `ValueError`) with `.errors` |
| JavaScript / WebAssembly | `validate(problem)` → `{valid, errors, warnings}` | `PlaceError` with `.errors` |
| Java | `LabelAnything.validate(problem or json)` → `ValidationReport` | `LabelAnythingException`, `code()` `INVALID`, `.issues()` |
| C | `la_validate_json(problem, &report)` → `LA_OK` / `LA_INVALID` | `la_place_json` returns `LA_INVALID`, `*result` is the error array |
| CLI | `label-anything validate p.json` (`--json` for the report) | exit code 1, issues on stderr |
| HTTP | `POST /validate` → the report | `POST /place` → HTTP 422, `{"errors": [...]}` |

Warnings never stop a solve; the result repeats them in `result.warnings`.

## Error codes

| Code | Meaning |
|---|---|
| `parse` | not valid JSON (or, for an SVG background, not well-formed XML) |
| `type` | wrong JSON type (also `NaN` and `Infinity` in a JavaScript object, which JSON cannot represent) |
| `required` | a required property is missing (also `canvas` when `y_axis` is `"up"`) |
| `unknown_property` | a property that is not allowed here (often a typo: the message names the closest property, e.g. `(did you mean 'width'?)`) |
| `enum`, `const` | a value outside the allowed set; `version` other than `"1"` |
| `range` | a number out of range (e.g. a width ≤ 0, a weight < 0, a non-integer count) |
| `length` | an array or string too short or too long (e.g. a polygon with 2 points) |
| `pattern` | a string in the wrong form (class names, `shrink:f`, `partial:f`, SVG selectors outside the supported subset) |
| `unit` | an invalid length string |
| `exclusive` | mutually exclusive alternatives, or none of them (`svg.source` and `svg.path`) |
| `unique` | duplicate entries where they must be unique |
| `duplicate_id` | two items with the same id (explicit or implicit) |
| `unknown_ref` | `keep_with` names an unknown item id |
| `expr_syntax`, `expr_unknown_identifier`, `expr_arity` | an [expression](../reference/expressions.md) that does not parse |
| `unsupported` | reserved for a later version (anchor type `line`), or a feature missing in this build |
| `invalid_value` | semantically invalid: non-finite numbers, degenerate shapes, and the preparation errors below |
| `limit` | a size limit: grids over 16 million cells, SVGs nested too deeply or with too many elements |

**Warnings:** `unknown_class` — an `avoid` key that is neither produced by an obstacle
source nor a reserved class; `unknown_attr` — a priority term on an attribute that no item
has (the term is 0 for every item, so it ranks nothing); `ignored` — an option without
effect in its context; `limit` — SVG content too deep to render, skipped.

## Errors while preparing

Some problems show only when the engine reads the backgrounds: a file that cannot be read,
an image that does not decode, an SVG that is not well-formed. They are reported like
validation errors, with code `invalid_value` at the offending field and the cause in the
message: `invalid_base64`, `invalid_data_url`, `unsupported_format`, `corrupt_image`,
`invalid_dimensions`, `limit_exceeded` or `unsupported` (no decoder in this build) for
images, `parse` or `limit` for SVG:

```text
label-anything: /obstacles/raster/source invalid_value: not a PNG, JPEG or WebP image (unsupported_format)
label-anything: /obstacles/svg/path invalid_value: cannot read missing.svg: No such file or directory (os error 2)
```

The CLI exits with code 2 for these; 1 is for problems that fail validation.

## Panics and other failures

Malformed input never crashes the engine: the parsers, the raster decoders and the solver
are fuzzed continuously. An internal error is a bug — please report it. It surfaces as
`LA_ERROR` in C, `code()` `ERROR` in Java, an `Error` starting with
`label-anything: internal error` in the WebAssembly package, and exit code 2 in the CLI.
