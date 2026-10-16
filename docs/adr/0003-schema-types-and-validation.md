# 0003 — Schema-derived types and validation

* Status: accepted
* Date: 2026-10-16

## Context
The JSON Schema (2020-12) is the single source of truth. The brief suggests generating
Rust and TS types (`typify`, `json-schema-to-typescript`) and hand-writing idiomatic
wrappers; every implementation ships `validate(problem)` with structured errors and JSON
pointers.

## Decision
* **TypeScript:** `json-schema-to-typescript` generates `ts/packages/core/src/generated/
  {problem,result}.ts` (via `tools/codegen.mjs`). The public API uses hand-written,
  precise discriminated unions (`types.ts`); a type-level test asserts they are
  assignable to the generated types, so they cannot drift from the schema.
* **Rust:** hand-written serde types. `typify` output for this schema (if/then
  discriminators, `prefixItems`, `oneOf` of number|unit-string) is not idiomatic and would
  still need a wrapper layer. Instead, a test deserializes every conformance problem and
  every schema example, and `#[serde(deny_unknown_fields)]` mirrors
  `additionalProperties: false`.
* **Validation** is hand-written in both languages (no JSON-Schema engine at runtime:
  smaller bundles, no `eval`, CSP-safe, precise messages, semantic checks such as
  duplicate ids, unknown `keep_with` references, expression syntax, unknown classes as
  warnings). Errors are `{pointer, code, message}`; codes are shared and listed in
  `conformance/README.md`. A CI job validates every conformance problem with the reference
  validator (Python `jsonschema`, Draft 2020-12) and checks that the hand-written
  validators agree on valid/invalid.

## Consequences
Adding an option means: schema + defaults row + both validators + a conformance case.
The cross-check keeps the hand-written validators honest.
