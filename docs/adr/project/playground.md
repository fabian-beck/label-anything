# Playground

The documentation site runs the real engines in the browser — a playground, and a live
logo on the home page — so readers can try options without installing anything.

## Context
The documentation showed the engine through static figures, the gallery and the benchmark
report. Nothing let a reader change an option and see what happens, the one demo of moving
labels was a recording, and a reader curious about leader styles, priorities or warm
starts had to install a binding first.

## Decision
- `ts/packages/playground`, a private package bundled with esbuild, is published at
  `<site>/playground/`; the Pages workflow deploys the build that CI tested.
- Both engines run in Web Workers: the Rust core compiled to WebAssembly and the
  TypeScript port, which gets 2.5 times the budget so that both run the same number of
  moves and give the same layout. Drawing and animation never wait for a solve.
- Labels are measured and drawn with the bundled Noto Sans, so boxes fit the text and an
  exported problem gives the same layout in every binding.
- Every control edits one path of the problem format; a JSON field takes anything else,
  checked by the engine's validator.
- Scenes use only data that may be redistributed: Natural Earth, public-domain photographs
  and the project's own module graph.
- The home page's header is the logo, labeled live by the playground's TypeScript worker.
  It is static HTML first, whose boxes become the first solve's `warm_start`, so the live
  drawing takes over without a jump; nothing moves until the reader does something.

## Consequences
The `wasm` CI job type-checks, builds and browser-tests the playground: every scene solves
without overlaps and both engines agree. The home page loads about 0.9 MB more after the
page itself (the worker and the font). A world map takes about 100 ms per solve in
WebAssembly and three to four times as long in TypeScript; maps clip their outlines to the
view before each solve.

## Alternatives
- **Recordings or precomputed frames**: cannot show an option the reader picks.
- **Solving on the main thread**: stalls the animation for the length of each solve.
- **WebAssembly for the home page**: adds the module's download to every visit.
