# @label-anything/core

> **Experimental:** Label Anything is still experimental and under active development.
> The API, the problem format and the placements can change in any 0.x release, without
> deprecation.

The [Label Anything](https://github.com/fabian-beck/label-anything) label placement
engine in pure TypeScript: no native code, no WebAssembly, no runtime dependencies
besides the sibling packages `@label-anything/text` (font metrics and line breaking),
`@label-anything/svg` (SVG backgrounds) and `@label-anything/raster` (raster
backgrounds). It runs in browsers, workers, Node, Deno and Bun.

The solver is a line-by-line port of the Rust core (`rust/crates/la-core`, see
`docs/dev/porting.md`): for the same iteration counts it makes the same decisions, and
its results reproduce the Rust results bit for bit (`conformance/parity`).

```ts
import { place, validate, renderDebugSvg } from "@label-anything/core";

const result = place({
  canvas: { width: 800, height: 600 },
  items: [
    { id: "a", anchor: { type: "point", x: 120, y: 80 }, label: { type: "text", text: "Alpha" } },
    { id: "b", anchor: { type: "point", x: 130, y: 90 }, label: { type: "text", text: "Beta" } },
  ],
});
for (const p of result.placements) if (p.placed) console.log(p.id, p.box);
```

## API

```ts
function place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult; // throws PlaceError
function validate(problem: unknown): ValidationReport;  // { valid, errors, warnings }
function renderDebugSvg(problem: LabelProblem | string, result: LabelResult): string;
const VERSION: string;
class PlaceError extends Error { readonly errors: Issue[] }  // pointer, code, message

interface PlaceOptions {
  priority?: (item, index) => number | [tier, score]; // replaces priority.terms
  cost?: (candidate: CandidateInfo) => number;        // extra static cost per candidate
  measure?: (text, font: FontSpec) => TextMetrics | null; // e.g. CanvasRenderingContext2D.measureText
  progress?: (phase: string, fraction: number) => void;
  signal?: AbortSignal;                               // or any object with `aborted`
  raster?: RgbaPixels;                                // background pixels supplied directly
  readFile?: (path: string) => Uint8Array;            // svg.path, raster source, font file
}
```

The problem and result formats are the JSON Schemas in `spec/schema` (TypeScript types
`LabelProblem`, `LabelResult`, and for their parts `LabelItem`, `Anchor`, `Label`,
`LabelPlacement`, `Box`, `Leader`, `Stats`). `place` accepts JSON text as well; invalid problems
throw a `PlaceError` with the same pointers and codes as `validate`.

**Time budget and determinism.** `solver.time_budget_ms` (default 250 ms here, 100 ms in
the Rust core) is turned into a fixed iteration budget (40 local-search moves per ms;
ADR 0007), so results do not depend on the machine's speed. The clock only acts as a
safety net: local search stops 3 × the budget after the start, and the greedy pass stops
opening new priority bands after 10 × the budget. `signal` is polled every 64 greedy
steps, 256 local-search moves and 4,096 exact-search nodes; a cancelled solve returns
the best valid placement found so far (`stats.cancelled`).

**Custom environments.** `placeWith(env, problem)` solves with an `Env` object, every
member of which is optional (clock `nowMs`, `readFile`, `measure`, `priority`,
`extraCost`, `progress`, `cancelled`, an SVG backend). `new BasicEnv()` has none: no
clock, so no deadline at all and results that depend on the iteration budgets alone.
`placeWith(env, problem, "rust")` uses the Rust core's per-implementation constants
(100 ms, 100 moves per ms), which is how the parity tests reproduce Rust results.

## Command line

`@label-anything/cli` provides `label-anything-ts` with the Rust CLI's `place`,
`validate` and `render` commands:

```sh
label-anything-ts place problem.json -o result.json --debug-svg overlay.svg
label-anything-ts validate problem.json
label-anything-ts render problem.json result.json -o overlay.svg
```

## Tests

`npx vitest run` (repository root) runs the ported Rust unit tests, the conformance
suite (`npm run conformance` runs the `place` cases from the command line), the parity
fixtures (`test/parity.test.ts`), the randomized guarantees of the Rust
`random_problems` test with the same generator and seeds (`LA_RANDOM_CASES`, default
150), and, when `rust/target/release/label-anything` is built, comparisons with the Rust
CLI on random problems (`LA_RANDOM_PARITY`, default 40) and on every sample problem under
several option changes (`test/parity-options.test.ts`).

## Performance

`node ts/packages/core/bench/place-bench.mjs` times `place` on the brief's performance
problems (fixed PCG32 seeds; `--write <dir>` writes them as JSON for the Rust CLI).
Times of `place` on Node 22 (40 runs after warm-up) and the Rust CLI's `runtime_ms` on
the same problems, on a shared 4-core machine that was busy with other work (load
average about 6):

| problem | target | TypeScript, min / median | Rust CLI, min |
|---|---|---|---|
| 200 labels + 10k points, 800×600 | ≤ 60 ms | 32 / 41 ms | 21 ms |
| 2,000 labels + 100k points, 1920×1080, greedy | ≤ 600 ms | 642 / 831 ms | 385 ms |

About a fifth of the TypeScript time is garbage collection: a 2,000-label solve allocates
about 260 MB, mostly candidates with their boxes and leaders. `docs/dev/porting.md`
(Performance) describes the techniques of the hot paths.
