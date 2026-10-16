# JSON Schemas

The problem and result formats are JSON Schemas (draft 2020-12). They are published with
this site:

* [`schema/problem.v1.json`](../schema/problem.v1.json) — `$id`
  `https://label-anything.dev/schema/problem.v1.json`
* [`schema/result.v1.json`](../schema/result.v1.json) — `$id`
  `https://label-anything.dev/schema/result.v1.json`

Add `"$schema": "<url of problem.v1.json>"` to a problem file to get completion and checks
in editors that support JSON Schema. Every implementation validates with its own,
hand-written validator (no schema engine at runtime), which also checks what a schema
cannot: duplicate ids, unknown `keep_with` references, expression syntax, unknown
classes ([errors and validation](../concepts/errors.md)); CI checks that the validators
and the schema agree on every conformance case
([ADR 0003](../adr/0003-schema-types-and-validation.md)).

The TypeScript types `LabelProblem` and `LabelResult` of `@label-anything/core` are
generated from these schemas, so a problem written as a TypeScript object literal is
checked at compile time.

## problem.v1.json

??? abstract "problem.v1.json"

    ```json
    --8<-- "spec/schema/problem.v1.json"
    ```

## result.v1.json

??? abstract "result.v1.json"

    ```json
    --8<-- "spec/schema/result.v1.json"
    ```
