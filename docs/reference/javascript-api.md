# JavaScript API

`@label-anything/core` (pure TypeScript) and `@label-anything/wasm` (the Rust core compiled
to WebAssembly) export the same functions, defined by `LabelAnythingApi`:

```ts
function place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult;  // throws PlaceError
function validate(problem: unknown): ValidationReport;                                 // { valid, errors, warnings }
function renderDebugSvg(problem: LabelProblem | string, result: LabelResult): string;
const VERSION: string;
class PlaceError extends Error { readonly errors: Issue[] }
```

`@label-anything/core` also exports `placeWith(env, problem)` and `placeValidated(env,
problem, report)` for custom environments (clock, files, callbacks; see its README), and
`placeTraced(env, problem)`, which returns the result together with a trace of the
solver's decisions (the [explainer](../explainer.md) shows one, ADR 0041);
`@label-anything/wasm` adds `init`, `initSync`, `isInitialized` and `features`
([WebAssembly package](../bindings/wasm.md)). Usage:
[getting started](../getting-started/javascript.md).

## The definition

[`ts/packages/core/src/api.ts`](gh:ts/packages/core/src/api.ts):

```ts
--8<-- "ts/packages/core/src/api.ts"
```
