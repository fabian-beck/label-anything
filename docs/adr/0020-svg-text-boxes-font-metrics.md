# 0020 — SVG text boxes span the bundled font's ascender and descender

* Status: accepted
* Date: 2026-10-17
* Area: Obstacles and backgrounds
* Affects: spec §4.5 (text boxes); behaviour change
* Amends: [ADR 0013](0013-svg-implementation.md) (text boxes)

## Context
The engine read an SVG `<text>` as a box from 0.8 em above to 0.2 em below the baseline,
the defaults of `la-svg` for a parser without fonts. The engine measures SVG text with its
bundled Noto Sans, whose ascender and descender are 1.069 em and 0.293 em: that is what a
browser's `getBBox` reports for the text, and what the engine's own label boxes span.
Descenders (g, p, y, parentheses: about 0.24 em) and accents reached outside the 0.8/0.2 box,
so a label could sit on the descenders of a text or touch its ascenders.

The benchmark's truth geometry (text boxes measured with the bundled font) found the only
hard violations left in the full suite there: two airport names on the credit line of the
European map (`05-airports/europe-names-400-svg`: Kasos 2.1 px and Kastelorizo 0.7 px into
the box of "Data: OpenFlights (ODbL) · Natural Earth", their bottoms 0.3 px above the
glyphs).

## Decision
`SvgBackend::load` (Rust) and `SvgBackend.load` (TypeScript) take the ascent and descent of
text boxes next to the measuring function; the engine passes the ascender and descender of
the bundled default font (the same for every bundled font), as for labels. `la-svg` and
`@label-anything/svg` used alone keep 0.8 em and 0.2 em, since they have no fonts.

## Consequences
Full suite, deterministic solves, default budgets: hard violations 2 → 0. Two problems
change: `europe-names-400-svg` 376 → 374 labels, `03-gapminder/y2005-svg` 32 → 31 (its year
watermark and region legend are taller now); nothing else (the other SVG backgrounds have no
text near the labels, or draw it as paths). The conformance case `svg-text-box` pins the
extent: a label whose top position ends between 0.2 em and 0.293 em below a text's
baseline moves to the next position.
