# Contrast

Labels avoid straddling light–dark borders of raster backgrounds: a cost term weighs how
much the lightness of the backdrop varies under a label.

## Context
A label half on a light and half on a dark backdrop is hard to read and looks misplaced.
Coverage measures how much a label hides, not whether its backdrop changes beneath it: in
the benchmark's fundus photograph, four of ten labels sat across the edge between the
photo's black corners and the white canvas, both of which cost nothing.

## Decision
- With a raster source, the engine records the backdrop luma: the rasters' Rec. 709 luma
  composited in order over `canvas.background` (default white), sampled at the centres of
  the obstacle grid's cells and averaged over 2 × 2 of them, a grid of about half an em.
- The term is `weights.contrast` (default 0.5) × 4 × the integral of `(Y − Ȳ)²` over the
  label box, per em², from summed-area tables of the luma and its square: constant time
  per candidate and identical in Rust and TypeScript.
- A label half on black and half on white costs the weight per em² of its box; a uniform
  backdrop, dark or light, costs nothing; a thin sliver across a border costs about four
  times the weight per em² of the sliver, so labels move off a border entirely.

## Consequences
No label in the benchmark's illustrations straddles a photo's edge; their total cost rises
3–9 % through longer leaders. Maps on raster tiles and raster charts barely change. The
backdrop is built only with rasters and a positive weight, adding about 2 ms to preparing
a 2048² raster. SVG and vector layers carry no colours, so a host that draws a dark canvas
sets `canvas.background`.

## Alternatives
- **Averaging every raster pixel**, as coverage does: 11 ms more on the 2048² raster,
  which its 25 ms target cannot afford, for detail below the scale of a label.
- **OKLab lightness**: three cube roots per colour, for borders that are stark either way.
- **A hard rule**: a photograph can be all borders.
- **Other weights**: 0.25 to 1 clear the illustrations alike; 0.5 leaves room for softer
  borders.
