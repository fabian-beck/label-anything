# WebAssembly binding: `@label-anything/wasm`

`@label-anything/wasm` is the Rust core of Label Anything compiled to WebAssembly, with
exactly the JavaScript API of the pure TypeScript implementation `@label-anything/core`
(`LabelAnythingApi` in `ts/packages/core/src/api.ts`). Switching between the two is a
change of the import (plus `await init()` in browsers). Results are identical to the
native Rust build: the test suite compares every conformance problem with the CLI.

* Rust crate: `rust/crates/la-wasm` (wasm-bindgen, `wasm32-unknown-unknown`)
* npm package: `ts/packages/wasm-adapter` (`@label-anything/wasm`)
* Example: `examples/web/index.html` (labels SVG circles in the browser)

## Install

```sh
npm install @label-anything/wasm
```

The package contains the compiled module (`wasm/label_anything_bg.wasm`, about 950 KB
gzip), the wasm-bindgen glue (`wasm/label_anything.js`) and the TypeScript wrapper
(`dist/`). It depends on `@label-anything/core` for its type declarations only; no
JavaScript of that package is loaded.

## Initialization

### Browsers and bundlers

The module is instantiated once, asynchronously, before the first call:

```ts
import { init, place } from "@label-anything/wasm";

await init(); // fetches label_anything_bg.wasm next to the glue (instantiateStreaming)
const result = place(problem);
```

* `init()` without an argument fetches `label_anything_bg.wasm` relative to
  `wasm/label_anything.js` with `WebAssembly.instantiateStreaming` (serve `.wasm` files as
  `application/wasm`; otherwise the glue falls back to `WebAssembly.instantiate` with a
  console warning). Bundlers that understand `new URL("…", import.meta.url)` (Vite,
  webpack 5, Parcel, esbuild with a loader) copy the file automatically.
* `init(input)` loads it from elsewhere: a URL or path string, a `URL`, a `Request`, a
  `Response`, the bytes (`ArrayBuffer`, typed array) or a compiled `WebAssembly.Module`,
  or a promise of one of these. The file is also exported as
  `@label-anything/wasm/label_anything_bg.wasm`.
* `initSync(bytesOrModule)` instantiates synchronously, e.g. in a worker that received a
  compiled `WebAssembly.Module` with `postMessage`.
* `init` and `initSync` are idempotent; `isInitialized()` tells whether the module is ready.
* Calling `place`, `validate`, `renderDebugSvg` or `features` before initialization
  throws an `Error`: "@label-anything/wasm is not initialized: call \`await init()\` (or
  \`initSync(bytes)\`) before place(), validate() or renderDebugSvg()".

Without a bundler, map the bare specifier with an import map (see `examples/web/`):

```html
<script type="importmap">
  { "imports": { "@label-anything/wasm": "/node_modules/@label-anything/wasm/dist/index.js" } }
</script>
```

### Node

The package's `exports` map has a `node` condition (`dist/node.js`): there, `place`,
`validate`, `renderDebugSvg` and `features` instantiate the module synchronously from the
bundled `wasm/label_anything_bg.wasm` on first use, so no initialization is needed:

```js
import { place } from "@label-anything/wasm";
const result = place(JSON.parse(readFileSync("problem.json", "utf8")));
```

`await init()` still works in Node (it reads the file with `fs`; a path or `file:` URL
argument is read the same way, an `http(s)` URL is fetched).

The glue is generated with wasm-bindgen's `--target web`, which runs unchanged in browsers,
bundlers, workers, Node, Deno and Bun; only the Node entry adds the synchronous loading.

## API

```ts
function place(problem: LabelProblem | string, options?: PlaceOptions): LabelResult;
function validate(problem: unknown): ValidationReport;
function renderDebugSvg(problem: LabelProblem | string, result: LabelResult): string;
const VERSION: string; // "0.1.0", also the version of the Rust core inside
class PlaceError extends Error { readonly errors: Issue[] }

// WebAssembly specifics
function init(input?: InitInput | Promise<InitInput>): Promise<void>;
function initSync(module: BufferSource | WebAssembly.Module): void;
function isInitialized(): boolean;
function features(): string[]; // compiled-in optional parts: "shaping", "decode", "svg"
```

* `place` accepts a problem object or its JSON text and returns the result object (spec
  §11, `spec/schema/result.v1.json`). Objects are serialized with `JSON.stringify`, so
  they must be JSON-serializable; the caller's object is never modified.
* An invalid problem, or one that cannot be prepared (e.g. an unreadable file, an
  undecodable image), throws `PlaceError` whose `errors` are the `{pointer, code, message}`
  issues of the Rust validator; JSON text that does not parse gives one `parse` error.
* `validate` accepts an object or JSON text and returns `{valid, errors, warnings}`.
* `renderDebugSvg` draws the debug overlay of a problem and a result
  (`output.debug_svg: true` puts the same overlay into `result.debug_svg`).

`PlaceError` is defined in this package with exactly the shape, name and message format of
the class in `@label-anything/core` (the runtime code never imports the TypeScript
implementation, which would defeat the purpose of the package). The two classes are
therefore distinct for `instanceof`; code that accepts errors of both packages can test
`error.name === "PlaceError"`. The type-level equivalence is checked when the package is
compiled.

## Options and callbacks

`PlaceOptions` holds what is not part of the JSON problem. Every field is optional.

| Option | Behaviour in the WebAssembly build |
|---|---|
| `priority(item, index)` | Evaluated in JavaScript before the solve, once per item. The values are written into a copy of the problem: `item.priority = score` (unless the item has a `priority`) and, for `[tier, score]`, `item.tier = tier` (unless the item has a `tier`); `priority.terms` is dropped because the callback replaces it. Tier rules, `required` and ties still apply. This is what the Rust core does with a native priority callback, so results agree. Must return a finite number or `[integer, finite number]` (else `TypeError`). |
| `cost(candidate)` | Called for every candidate with `{itemId, box: {x, y, w, h}, leader}`; the value is added to its static cost. One call costs one JS↔WASM crossing (the argument object is built on the JavaScript side). Must return a finite number (else `TypeError`). |
| `measure(text, font)` | Replaces the built-in text measurement (`font = {family, weight, italic, size}`); return `{width, ascent, descent}` in px or `null` for the built-in measurement of this text. It is also called with `""` for the vertical metrics of a font. Typical use: `CanvasRenderingContext2D.measureText` with the page's font. |
| `progress(phase, fraction)` | Called when a phase starts (`"greedy"`, `"local"`, `"exact"`), per greedy priority band and every 256 local-search moves (spec §10.3a). |
| `signal` | An `AbortSignal` (any object with `aborted`), the core's cancellation request (spec §10.3a): it is polled at every priority band and every 64 items of the greedy pass, every 256 local-search moves and every 4,096 exact-search nodes; once aborted the solver stops improving and returns a valid result with `stats.cancelled == true` (items not reached are `budget_exhausted`). `place` is synchronous and blocks the JavaScript thread, so the flag can only be set before the call (then nothing is placed) or from one of the callbacks, e.g. `progress`. |
| `raster` | RGBA8 pixels `{width, height, data}` with `data` a `Uint8Array` or `Uint8ClampedArray` (an `ImageData` qualifies; any `ArrayBuffer` view of `width·height·4` bytes works). They are copied once into WebAssembly memory and replace the image of the first `obstacles.raster` source, whose options (mode, scale, class, …) still apply, or add a raster source with default options. Keep an `obstacles.raster` entry with any `source` (e.g. `"host"`) to set those options. Wrong sizes throw `RangeError`. |
| `readFile(path)` | The only file access: called for `obstacles.svg.path`, raster `source` paths and font `file`s. Return the bytes as a `Uint8Array` (a string is taken as UTF-8 text). Without it, a file reference fails with a `PlaceError` (`invalid_value`, pointing at the field). In Node: `readFile: (p) => fs.readFileSync(p)`. |

**Exceptions.** The first exception thrown by any callback stops all further callbacks
(they are not called again), cancels the solve (the core stops at its next poll) and is
rethrown unchanged — the same object — from `place`. WebAssembly cannot unwind Rust
frames, so the core returns normally first and its result is discarded; no memory is
leaked.

## Errors inside the module

The module never panics across the boundary: a panic hook turns a Rust panic into an
`Error` whose message starts with `label-anything: internal error (Rust panic):` and
contains the panic message. A trap without a panic (out of memory, stack overflow) is
reported as `label-anything: internal error (the WebAssembly instance trapped: …)` with
the `WebAssembly.RuntimeError` as `cause`. In both cases the instance may hold leaked
memory, so the wrapper replaces it with a fresh instance of the same compiled module
before the next call (wasm-bindgen's `__wbg_reset_state`). Detection is exact: every raw
call increments a depth counter on entry and decrements it on every normal return; a call
that ends with the counter still raised did not return normally. Panics and traps are
bugs; please report them.

## Size variants

`npm run build:wasm` (in `ts/packages/wasm-adapter`) builds the default variant.
Sizes of `label_anything_bg.wasm` (wasm-bindgen output without name section; gzip = GNU
`gzip -9`, brotli = quality 11), at commit 98c5edf unless marked:

| Variant | How to build | raw | gzip | brotli |
|---|---|---:|---:|---:|
| **default**: full shaping + SVG + image decoders | `npm run build:wasm` | 2,524 KB ³ | **961 KB** ³ | – |
| lite: no image decoders | `npm run build:wasm -- --no-default-features` | 2,087 KB | 784 KB | 581 KB |
| default, opt-level "s" everywhere | `npm run build:wasm -- --core-opt-level s` | 2,365 KB | 873 KB | 648 KB |
| lite, opt-level "s" everywhere | `… -- --no-default-features --core-opt-level s` | 1,938 KB | 711 KB | 527 KB |
| default, opt-level 3 everywhere | `npm run build:wasm -- --opt-level 3` | 2,782 KB | 1,019 KB | 740 KB |
| without full shaping ¹ ² | needs a `la-core` feature | 1,948 KB | 731 KB | 552 KB |
| without full shaping and decoders ¹ ² | needs a `la-core` feature | 1,520 KB | 566 KB | 429 KB |
| without the SVG backend ¹ ² | needs a `la-core` feature | 2,345 KB | 877 KB | 651 KB |
| minimal: no shaping, no SVG, no decoders ¹ ² | needs `la-core` features | 1,357 KB | 500 KB | 380 KB |

¹ Measured with a patched copy of the workspace: full shaping (`la-text/shaping`) and the
SVG backend (`la-svg`) are compiled into `la-core` unconditionally today. ² At commit
0e75308, when the default was 943 KB gzip; the differences to the default still hold.
³ Since the raster crate is compiled at opt-level 3 as well (13 KB gzip more; the other
rows predate that change).

What the optional parts cost (gzip): full shaping (rustybuzz + ttf-parser, used for
complex scripts when `text.shaping` is `auto` or `full`) 212 KB, PNG/JPEG/WebP decoding
164 KB, the SVG backend 66 KB, opt-level 3 for the solver crate 74 KB. The default keeps
everything the native facade has, so a problem that places natively places here too, and
stays below 1 MB gzip. It compiles the solver crate (`label-anything-core`) and the
raster pipeline (`label-anything-raster`) at opt-level 3 and everything else for size
("s"): that is as fast as opt-level 3 everywhere (which is just over 1 MB) and 9–16 %
faster than "s" everywhere (A/B on p200, p2000 and the local-search sample
`priority-prefix.json`); with the raster crate at "s", preparing a 2048² raster background
took 2.3 times as long (88 instead of 38 ms). opt-level "z" is 11 % smaller than "s" but
about half as fast. `wasm-opt` is not used: it made the module smaller raw, not gzip.
In browsers, a `measure` callback covers complex scripts without full shaping.

Raster pixels (`options.raster`, `obstacles.raster.rgba`) work in every variant; in
browsers, decoding images with the platform (`createImageBitmap`, a canvas,
`getImageData`) and passing the pixels is faster than decoding in WebAssembly.

## Performance

Node 22 (V8), the default build, on the shared 4-core development machine (load 4–6, so
expect ±20 %), at commit 98c5edf. Warm medians of interleaved runs against the native
release build of the same core (`label-anything serve`, the CLI's HTTP mode, so both run
in a warm process):

| Problem | native solver | WASM solver | WASM / native | WASM `place()` | native request | target |
|---|---:|---:|---:|---:|---:|---:|
| `p200.json` (200 labels, 10k points, greedy) | 23.3 ms | 24.6 ms | 1.06 | 37.8 ms | 35.1 ms | ≤ 30 ms |
| `p2000.json` (2,000 labels, 100k points, greedy) | 416 ms | 455 ms | 1.10 | 572 ms | 502 ms | ≤ 250 ms |

"solver" is `stats.runtime_ms` (from building the model to the result object). A
`place()` call adds `JSON.stringify` of the problem object (2 ms / 28 ms; pass JSON text to
skip it), copying it into WebAssembly memory, parsing and validating it (7.6 ms / 58 ms;
natively 5 ms / 43 ms), and `JSON.parse` of the result (0.9 ms / 5.5 ms). The results
are identical to the native ones (`native.test.ts` with `LA_EXTRA_PROBLEMS`).

Against the targets: the warm solver time for p200 meets 30 ms, a complete `place()`
call does not; p2000 misses 250 ms because the native core itself needs about 420 ms
there, WebAssembly adds about 10 %.

**Raster backgrounds** (`npm run bench:raster -w @label-anything/wasm`): a 2048×2048 image
passed as pixels (`options.raster`), a 1024×1024 grid, one label; the prepare phase
(`stats.phases_ms.prepare`: the raster mode, the coverage grids and the rest of the model):

| Image | ink | alpha | cost | saliency |
|---|---:|---:|---:|---:|
| chart (line art) | 72–99 ms | 86–115 ms | 68–110 ms | 234–331 ms |
| photo (noise) | 190–209 ms | 92–114 ms | 92–110 ms | 275–415 ms |

The target for preparing a 2048² raster (≤ 60 ms) is missed already in the cheapest case
(chart, ink: 72 ms at best). With the same pixels as `rgba` base64 in the JSON, the
prepare phase takes 0.8–1.35 times as long in WebAssembly as natively, so the gap is the
core's preparation, not the binding: the raster mode alone (`process`, decode excluded)
takes 9 ms natively for chart/ink and 91 ms for photo/ink (`la-raster` example `bench`).
Passing pixels avoids the base64 decode of the JSON route (another 60–100 ms here).

**The first call** after instantiation is slower. p200: 100–200 ms; p2000: 1.4–2.8 s,
3–5 times the warm time. Part of it is the core (natively the first p2000 request takes
2.2 times as long as later ones: fresh memory, cold caches); the rest is V8, which
compiles functions lazily with its baseline compiler and optimizes hot ones in the
background, while a long call keeps running baseline code in its outermost loops.
Instantiation takes about 10 ms. Chrome caches the optimized code of modules loaded with
`instantiateStreaming` for later page loads; a short warm-up solve after `init()` also
helps a little.

`npm run bench -w @label-anything/wasm -- problem.json…` reproduces the WebAssembly side.

## Building from source

Requirements: Rust with the `wasm32-unknown-unknown` target and `wasm-bindgen-cli` of
exactly the version of the `wasm-bindgen` crate in `rust/Cargo.lock` (the build script
checks it):

```sh
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.129
npm install                                  # at the repository root (npm workspace)
npm run build:wasm -w @label-anything/wasm   # cargo build + wasm-bindgen into wasm/
npm run build                                # TypeScript (all packages)
npx vitest run                               # all packages
npm run test:browser -w @label-anything/wasm # Playwright + Chromium smoke test
node examples/brief/js_6_2.mjs               # the brief's §6.2 example, verbatim
```

The CI job `wasm` (`.github/workflows/ci.yml`) does exactly this on ubuntu-latest with
Rust 1.97.0 and wasm-bindgen-cli 0.2.129, builds the native CLI for the equality tests,
checks the size budget (gzip < 1 MB) and runs the smoke test in Chromium.

The WebAssembly build uses its own Cargo profile (`wasm-release`, passed with `--config`:
fat LTO, one codegen unit), so it does not invalidate native release builds. Options of
`scripts/build-wasm.mjs`: `--no-default-features`, `--features …`, `--opt-level` (default
`s`), `--core-opt-level` (default `3`), `--keep-names` (keep the name section for
profiling). Without `wasm/`, the WebAssembly tests are skipped with a warning (they fail
instead when `LA_WASM_REQUIRED` is set, as in CI).

Tests (`ts/packages/wasm-adapter/test`):

* `place.test.ts`: every `conformance/problems/*.json` places with
  `hard_violations == 0`, deterministically (object and JSON text); every
  `conformance/validate` case through `validate`, and invalid ones through `place`
  (`PlaceError` with the Rust error list); debug SVG; `PlaceError` equals the core class.
* `callbacks.test.ts`: each option, including exceptions and invalid return values.
* `raster.test.ts`: pixels vs. the same image as `rgba` base64, views, checks.
* `native.test.ts`: the result equals the output of the native CLI
  (`label-anything place`) with `solver.strategy: "greedy"` for every conformance
  problem (all fields but the wall-clock times). Needs `cargo build -p label-anything-cli`
  (or `LA_CLI=…`); `LA_EXTRA_PROBLEMS=a.json,b.json` adds problems.
* `init-*.test.ts`, `panic.test.ts`: initialization paths, panics, traps, instance reset.
* `browser/smoke.pw.mjs`: Chromium loads `dist/` and `wasm/` from a small static server
  (`browser/server.mjs`), initializes with `instantiateStreaming`, places problems
  (with a canvas `measure` callback and `ImageData` pixels) and checks the results.

`npm run bench -w @label-anything/wasm -- problem.json…` times `place` in Node.

## Limitations

* `place` is synchronous: it blocks the thread it runs on. For large problems in a page,
  run it in a worker (`initSync` with a `WebAssembly.Module` sent from the main thread).
* Cancellation from outside the call (a timer, a UI event): run the solve in a worker and
  pass a signal-like object whose `aborted` getter reads shared memory, e.g.
  `{ get aborted() { return Atomics.load(flags, 0) === 1; } }` with `flags` an
  `Int32Array` on a `SharedArrayBuffer` (browsers need cross-origin isolation for it);
  the getter runs at every poll. A plain `AbortSignal` cannot change during a
  synchronous call, not even in a worker.
* The first `place` call after instantiation is slower than later ones because V8
  compiles the module lazily and optimizes hot functions while they run; see Performance.
* WebAssembly memory grows to the peak need of the largest solve and is not returned to
  the system until the instance is dropped (a reset after a panic or a page reload).
* No file access except through `readFile`; no system fonts (only the bundled Noto Sans
  metrics, font files via `readFile` or data URLs, or a `measure` callback).
