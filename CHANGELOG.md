# Changelog

What changed for people who use Label Anything: the problem and result formats, the
placements, the options and the APIs of the packages. One version covers every package
(`node tools/version.mjs`). The reasons behind a change are in the decision records
(`docs/adr/`), and the measured effect on the benchmark is in each release's
[benchmark report](https://fabian-beck.github.io/label-anything/benchmark-report/).

While the version is 0.x, a minor version (0.2.0) may change formats, APIs and placements
without deprecation; a patch version (0.1.1) changes none of them except to fix an error.

## Unreleased

The first release, 0.1.0. Nothing is published to a package registry yet.

### The engine

- One problem format and one result format, both versioned JSON Schemas (`problem.v1`,
  `result.v1`), with a validator that reports every error by JSON pointer and code.
- Labels for points and areas of any shape — circles, ellipses, rectangles, polygons,
  paths, pins — placed adjacent, on a slider around the mark, or at a distance with a
  leader; internal labels for shapes that have room. Leaders are straight, angled,
  orthogonal, elbowed or curved, and they do not cross.
- Avoidance by class: other labels, items, text, the canvas edge, vector obstacles, SVG
  backgrounds and raster backgrounds (ink, alpha, cost, class map, saliency), each either
  forbidden or at a cost.
- Priority and omission: explicit priorities, attribute expressions, outlierness, tiers
  and per-category coverage decide which labels are left out; the result gives the reason
  for every omitted label. Font classes set important labels larger or bold.
- A degradation ladder for labels that do not fit: alternative texts, wrapping, distant
  placement, eviction of lower priorities, shrinking, soft overlap, omission.
- How hard the engine tries to place every label is one option, `placement.aggressiveness`:
  `medium` (the default) keeps type at its size and leaders within 4 em, `high` also
  shrinks type, relaxes overlaps and draws leaders up to 8 em, `low` keeps labels next to
  their marks with more room around them.
- Presets `auto`, `scatter`, `map`, `graph`, `illustration` and `none`.
- Warm starts and stability costs for interactive and animated views.
- A deterministic solver (greedy pass, local search, exact search for small problems)
  with a time budget that does not depend on the machine's speed.
- Text measurement with a bundled Noto Sans subset, with the host's fonts, or through a
  callback; line breaking, wrapping and truncation.
- A debug overlay (SVG or PNG): placed labels, leaders, candidates and cost heatmaps.

### Packages

- Rust: the crate `label-anything` and its parts (`label-anything-core`, `-text`,
  `-expr`, `-svg`, `-raster`, `-render`).
- Command line: `label-anything` (`place`, `render`, `validate`, `bench`, `serve`).
- Python ≥ 3.9: `label-anything`, with helpers for matplotlib, Plotly and seaborn in
  `label-anything-extras`.
- JavaScript and TypeScript: `@label-anything/core` (pure TypeScript, the same placements
  as the Rust engine), `@label-anything/wasm` (the Rust engine as WebAssembly),
  `@label-anything/cli`, and `@label-anything/extras` for d3, Observable Plot, Vega,
  Leaflet, MapLibre, Cytoscape, sigma and Web Workers.
- Java ≥ 17: `io.github.fabian-beck:label-anything`, through FFM on Java 22+ and JNI
  before.
- C ABI: `liblabelanything` with `label_anything.h`, with examples in C and Go.
