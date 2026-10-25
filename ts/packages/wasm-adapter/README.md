# @label-anything/wasm

> **Experimental:** Label Anything is still experimental and under active development,
> mostly by an AI coding assistant (Claude Code) with limited human oversight. The API,
> the problem format and the placements can change without deprecation.

The Rust core of [Label Anything](https://github.com/fabian-beck/label-anything) compiled
to WebAssembly, with exactly the JavaScript API of the pure TypeScript engine
`@label-anything/core`. How to use it: [JavaScript and
TypeScript](https://fabian-beck.github.io/label-anything/getting-started/javascript/#webassembly)
on the documentation site. This file is about building, measuring and testing it.

* Rust crate: `rust/crates/la-wasm` (wasm-bindgen, `wasm32-unknown-unknown`)
* This package: the compiled module (`wasm/label_anything_bg.wasm`), the wasm-bindgen glue
  (`wasm/label_anything.js`, generated with `--target web`) and the TypeScript wrapper
  (`dist/`). It depends on `@label-anything/core` for its type declarations only.
* Example: `examples/web/index.html` (labels SVG circles in the browser)

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
node examples/brief/js_6_2_wasm.mjs          # the brief's §6.2 example with @label-anything/wasm
```

The CI job `wasm` (`.github/workflows/ci.yml`) does exactly this with Rust 1.97.0 and
wasm-bindgen-cli 0.2.129, builds the native CLI for the equality tests, checks the size
budget (gzip < 1 MB) and runs the smoke test in Chromium.

The build uses its own Cargo profile (`wasm-release`, passed with `--config`: fat LTO, one
codegen unit), so it does not invalidate native release builds. Options of
`scripts/build-wasm.mjs`: `--no-default-features`, `--features …`, `--opt-level` (default
`z`; the hot crates named in the script get "s" then, else the same level),
`--core-opt-level` (default `3`), `--keep-names` (keep the name section for profiling).
Without `wasm/`, the WebAssembly tests are skipped with a warning; they fail instead when
`LA_WASM_REQUIRED` is set, as in CI.

## Size

Sizes of `label_anything_bg.wasm` (wasm-bindgen output without name section; gzip = GNU
`gzip -9`, brotli = quality 11, measured with Node's `zlib` where marked ⁵), at commit
98c5edf unless marked:

| Variant | How to build | raw | gzip | brotli |
|---|---|---:|---:|---:|
| **default**: full shaping + SVG + image decoders | `npm run build:wasm` | 2,575 KB ⁵ | **982 KB** ⁵ | 734 KB ⁵ |
| lite: no image decoders | `npm run build:wasm -- --no-default-features` | 2,097 KB ⁵ | 802 KB ⁵ | 600 KB ⁵ |
| default, "s" instead of "z" (the former default) | `npm run build:wasm -- --opt-level s` | 2,627 KB ⁵ | 999 KB ⁵ | 741 KB ⁵ |
| default, opt-level "s" everywhere | `npm run build:wasm -- --opt-level s --core-opt-level s` | 2,365 KB | 873 KB | 648 KB |
| lite, opt-level "s" everywhere | `… -- --no-default-features --opt-level s --core-opt-level s` | 1,938 KB | 711 KB | 527 KB |
| default, opt-level 3 everywhere | `npm run build:wasm -- --opt-level 3` | 2,782 KB | 1,019 KB | 740 KB |
| without full shaping ¹ ² | needs a `la-core` feature | 1,948 KB | 731 KB | 552 KB |
| without full shaping and decoders ¹ ² | needs a `la-core` feature | 1,520 KB | 566 KB | 429 KB |
| without the SVG backend ¹ ² | needs a `la-core` feature | 2,345 KB | 877 KB | 651 KB |
| minimal: no shaping, no SVG, no decoders ¹ ² | needs `la-core` features | 1,357 KB | 500 KB | 380 KB |

¹ Measured with a patched copy of the workspace: full shaping (`la-text/shaping`) and the
SVG backend (`la-svg`) are compiled into `la-core` unconditionally today. ² At commit
0e75308, when the default was 943 KB gzip; the differences to the default still hold.
⁵ With opt-level "z" for the crates that do not run hot (below).

What the optional parts cost (gzip): full shaping (rustybuzz + ttf-parser, used for
complex scripts when `text.shaping` is `auto` or `full`) 212 KB, PNG/JPEG/WebP decoding
164 KB, the SVG backend 66 KB, opt-level 3 for the solver crate 74 KB. The default keeps
everything the native facade has, so a problem that places natively places here too, and
stays below 1 MB gzip. It compiles the solver crate (`label-anything-core`) and the raster
pipeline (`label-anything-raster`) at opt-level 3: as fast as opt-level 3 everywhere (which
is just over 1 MB) and 9–16 % faster than "s" everywhere (A/B on p200, p2000 and the
local-search sample `priority-prefix.json`); with the raster crate at "s", preparing a
2048² raster background took 2.3 times as long (88 instead of 38 ms). JSON parsing
(`serde_json`), the SVG backend, text layout and the image decoders get "s", the rest "z":
as fast as "s" for all of them (within noise, on the problems of the speed table below,
raster backgrounds and 2048² JPEG/PNG/WebP sources) and 17 KB smaller. With these crates at
"z" as well it is another 18 KB smaller, but decoding WebP takes 1.5 times as long and
problems with SVG backgrounds or large JSON 8–12 % longer. `wasm-opt` is not used: it made
the module smaller raw, not gzip.

## Performance

Node 22 (V8), the default build, on the shared 4-core development machine (load 4–6, so
expect ±20 %), at commit 98c5edf. Warm medians of interleaved runs against the native
release build of the same core (`label-anything serve`, the CLI's HTTP mode, so both run in
a warm process):

| Problem | native solver | WASM solver | WASM / native | WASM `place()` | native request | target |
|---|---:|---:|---:|---:|---:|---:|
| `p200.json` (200 labels, 10k points, greedy) | 23.3 ms | 24.6 ms | 1.06 | 37.8 ms | 35.1 ms | ≤ 30 ms |
| `p2000.json` (2,000 labels, 100k points, greedy) | 416 ms | 455 ms | 1.10 | 572 ms | 502 ms | ≤ 250 ms |

"solver" is `stats.runtime_ms` (from building the model to the result object). A `place()`
call adds `JSON.stringify` of the problem object (2 ms / 28 ms; pass JSON text to skip it),
copying it into WebAssembly memory, parsing and validating it (7.6 ms / 58 ms; natively
5 ms / 43 ms), and `JSON.parse` of the result (0.9 ms / 5.5 ms). The results are identical
to the native ones (`native.test.ts` with `LA_EXTRA_PROBLEMS`).

**Raster backgrounds** (`npm run bench:raster -w @label-anything/wasm`): a 2048×2048 image
passed as pixels (`options.raster`), a 1024×1024 grid, one label; the prepare phase
(`stats.phases_ms.prepare`):

| Image | ink | alpha | cost | saliency |
|---|---:|---:|---:|---:|
| chart (line art) | 72–99 ms | 86–115 ms | 68–110 ms | 234–331 ms |
| photo (noise) | 190–209 ms | 92–114 ms | 92–110 ms | 275–415 ms |

The target for preparing a 2048² raster (≤ 60 ms) is missed already in the cheapest case.
With the same pixels as `rgba` base64 in the JSON, the prepare phase takes 0.8–1.35 times as
long in WebAssembly as natively, so the gap is the core's preparation, not the binding.
Passing pixels avoids the base64 decode of the JSON route (another 60–100 ms here).

**The first call** after instantiation is slower: p200 100–200 ms, p2000 1.4–2.8 s, 3–5
times the warm time. Part of it is the core (natively the first p2000 request takes 2.2
times as long as later ones), the rest V8, which compiles functions lazily and optimizes hot
ones in the background while a long call keeps running baseline code. Growing the memory in
large steps took the first p2000 call from 1.0 to 0.7 s. Instantiation takes about 10 ms.

**Memory** grows in steps of half its size (at most 64 MiB): V8 runs a full garbage
collection on every growth, and growing by what each allocation needed made the first solve
of 20,000 items take 6.4 instead of 1.4 s (437 collections instead of 6), for up to 15 % more
memory (321 instead of 278 MB there).

`npm run bench -w @label-anything/wasm -- problem.json…` times `place` in Node.

## Tests

`test/`:

* `place.test.ts`: every `conformance/problems/*.json` places with `hard_violations == 0`,
  deterministically (object and JSON text); every `conformance/validate` case through
  `validate`, and invalid ones through `place` (`PlaceError` with the Rust error list);
  debug SVG; `PlaceError` equals the core class.
* `callbacks.test.ts`: each option, including exceptions and invalid return values.
* `raster.test.ts`: pixels vs. the same image as `rgba` base64, views, checks.
* `native.test.ts`: the result equals the output of the native CLI
  (`label-anything place`) with `solver.strategy: "greedy"` for every conformance problem
  (all fields but the wall-clock times). Needs `cargo build -p label-anything-cli` (or
  `LA_CLI=…`); `LA_EXTRA_PROBLEMS=a.json,b.json` adds problems.
* `init-*.test.ts`, `panic.test.ts`: initialization paths, panics, traps, instance reset.

`browser/smoke.pw.mjs`: Chromium loads `dist/` and `wasm/` from a small static server
(`browser/server.mjs`), initializes with `instantiateStreaming`, places problems (with a
canvas `measure` callback and `ImageData` pixels) and checks the results.
