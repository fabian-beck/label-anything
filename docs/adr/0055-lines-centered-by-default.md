# 0055 — The lines of a text label are centered by default

* Status: accepted (new option `defaults.align`; `label.align` takes effect; result fields `text.x_offsets` and `text.align`; spec §5.1; Rust `la-core` and `la-render`, TypeScript `@label-anything/core`, and the renderers of this project)
* Date: 2026-10-24

## Context
Every line of a label of several lines — wrapped, or broken by line feeds in its text —
started at the left edge of the label's box (`text.x_offset`, the padding). A name on two
lines stood lopsided above or below its point: on the economies chart of the home page,
"of America" hung under the left half of "United States". The problem schema already had a
`label.align` (`start`, `center`, `end`), described as "reported only": the engine ignored
it and did not report it, and only the matplotlib helper read it from the problem, with
`start` as its default.

## Decision
* The lines of a text label are aligned within its widest line: line `i`, of width `w_i`,
  starts `x_offsets[i] = padding + (W − w_i) · f` from the box's left edge, where `W` is the
  widest line and `f` = ½ for `center`, 0 for `start` (flush left) and 1 for `end` (flush
  right). `label.align` sets it per label; the new option `defaults.align` sets it for
  every label that does not, and is `center`.
* The result reports `text.x_offsets` (one per line) and `text.align`; `text.x_offset`
  stays the left edge of the text block. A host draws line `i` at
  `box.x + x_offsets[i]`, left-aligned on its baseline; for `center` it may as well draw
  every line centered on the box's middle.
* Boxes do not change, so no label moves: the placement of every problem is the same as
  before. The underline of a `baseline` leader port still runs to the far end of the
  first line, where that line now stands. Host-measured lines (`width`, `height`) all
  start at the padding, as their widths are not known. Composite labels keep their own
  `align` (default `center`) for their parts.
* The renderers of this project draw each line at its offset: `la-render` and the
  TypeScript debug renderer, `bench/render.py` (the figures of the documentation),
  `@label-anything/extras` (SVG, Sigma; the Vega transform sets the text item's `align`
  and anchors several lines at the box's middle or right edge, since Vega draws the lines
  itself), the matplotlib helper (which now follows `text.align`), the playground, the
  home page's header and the web example. Results without `x_offsets` are drawn as before.

## Consequences
* Names on two or more lines are centered: on the economies chart "United States / of
  America", "São Tomé / and Principe" and three more names; on the tutorials' raster
  figure "Index / View". Labels of one line look as before.
* Every text label of a result has two more fields, so every parity fixture changed;
  apart from them the results are identical.
* A host that draws at `x_offset` keeps left-aligned lines; to follow the new default it
  draws at `x_offsets`. A problem that wants the old look sets `defaults.align: "start"`
  (Python `align="start"`, Java `align(Label.Align.START)`).
* Two place cases, `text-align` and `text-align-defaults`, test the default, a label's own
  `align` and `defaults.align`; their expectation `text_align` makes the three
  conformance runners re-check every line's start against the box.
* The WebAssembly module grows by 0.9 KB to 998,560 bytes gzipped, 1.4 KB under its
  budget.
