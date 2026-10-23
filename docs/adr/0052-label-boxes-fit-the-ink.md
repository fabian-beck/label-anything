# 0052 — Label boxes fit the ink of their text

* Status: accepted (spec §5.2; the bundled fonts' glyph bounds, table `LAvb`; Rust `la-text` and `la-core`, TypeScript `@label-anything/text` and `@label-anything/core`)
* Date: 2026-10-23

## Context
A text label's box spanned the font's ascender and descender (Noto Sans: 1.069 and
0.293 em) plus the padding: 1.662 em for one line, 19.9 px at 12 px. The letters are much
lower: capitals reach 0.714 em above the baseline, ascenders 0.76 em, descenders 0.24 em
below it. Beside its mark a label stood off it by the offset, the padding and a side
bearing, about 3.3 px; above or below it the empty part of the box came on top, and the
letters stood 6–7 px from the mark. On the economies chart of the home page `SAU` stood
above Saudi Arabia's bubble and `Spain` below Spain's, side by side: the letters of each
were about as near to the other bubble as to their own, and which label named which bubble
took a careful look. In dense areas the empty band also took room that other labels
needed. Lowering the
padding or the offset would have moved labels beside their marks too, where the gap was
already right.

## Decision
* The bundled metrics fonts (outline-free, `fonts/README.md`) carry the vertical bounds of
  every glyph's outline in a private table `LAvb` (version 1, per glyph id yMin and yMax in
  font units), written by `tools/fonts/bounds.py` from the outline font of the same subset.
  Every other table stays byte for byte, so widths and kerning do not change; each font
  grows by 4 bytes per glyph, 8.8 KB (the TypeScript text package embeds both fonts in
  base64: 25 KB more before compression).
* `la-text` and `@label-anything/text` read it: `Font::ink_units` / `Font.inkUnits` give
  the lowest yMin and the highest yMax of the glyphs of a text that have an outline, or
  none. The text conformance cases record them (`widths[].ink`).
* A text block spans from the ink top of its first line to the ink bottom of its last
  line, plus the padding (spec §5.2); the baselines move with it. An edge keeps the ascent
  or descent when its line has no ink (no glyph with an outline), when its font has no
  `LAvb` (fonts the host registers), with full shaping (whose glyphs need not be the
  `cmap`'s), and whenever the host measures the vertical metrics: the bounds of the bundled
  font say nothing about the font a host draws with. A host measurement that returns
  nothing falls back to the bundled font for the vertical metrics too, and then gets the
  ink boxes as without a callback.
* The width of a box stays the advance width of its text, so labels beside their marks
  keep their place; side bearings are small, and the advance is what the host's text
  layout uses.

## Consequences
* A label above or below its mark stands as close to it as one beside it: at 12 px,
  `Alpha` is 15.6 px high (19.9 before), `SAU` 12.4 px, `Beta` 12.3 px. Boxes of one font
  size no longer have one height; a label without descenders is lower.
* More labels fit, and fewer need leaders. The economies chart labels 174 of 195
  countries (158 before), with 32 leaders (37) and 4 stubs (5): Saudi Arabia's label, its
  full name now, stands under its bubble and Spain's beside its own; Canada and Taiwan,
  left out under ADR 0051, are labeled again, and 21 countries are left out (37).
  The playground's map places 148 labels (125), the network 90 (80), the scatterplot 201
  (188); the line chart and the swarm are unchanged. On the conformance sample problems
  no label is lost: `many-points` places 200 (198), `leaders-angles` 8 (7) and
  `strict-repair` 70 (50).
* Every text box measured with the bundled fonts changes, and so do the parity fixtures,
  the golden images and the figures. The place cases with box expectations were updated;
  `boundary-column` and `fan-max-labels` got line ends 3 px apart (between ends 4 px apart
  a shrunk label now fits, and a column keeps a member's shrunk variant), and
  `prefix-ladder` got a problem whose ladder is still needed: five long labels now fit
  without it.
* Hosts that draw the text at the reported `baseline_offsets`, as all renderers of this
  project do, need no change. A host that puts the baseline at the box top plus padding
  and ascent draws the text too low.
* SVG text obstacles keep boxes from the ascender to the descender (spec §3): they stand
  for text drawn by someone else, whose glyphs may reach that far.
