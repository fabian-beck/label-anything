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

The problem and result types are generated from the JSON Schemas: `LabelProblem` and
`LabelResult`, plus names for their parts — `LabelItem` (an entry of `items`), `Anchor`,
`Label`, `LabelPlacement` (an entry of `placements`), `Box`, `Leader` and `Stats` — so
that a problem built in code is type-checked:

```ts
import { place, type LabelItem, type LabelPlacement } from "@label-anything/core";

const items: LabelItem[] = cities.map((c) => ({
  id: c.id,
  anchor: { type: "point", x: c.x, y: c.y },
  label: { type: "text", text: c.name },
}));
const placed: LabelPlacement[] = place({ canvas: { width: 800, height: 600 }, items }).placements.filter((p) => p.placed);
```

`@label-anything/core` also exports `placeWith(env, problem)` and `placeValidated(env,
problem, report)` for custom environments (clock, files, callbacks; see its README), and
`placeTraced(env, problem)`, which returns the result together with a trace of the
solver's decisions (the [explainer](../explainer.md) shows one, ADR project/solve-traces);
`@label-anything/wasm` adds `init`, `initSync`, `isInitialized` and `features`
([WebAssembly package](../bindings/wasm.md)). Usage:
[getting started](../getting-started/javascript.md).

## The definition

[`ts/packages/core/src/api.ts`](gh:ts/packages/core/src/api.ts):

```ts
--8<-- "ts/packages/core/src/api.ts"
```
