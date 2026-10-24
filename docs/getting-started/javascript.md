# JavaScript and TypeScript

Two packages implement the same API and give the same results; switching between them
changes only the import:

* **`@label-anything/core`** — the engine in pure TypeScript, without native code,
  WebAssembly or dependencies. It runs in browsers, workers, Node, Deno and Bun.
* **`@label-anything/wasm`** — the Rust core compiled to WebAssembly (about 980 KB gzip),
  with full text shaping and image decoders ([below](#webassembly)).

`@label-anything/extras` adds helpers for d3, Observable Plot, Vega, Leaflet, MapLibre,
Cytoscape and sigma, and a Web Worker engine.

## Install

```sh
npm install @label-anything/core       # or @label-anything/wasm
npm install @label-anything/extras     # visualization helpers (optional)
```

The packages are not on npm yet. Until then, build them from a clone of the repository
(Node ≥ 18) and install the tarballs together, since `@label-anything/core` depends on its
siblings `text`, `svg` and `raster`:

```sh
npm ci && npm run build
mkdir -p ../la-packages
npm pack -w @label-anything/text -w @label-anything/svg -w @label-anything/raster \
         -w @label-anything/core -w @label-anything/extras --pack-destination ../la-packages
cd ../my-project && npm install ../la-packages/*.tgz
```

`@label-anything/wasm` also needs a Rust toolchain for WebAssembly
([its README](gh:ts/packages/wasm-adapter/README.md#building-from-source)).

## Place labels

```js
--8<-- "examples/tutorials/js/basics.mjs:place"
```

`place` is synchronous. A problem object must be JSON-serializable; `place` never
modifies it.

## Validate, errors

`validate` reports errors without throwing; `place` throws a `PlaceError`
([codes](../concepts/errors.md)):

```js
--8<-- "examples/tutorials/js/basics.mjs:validate"
```

## Options

The second argument of `place` takes functions and data that JSON cannot hold:

```js
--8<-- "examples/tutorials/js/basics.mjs:options"
```

| Option | |
|---|---|
| `measure(text, font)` | measures text with the page's fonts (`font = {family, weight, italic, size}`), e.g. with `CanvasRenderingContext2D.measureText`. Returns `{width, ascent, descent}` in px, or `null` for the built-in measurement; called with `""` for a font's vertical metrics. |
| `priority(item, index)` | returns a score or `[tier, score]` per item, called once before the solve. It replaces `priority.terms`; tier rules, `required` and ties still apply ([a priority function](../tutorials/priority.md#a-priority-function)). |
| `cost(candidate)` | returns an extra cost (a finite number) per candidate `{itemId, box, leader}` |
| `progress(phase, fraction)` | called as each phase starts (`"greedy"`, `"local"`, `"exact"`), per priority band and every 256 local-search moves |
| `signal` | an `AbortSignal` or any object with `aborted`: the solve stops improving and returns a valid result with `stats.cancelled` ([cancellation](../concepts/solver.md#cancellation-and-progress)) |
| `raster` | background pixels ([below](#raster-pixels-and-files)) |
| `readFile(path)` | the engine's only file access ([below](#raster-pixels-and-files)) |

An exception in a callback stops the solve and is rethrown from `place`.

## Raster pixels and files

`raster` passes background pixels directly, e.g. an `ImageData` from a canvas. They
replace the image of the first `obstacles.raster` entry, whose options (mode, class,
scale) still apply.

```js
--8<-- "examples/tutorials/js/basics.mjs:pixels"
```

Files named in the problem (`obstacles.svg.path`, a raster `source`, a font `file`) are
read through `readFile`, which returns a `Uint8Array` (or a string of UTF-8 text); in Node,
`readFile: (path) => readFileSync(path)`. Without it, naming a file is an error.

## Debug overlay

`renderDebugSvg` draws [the debug overlay](../concepts/debug-overlay.md) of a result:

```js
--8<-- "examples/tutorials/js/basics.mjs:debug"
```

## Types

The types are generated from the JSON Schemas: `LabelProblem` and `LabelResult`, and for
their parts `LabelItem` (an entry of `items`), `Anchor`, `Label`, `LabelPlacement` (an
entry of `placements`), `Box`, `Leader` and `Stats`. A problem built in code is
type-checked:

```ts
import { place, type LabelItem, type LabelPlacement } from "@label-anything/core";

const items: LabelItem[] = cities.map((c) => ({
  id: c.id,
  anchor: { type: "point", x: c.x, y: c.y },
  label: { type: "text", text: c.name },
}));
const placed: LabelPlacement[] = place({ canvas: { width: 800, height: 600 }, items }).placements.filter((p) => p.placed);
```

## WebAssembly

`@label-anything/wasm` runs the Rust core in the page. In browsers and bundlers, call
`await init()` once before the first solve; in Node, the module loads on first use and
`init()` is optional.

```js
--8<-- "examples/tutorials/js/wasm.mjs:wasm"
```

* **Loading.** `init()` fetches `label_anything_bg.wasm` from next to the glue code; serve
  it as `application/wasm`. Bundlers that understand `new URL("…", import.meta.url)` (Vite,
  webpack 5, Parcel, esbuild with a loader) copy the file. `init(input)` loads it from a
  URL, a `Response`, the bytes or a compiled `WebAssembly.Module`; `initSync(bytesOrModule)`
  loads it synchronously, e.g. in a worker that received the module. Without a bundler,
  map the package with an import map ([`examples/web/`](gh:examples/web/index.html)).
* **Size.** About 980 KB gzip with full text shaping, the SVG backend and the PNG, JPEG and
  WebP decoders, about 800 KB without the decoders; `features()` lists what is compiled in.
  Raster pixels work in every build, and in browsers it is faster to decode images with the
  platform (`createImageBitmap`, a canvas) and pass the pixels.
* **Speed.** The solver is about 10 % slower than the native core. The first call after
  `init()` is several times slower than later ones while V8 compiles the module; a short
  warm-up solve helps.
* **Errors.** A crash inside the module is a bug. It surfaces as an `Error` starting with
  `label-anything: internal error`, and the next call gets a fresh instance. `PlaceError`
  has the same shape as in `@label-anything/core` but is a different class; to catch both,
  test `error.name === "PlaceError"`.

**Limitations.** `place` blocks its thread: solve large problems in a
[worker](#web-workers). A plain `AbortSignal` cannot change during a synchronous call, even
in a worker; to cancel from outside, pass an object whose `aborted` getter reads shared
memory (`Atomics.load` on a `SharedArrayBuffer`, which browsers allow only with
cross-origin isolation). Memory grows to the needs of the largest solve and is freed only
with the instance. Text is measured with the bundled Noto Sans, a font file read through
`readFile`, or your `measure` callback.

## Visualization libraries

The helpers of `@label-anything/extras` turn what a library knows (marks, scales,
projections, layouts) into a problem, solve it with `@label-anything/core` or the `engine`
you pass (the WebAssembly module, a worker), and draw or apply the result. They measure
labels with the browser's canvas, in the CSS font the labels are drawn in. None of the
libraries is a dependency.

### d3

`labelSelection(selection, text, options)` labels the selected elements; everything else
drawn in the same `<svg>` is an obstacle.

```js
--8<-- "examples/tutorials/js/browser/d3.mjs:d3"
```

### Observable Plot

`labelAnything(data, options)` is a text mark whose labels avoid each other and the marks
drawn before it, so add it last.

```js
--8<-- "examples/tutorials/js/browser/plot.mjs:plot"
```

### Vega

`registerVegaTransform(vega)` adds a `labelAnything` transform, a drop-in alternative to
Vega's `label` transform; avoided marks become obstacle classes named after the marks.

```js
--8<-- "examples/tutorials/js/browser/vega.mjs:register"
```

```js
--8<-- "examples/tutorials/js/browser/vega.mjs:mark"
```

### Maps and graphs

Leaflet and MapLibre layers solve again after every move, starting from the previous
result ([interactive maps](../tutorials/interactive-maps.md)). Cytoscape and sigma:
[node-link diagrams](../tutorials/node-link.md).

### Web Workers

`createWorkerEngine(worker)` returns an asynchronous engine, which every helper accepts;
the worker runs the engine of your choice.

```js
--8<-- "examples/tutorials/js/browser/worker.mjs:worker"
```

```js
--8<-- "examples/tutorials/js/browser/worker.mjs:page"
```

Text is then measured in the worker (with `OffscreenCanvas` where available). `priority`
and `cost` callbacks cannot cross into the worker.

## API

Besides the functions above, `@label-anything/wasm` exports `isInitialized`, and
`@label-anything/core` exports `placeWith(env, problem)` and
`placeValidated(env, problem, report)` for custom environments (clock, files, callbacks;
see its [README](gh:ts/packages/core/README.md)), and `placeTraced(env, problem)`, which
also returns the trace of the solver's decisions that the
[explainer](https://fabian-beck.github.io/label-anything/playground/explain.html) replays.

??? abstract "The definition: `ts/packages/core/src/api.ts`"

    ```ts
    --8<-- "ts/packages/core/src/api.ts"
    ```

The programs on this page are in [`examples/tutorials/js`](gh:examples/tutorials/js).
