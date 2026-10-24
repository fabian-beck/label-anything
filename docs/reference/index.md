# Reference

The normative definitions. These pages are built from the repository files listed here,
so they are always those of the version you are reading:

| Page | Source |
|---|---|
| [Specification](spec.md) — the semantics every implementation follows | [`spec/spec.md`](gh:spec/spec.md) |
| [Defaults](defaults.md) — every option, its default and validation rule | [`spec/defaults.md`](gh:spec/defaults.md) |
| [Presets](presets.md) — `auto`, `scatter`, `map`, `graph`, `illustration`, `none` | [`spec/presets/`](gh:spec/presets) |
| [Expression language](expressions.md) — grammar and semantics of `where`, `expr`, `by` | [`spec/expr.peg`](gh:spec/expr.peg) |
| [JSON Schemas](schemas.md) — `problem.v1.json`, `result.v1.json` | [`spec/schema/`](gh:spec/schema) |

The conformance suite ([`conformance/`](gh:conformance)) turns the specification into test
cases that every implementation passes.

Each language's API is on its page:

| Language | API |
|---|---|
| Python | [`label_anything`](../getting-started/python.md): `place` and its keywords, the builder, results, callbacks, plotting helpers |
| JavaScript and TypeScript | [`@label-anything/core` and `@label-anything/wasm`](../getting-started/javascript.md#api), with the definition `api.ts` |
| Java | [`io.github.fabianbeck.labelanything`](../getting-started/java.md#the-builder): the builder, results, the native library |
| C, Go and other languages with a C FFI | [`label_anything.h`](../getting-started/c-go.md#the-header) |
| Command line, HTTP | [`label-anything`](../getting-started/cli.md) |
