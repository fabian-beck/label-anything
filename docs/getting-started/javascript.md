# JavaScript and TypeScript

Two packages implement the same API ([`LabelAnythingApi`](../reference/javascript-api.md)):

* **`@label-anything/core`** — the engine in pure TypeScript: no native code, no
  WebAssembly. It runs in browsers, workers, Node, Deno and Bun, and reproduces the Rust
  core's decisions for the same iteration budget.
* **`@label-anything/wasm`** — the Rust core compiled to WebAssembly (about 980 KB gzip),
  with full text shaping and image decoders. Switching is a change of the import (plus
  `await init()` in browsers). Details: the [WebAssembly guide](../bindings/wasm.md).

`@label-anything/extras` adds helpers for d3, Observable Plot, Vega, Leaflet, MapLibre,
Cytoscape and sigma, and a Web Worker engine. The types `LabelProblem` and `LabelResult`
are generated from the JSON Schemas, so a problem written as an object literal is
type-checked in TypeScript.

```sh
npm install @label-anything/core       # or @label-anything/wasm
npm install @label-anything/extras     # visualization helpers (optional)
```

The packages are not on npm yet: until they are,
[pack them from the repository](index.md#install-from-this-repository) and install the
tarballs.

## Place labels

```js
--8<-- "examples/tutorials/js/basics.mjs:place"
```

`place` is synchronous and returns the result object (`result.v1`); it also accepts the
problem as JSON text.

## Validate, errors

`validate` never throws; `place` throws a `PlaceError` whose `errors` are
`{pointer, code, message}` objects ([codes](../concepts/errors.md)).

```js
--8<-- "examples/tutorials/js/basics.mjs:validate"
```

## Options

The second argument holds what is not part of the JSON problem: a `measure` function
(e.g. `CanvasRenderingContext2D.measureText` with the page's font), a `priority` callback
(a score or `[tier, score]` per item, evaluated once before the solve), an extra `cost`
per candidate, `progress` notifications and an `AbortSignal`.

```js
--8<-- "examples/tutorials/js/basics.mjs:options"
```

## Raster pixels

Background pixels can be passed directly — an `ImageData` from a canvas qualifies. They
replace the image of the first `obstacles.raster` entry, whose options (mode, class,
scale) still apply.

```js
--8<-- "examples/tutorials/js/basics.mjs:pixels"
```

Files referenced by path (`obstacles.svg.path`, a raster `source`, a font `file`) are read
through `readFile`, e.g. `readFile: (path) => readFileSync(path)` in Node (see the
[outliers tutorial](../tutorials/outliers.md)).

## Debug overlay

```js
--8<-- "examples/tutorials/js/basics.mjs:debug"
```

The overlay draws the item shapes, the obstacles, the label boxes and leaders, and omitted
items with their reasons ([the debug overlay](../concepts/debug-overlay.md)).

## WebAssembly

In browsers and bundlers, instantiate the module once with `await init()` (it fetches
`label_anything_bg.wasm` next to the glue); in Node the package initializes itself
synchronously on first use, and `init()` is optional.

```js
--8<-- "examples/tutorials/js/wasm.mjs:wasm"
```

Both packages give the same boxes for the same problem:

```js
--8<-- "examples/tutorials/js/wasm.mjs:switch"
```

`initSync(bytesOrModule)` instantiates synchronously (e.g. in a worker that received a
compiled `WebAssembly.Module`); `features()` lists the compiled-in parts. The
[WebAssembly guide](../bindings/wasm.md) covers loading without a bundler, size
variants, performance and limitations.

## Visualization libraries

The helpers turn what a library already knows (marks, scales, projections, layouts) into a
problem, solve it with `@label-anything/core` (or the engine you pass as `engine`, e.g.
the WebAssembly module or a worker), and draw or apply the result. Labels are measured
with the browser's canvas in the CSS font they are drawn with. None of the libraries is
a dependency.

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

Leaflet and MapLibre layers re-solve after every move, warm-started from the previous
result: [interactive maps](../tutorials/interactive-maps.md). Cytoscape and sigma:
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

The programs on this page are in [`examples/tutorials/js`](gh:examples/tutorials/js). CI
runs the Node programs and, under jsdom, the browser snippets with the real d3, Observable
Plot, Vega, Leaflet and Cytoscape (MapLibre, sigma and the worker with stand-ins that
implement the helpers' interfaces).
