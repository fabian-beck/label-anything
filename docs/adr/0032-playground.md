# 0032 — A playground on the documentation site, with both engines in the browser

* Status: accepted (ts/packages/playground, the `wasm` job of CI, the Pages workflow)
* Date: 2026-10-18

## Context
The documentation shows what the engine does with static figures, the gallery and the
benchmark report. None of them lets a reader change an option and see what happens, and
the one demo of moving labels was a recording of precomputed frames. A reader who wants
to know what `leaders.style`, the candidate models, the margin, the priority or the warm
start do has to install a binding first.

## Decision
* **A static web app, published with the site.** `ts/packages/playground` (a private
  workspace package, bundled with esbuild) is deployed at `<site>/playground/`. The CI job
  that builds the WebAssembly module also builds the playground and runs its browser
  tests; the Pages workflow publishes the build of the CI run it deploys (artifact
  `playground`), so the published playground is the tested one.
* **The real engines, in Web Workers.** The Rust core compiled to WebAssembly and the
  TypeScript port each run in a worker (`createWorkerEngine` of `@label-anything/extras`),
  so drawing and animation never wait for a solve. The playground's time budgets are the
  Rust core's; the TypeScript worker gets 2.5 × the budget — the same number of search
  moves (40 per ms instead of 100), and the same margin to its wall-clock guard. Both
  engines then give identical layouts, which the Inspect tab and the browser tests check.
* **The engine's own font.** Labels are measured with the bundled Noto Sans (no host
  measurement) and drawn with the same font files: the boxes fit the drawn text, and the
  problem the Code tab exports gives the same layout in every binding and the CLI.
* **Three kinds of solves.** A *cold* solve after an option changed; *warm* solves while
  things move (the previous result as `warm_start`, a short budget, at most a set number
  per second, a result of an outdated problem dropped), the labels gliding between them
  (`LabelMotion`); one *settle* solve when the motion stops (the full budget, a third of
  the stability weight).
* **Every option is a field of the problem.** Each control edits one dotted path of the
  problem format and shows it; a JSON field merges anything else, and the engine's
  validator reports errors there. A unit test validates every value every control can
  write against the schema.
* **Scenes from data that may be redistributed.** Natural Earth's countries (public
  domain) and three scikit-image photographs (public domain / CC0) with the benchmark's
  CC0 annotation polygons are derived by scripts in `tools/` and committed (590 KB in
  all); the network is the import graph of the project's own TypeScript modules,
  generated at build time. Data without an explicit license (Les Misérables, Cora) is not
  used.
* **The controls on the drawing are obstacles** (class `overlay`, hard for labels): the
  engine keeps labels from under the buttons, as any host can keep them off its legend.
* **Maps solve the visible part.** Country outlines are clipped to the view and simplified
  to 0.8 px before each solve (once per zoom band, ADR 0038). Internal candidates of an
  area are sampled over its bounding box at label-height spacing, so a country thousands
  of pixels wide on a zoomed map made each solve take 100–350 ms in WebAssembly and placed
  almost nothing within the moving budget's guard; clipped, a solve takes 10–60 ms.

Considered and rejected: *precomputed frames* (the earlier recording) cannot show an
option the reader picks; *solving on the main thread* stalls the animation for the length
of each solve; *embedding the app in a documentation page* leaves it a column of the
page's width.

## Consequences
The `wasm` CI job gains a type check, a build and Playwright tests of the playground (every
scene solves without overlaps, both engines agree, options and share links take effect).
The site's navigation links the playground, and the landing page and the README point to
it. While things move, labels follow their anchors between solves and make way for each
other where they meet (ADR 0038); at rest the verified result shows. A world map solve takes
about 100 ms in WebAssembly and three to four times as long in TypeScript.
