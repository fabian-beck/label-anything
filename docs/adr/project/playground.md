# Playground

The documentation site runs the real engines in the browser — a playground, and a live
logo and live examples on the home page — so readers can try options without installing
anything.

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
  drawing takes over without a jump. Then more things come, one at a time, so that the
  reader sees it is live; once the reader does something (or the header is full), nothing
  moves until they do.
- The home page's examples are live as well. Each shows its static figure first and
  replaces it once the same problem is solved in the browser, with the same labels, so
  nothing jumps and a page without the script keeps its figures. What a reader can change
  is what the picture is about: the chart's variables, the map's view, the graph's layout,
  the photograph's margins and leaders. A hover names every mark, labeled or not. An
  example loads its data and solves only when it comes near the viewport.
- A view that changes step by step (a panned map, a dragged node) is solved from the
  labels shown, with a small budget while it moves; a state that changes as a whole (other
  variables, the whole map again, a reset layout) is solved afresh, so it has the labels a
  first visit shows.

## Consequences
The `wasm` CI job type-checks, builds and browser-tests the playground: every scene solves
without overlaps and both engines agree. The home page loads about 0.9 MB more after the
page itself (the worker and the font), and as its examples come into view the examples'
script (60 kB), the bold font (0.24 MB) and their data (the world's countries 0.46 MB, the
module graph 0.2 MB, the photograph), about a third of that compressed. The chart and the
map exist twice, as Python scripts that make the static figures and as their ports in the
browser; a browser test holds the ports to the committed problems. A world map takes about 100 ms per solve in
WebAssembly and three to four times as long in TypeScript; maps clip their outlines to the
view before each solve.

## Alternatives
- **Recordings or precomputed frames**: cannot show an option the reader picks.
- **Solving on the main thread**: stalls the animation for the length of each solve.
- **WebAssembly for the home page**: adds the module's download to every visit.
- **The home page's figures static, with a hover drawn over the image**: shows nothing of
  what the engine does when the picture changes.
- **The wheel zooming the home page's map without a modifier key**: the map would catch a
  reader who scrolls the page. The wheel zooms with Ctrl or ⌘ held; a pinch, a double
  click and the buttons zoom too.
