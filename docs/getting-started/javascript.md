# JavaScript and TypeScript

Two packages implement the same API, so switching between them is a change of the import:

* **`@label-anything/core`** — the engine in pure TypeScript: no native code, no
  WebAssembly, no dependencies. It runs in browsers, workers, Node, Deno and Bun, and
  reproduces the Rust core's decisions.
* **`@label-anything/wasm`** — the Rust core compiled to WebAssembly (about 980 KB gzip),
  with full text shaping and image decoders ([below](#webassembly)).

`@label-anything/extras` adds helpers for d3, Observable Plot, Vega, Leaflet, MapLibre,
Cytoscape and sigma, and a Web Worker engine.

## Install

```sh
npm install @label-anything/core       # or @label-anything/wasm
npm install @label-anything/extras     # visualization helpers (optional)
```

The packages are not on npm yet. Until they are, build them in a clone of the repository
(Node ≥ 18) and install the tarballs into your project *together*, since
`@label-anything/core` depends on its sibling packages `text`, `svg` and `raster`:

```sh
npm ci && npm run build
mkdir -p ../la-packages
npm pack -w @label-anything/text -w @label-anything/svg -w @label-anything/raster \
         -w @label-anything/core -w @label-anything/extras --pack-destination ../la-packages
cd ../my-project && npm install ../la-packages/*.tgz
```

`@label-anything/wasm` needs a Rust toolchain for WebAssembly as well: see
[its README](gh:ts/packages/wasm-adapter/README.md#building-from-source).

## Place labels

```js
--8<-- "examples/tutorials/js/basics.mjs:place"
```

`place` is synchronous and returns the result (`result.v1`); it also accepts the problem
as JSON text. Problems are serialized as JSON, so they must be JSON-serializable; your
object is never modified.

## Validate, errors

`validate` never throws; `place` throws a `PlaceError` whose `errors` are
`{pointer, code, message}` objects ([codes](../concepts/errors.md)).

```js
--8<-- "examples/tutorials/js/basics.mjs:validate"
```

## Options

The second argument of `place` holds what is not part of the JSON problem:

```js
--8<-- "examples/tutorials/js/basics.mjs:options"
```

| Option | |
|---|---|
| `measure(text, font)` | measures text with the page's fonts (`font = {family, weight, italic, size}`, e.g. with `CanvasRenderingContext2D.measureText`); returns `{width, ascent, descent}` in px, or `null` for the built-in measurement. Called with `""` for a font's vertical metrics. |
| `priority(item, index)` | a score or `[tier, score]` per item, evaluated once before the solve; it replaces `priority.terms`, while tier rules, `required` and ties still apply ([a priority function](../tutorials/priority.md#a-priority-function)) |
| `cost(candidate)` | an extra cost per candidate (`{itemId, box, leader}`), a finite number |
| `progress(phase, fraction)` | called when a phase starts (`"greedy"`, `"local"`, `"exact"`), per priority band and every 256 local-search moves |
| `signal` | an `AbortSignal`, or any object with `aborted`: the solve stops improving and returns a valid result with `stats.cancelled` ([cancellation](../concepts/solver.md#cancellation-and-progress)) |
| `raster` | background pixels, [below](#raster-pixels-and-files) |
| `readFile(path)` | the only file access, [below](#raster-pixels-and-files) |

An exception thrown by a callback stops the solve and is rethrown from `place`.

## Raster pixels and files

Background pixels can be passed directly — an `ImageData` from a canvas qualifies. They
replace the image of the first `obstacles.raster` entry, whose options (mode, class,
scale) still apply.

```js
--8<-- "examples/tutorials/js/basics.mjs:pixels"
```

Files referenced by path (`obstacles.svg.path`, a raster `source`, a font `file`) are read
through `readFile`, which returns a `Uint8Array` (a string is taken as UTF-8 text), e.g.
`readFile: (path) => readFileSync(path)` in Node. Without it, a file reference is an error.

## Debug overlay

```js
--8<-- "examples/tutorials/js/basics.mjs:debug"
```

The overlay draws the item shapes, the obstacles, the label boxes and leaders, and omitted
items with their reasons ([the debug overlay](../concepts/debug-overlay.md)).

## Types

The types of the problem and the result are generated from the JSON Schemas: `LabelProblem`
and `LabelResult`, and for their parts `LabelItem` (an entry of `items`), `Anchor`,
`Label`, `LabelPlacement` (an entry of `placements`), `Box`, `Leader` and `Stats`. A problem
built in code is type-checked:

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

`@label-anything/wasm` runs the Rust core in the page. In browsers and bundlers,
instantiate it once with `await init()` before the first call; in Node it instantiates
itself on first use, and `init()` is optional.

```js
--8<-- "examples/tutorials/js/wasm.mjs:wasm"
```

Both packages give the same boxes for the same problem:

```js
--8<-- "examples/tutorials/js/wasm.mjs:switch"
```

* **Loading.** `init()` fetches `label_anything_bg.wasm` next to the glue code; serve it as
  `application/wasm`. Bundlers that understand `new URL("…", import.meta.url)` (Vite,
  webpack 5, Parcel, esbuild with a loader) copy the file. `init(input)` loads it from a URL,
  a `Response`, the bytes or a compiled `WebAssembly.Module`; `initSync(bytesOrModule)`
  instantiates synchronously, e.g. in a worker that received the module. Without a bundler,
  map the package with an import map (see
  [`examples/web/`](gh:examples/web/index.html)).
* **Size.** About 980 KB gzip with full text shaping, the SVG backend and the PNG, JPEG
  and WebP decoders, about 800 KB without the decoders; `features()` lists what is compiled
  in. Raster pixels work in every build, and in browsers decoding images with the platform
  (`createImageBitmap`, a canvas) and passing the pixels is faster anyway.
* **Speed.** The solver is about 10 % slower than the native core. The first call after
  `init()` is several times slower than later ones, while V8 compiles the module; a short
  warm-up solve helps.
* **Errors.** A crash inside the module is a bug: it surfaces as an `Error` starting with
  `label-anything: internal error`, and the next call gets a fresh instance. `PlaceError`
  has the same shape as in `@label-anything/core` but is a different class: to accept the
  errors of both packages, test `error.name === "PlaceError"`.

**Limitations.** `place` blocks the thread it runs on: run large problems in a
[worker](#web-workers). A plain `AbortSignal` cannot change during a synchronous call, not
even in a worker; to cancel from outside, pass an object whose `aborted` getter reads shared
memory (`Atomics.load` on a `SharedArrayBuffer`, which needs cross-origin isolation in
browsers). Memory grows to the needs of the largest solve and is not returned until the
instance is dropped. Fonts are the bundled Noto Sans, font files read through `readFile`, or
your `measure` callback.

## Visualization libraries

The helpers of `@label-anything/extras` turn what a library already knows (marks, scales,
projections, layouts) into a problem, solve it with `@label-anything/core` (or the engine
you pass as `engine`: the WebAssembly module or a worker), and draw or apply the result.
Labels are measured with the browser's canvas in the CSS font they are drawn with. None of
the libraries is a dependency.

### d3

`labelSelection(selection, text, options)` labels the selected elements; everything else
already drawn in the owner `<svg>` is the obstacle background.

```js
--8<-- "examples/tutorials/js/browser/d3.mjs:d3"
```

### Observable Plot

`labelAnything(data, options)` is a text mark whose labels avoid each other and the marks
drawn before it (put it last).

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

Leaflet and MapLibre layers re-solve after every move, starting from the previous result:
[interactive maps](../tutorials/interactive-maps.md). Cytoscape and sigma:
[node-link diagrams](../tutorials/node-link.md).

### Web Workers

`createWorkerEngine(worker)` returns an asynchronous engine that every helper accepts;
the worker serves the engine of your choice.

```js
--8<-- "examples/tutorials/js/browser/worker.mjs:worker"
```

```js
--8<-- "examples/tutorials/js/browser/worker.mjs:page"
```

Text is then measured in the worker (with `OffscreenCanvas` where available); `priority`
and `cost` callbacks cannot cross the thread boundary.

## API

`@label-anything/core` and `@label-anything/wasm` export the functions of
`LabelAnythingApi`: `place`, `validate`, `renderDebugSvg`, `VERSION` and `PlaceError`.
`@label-anything/wasm` adds `init`, `initSync`, `isInitialized` and `features`.
`@label-anything/core` adds `placeWith(env, problem)` and `placeValidated(env, problem,
report)` for custom environments (clock, files, callbacks; see its
[README](gh:ts/packages/core/README.md)), and `placeTraced(env, problem)`, which also returns
a trace of the solver's decisions, as the [explainer](../try.md#how-it-works-step-by-step) replays it.

??? abstract "The definition: `ts/packages/core/src/api.ts`"

    ```ts
    --8<-- "ts/packages/core/src/api.ts"
    ```

The programs on this page are in [`examples/tutorials/js`](gh:examples/tutorials/js). CI
runs the Node programs and, under jsdom, the browser snippets with the real d3, Observable
Plot, Vega, Leaflet and Cytoscape (MapLibre, sigma and the worker with stand-ins that
implement the helpers' interfaces).
