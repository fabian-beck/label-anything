# Name

The project keeps the name Label Anything, uses it in every package registry, and leads
with "label placement" wherever it introduces itself.

## Context
"Label Anything" was free on crates.io, npm and PyPI (checked 2026-10-16). It says what
the engine does and gives the short alias `la`, and *anything* is the difference to tools
that serve one host: adjustText, ggrepel, vega-label, d3fc-label-layout, Maplex, PAL. But
the name collides. A few-shot segmentation model of the same name (ECAI 2025) is
open-source research software; "*X* Anything" has read as a vision model since Segment
Anything; and in machine learning, labeling means annotating data. People search for
"label placement", which the front pages did not say first.

## Decision
- Keep the name, with one name per registry:
  - crates `label-anything` (facade), `label-anything-core`, `-text`, `-expr`, `-svg`,
    `-raster`, `-render`, `-cli` (binary `label-anything`), `-wasm`, `-py`, `-capi`, in
    `rust/crates/la-*`;
  - npm `@label-anything/core`, `/text`, `/svg`, `/raster`, `/wasm`, `/wasm-adapter`,
    `/extras`;
  - PyPI `label-anything` (`import label_anything`), Maven
    `io.github.fabian-beck:label-anything`, C `liblabelanything` with `label_anything.h`.
- Category first: the front pages open with "Label placement for charts, maps and
  diagrams, from any language", and every package description says "label placement".
- One paragraph on the front pages says what *anything* means (any host, any label with a
  size, every language), that labels go to points and areas while lines are obstacles, and
  that the engine places labels in graphics, is no data-labeling tool and is unrelated to
  the segmentation model.

## Consequences
In search results the name stays tied to the segmentation work, and the disambiguation is
the answer. The registry check is repeated before the first release, and publishing 0.1.0
reserves the names. Papers name their contribution rather than only the tool.

## Alternatives
- **Renaming before the first release** (Label Etiquette, Label Anywhere, Overpost,
  Cartellino and Wide Berth were all free): the name is memorable, its collisions are in
  other fields, and a rename would touch about 400 files and the address of the site.
