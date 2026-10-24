# Validation

The JSON Schema is the single source of truth; both implementations validate problems with
hand-written code that a reference validator cross-checks in CI.

## Context
Every implementation offers `validate(problem)` with structured errors and JSON pointers.
Generated types are the obvious start, but generators produce awkward types for this
schema, and a JSON Schema engine at runtime is large, gives generic messages and cannot
check what the schema cannot express.

## Decision
- **TypeScript**: `json-schema-to-typescript` generates the types (`tools/codegen.mjs`).
  The public API uses hand-written discriminated unions, and a type-level test asserts
  that they are assignable to the generated ones, so they cannot drift.
- **Rust**: hand-written serde types with `deny_unknown_fields`; `typify` output for this
  schema (if/then discriminators, `prefixItems`, a number-or-unit `oneOf`) is not
  idiomatic. A test deserializes every conformance problem and every schema example.
- **Validation** is hand-written in both languages: no schema engine at runtime (smaller
  bundles, no `eval`, safe under a content security policy), precise messages, and
  semantic checks such as duplicate ids, unknown `keep_with` references, expression syntax
  and unknown classes (a warning). Errors are `{pointer, code, message}`; the codes are
  shared and listed in `conformance/README.md`.
- **Cross-check**: CI validates every conformance problem with the reference validator
  (Python `jsonschema`, Draft 2020-12) and checks that both hand-written validators agree
  on what is valid.

## Consequences
A new option means a schema entry, a row in `spec/defaults.md`, both validators and a
conformance case. The cross-check keeps the hand-written validators honest.
