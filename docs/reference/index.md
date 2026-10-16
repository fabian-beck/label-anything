# Reference

| Page | Source |
|---|---|
| [Specification](spec.md) — the normative semantics every implementation follows | [`spec/spec.md`](gh:spec/spec.md) |
| [Defaults](defaults.md) — every option, its default and validation rule | [`spec/defaults.md`](gh:spec/defaults.md) |
| [Presets](presets.md) — `auto`, `scatter`, `map`, `graph`, `illustration`, `none` | [`spec/presets/`](gh:spec/presets) |
| [Expression language](expressions.md) — grammar and semantics of `where`, `expr`, `by` | [`spec/expr.peg`](gh:spec/expr.peg) |
| [JSON Schemas](schemas.md) — `problem.v1.json`, `result.v1.json` | [`spec/schema/`](gh:spec/schema) |
| [Python API](../bindings/python.md) | `label_anything` |
| [Java API](../bindings/java.md) | `io.github.fabianbeck.labelanything` |
| [JavaScript API](javascript-api.md) — `@label-anything/core` and `@label-anything/wasm` | [`api.ts`](gh:ts/packages/core/src/api.ts) |
| [WebAssembly package](../bindings/wasm.md) — loading, size, performance | `@label-anything/wasm` |
| [C API](c-api.md) | [`label_anything.h`](gh:rust/crates/la-capi/include/label_anything.h) |

The pages of the specification, the defaults, the presets, the expression language and
the APIs are built from the repository files listed here, so they are always those of the
version you are reading. The conformance suite ([`conformance/`](gh:conformance)) turns
the specification into test cases that every implementation passes.
