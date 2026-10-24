# Label Anything — specification v1

Status: normative for `label-anything` 0.x. The JSON Schemas in `schema/` define the
syntax, `defaults.md` the default values, `presets/` the presets, `expr.peg` the
expression language. This document defines the **semantics** that every implementation
(Rust core, TypeScript core, and everything built on them) must follow. Section numbers
§x.y refer to the original design brief and are kept stable.

The key words MUST, SHOULD and MAY are used as in RFC 2119.

---

## 1. Overview

One problem goes in, one result comes out:

```
result = place(problem)            // problem.v1.json -> result.v1.json
report = validate(problem)         // { valid, errors[], warnings[] }
```

Pipeline: `validate → normalize → measure label variants → priority (font classes:
rescale and measure again) → prepare obstacles → candidates → greedy (+ ladder) → local
search → (exact) → fan labels → boundary columns → uncross repair → verify → finalize`.

Two implementations (Rust, TypeScript) MUST satisfy the conformance suite
(`conformance/`). Results need not be bit-identical, but hard-constraint guarantees MUST
be identical, and the algorithms are specified here so that they agree closely. Where
this document says *identical*, the two implementations MUST produce the same bits for
the same input (it is tested).

---

## 2. Values, units, coordinates

### 2.1 Lengths

A length is a JSON number (pixels) or a string `<number><unit>`:

| unit | meaning |
|---|---|
| `px` | pixels |
| `pt` | 4/3 px |
| `em` | the font size (px) of the label the length is resolved for (after its font class, §9.4) |

Lengths that are not tied to one label (`canvas.padding`, `placement.boundary.margin`,
`solver.grid_cell`) resolve `em` against `defaults.font.size`. Parsing happens in one
place (`units` module). Invalid unit strings are validation errors (`code: "unit"`).

### 2.2 Coordinates

Canvas pixels, origin top-left, y down. Input coordinates (anchors, absolute item
polygons and paths, area polygons, vector obstacles, `priority.focus`) are mapped by

1. `transform` `[a,b,c,d,e,f]` if present: `x' = a·x + c·y + e`, `y' = b·x + d·y + f`;
2. then, if `y_axis = "up"`, `y'' = canvas.height − y'` (requires `canvas`).

Radii, widths, sizes, offsets and `relative` mark geometry are pixel lengths and are
never transformed. SVG and raster backgrounds are in canvas pixels (see §4). Output is
always canvas pixels, y down.

Angles: mark rotations are degrees **clockwise on screen** (SVG `rotate`). Leader angles
(`leaders.angles`) are degrees **counter-clockwise from +x as seen on screen** (0 = right,
90 = up); the screen direction vector of angle θ is `(cos θ, −sin θ)`.

### 2.3 Canvas

If `canvas` is absent, the canvas is taken from the first raster source (`width/scale`,
`height/scale`), else from the first SVG source (its viewport size), else the problem is
**unbounded**: there is no `canvas_edge` class and the working extent is the bounding box
of all geometry grown by `max(placement.max_distance, 20 em)`.

`canvas.padding` shrinks the label area: labels must lie inside
`[p, W−p] × [p, H−p]` (or inside `canvas.region` shrunk by `p`) unless
`canvas.allow_outside`. This is the `canvas_edge` class. Leaders may leave the region,
but not the canvas.

`canvas.background` (default white) is the colour of the canvas where no raster lies. It
only enters the backdrop luma of the `contrast` cost term (§4.6, §8): labels avoid
straddling the edge between a dark raster and a light canvas.

### 2.4 Merging defaults and presets

Effective options = `defaults.md` ← `presets/<preset>.json#options` ← problem. Objects
merge recursively; arrays and scalars replace. Maps keyed by class (`avoid.label`,
`avoid.leader`, `avoid.buffer`) merge per key. Preset `none` contributes nothing.

---

## 3. Items

### 3.1 Identity and order

`items[i].id` defaults to `String(i)`. Ids MUST be unique (`duplicate_id`). The input
index `i` is the item's *input order*.

### 3.2 Marks (item geometry)

`anchor.mark` (default `defaults.mark`, a circle of radius 2) is the geometry of the
labeled feature. The anchor point `(x, y)` is the shape's **reference point**:

| shape | geometry | reference point |
|---|---|---|
| circle | disc of radius `r` | center |
| ellipse | `rx`, `ry`, rotated by `rotation` (deg, clockwise) about the center | center |
| rect | `w × h`, corner radius `corner_radius`, rotated about the center | center |
| polygon | `points` (+ `holes`); absolute input coords, or px offsets if `relative` | the anchor as given |
| path | SVG path data, flattened to polygons (tolerance 0.25 px) | the anchor as given |
| icon | `w × h` box placed so that its `tip` (default `[w/2, h]`) is on the anchor; optional `silhouette` | the tip |
| from_svg | geometry of the SVG element(s) with `svg_id` / matching `selector` | the anchor as given |

Every mark is an obstacle of the reserved class `items` (§4.4). The `holes` of a polygon
mark and of an area anchor are cut out whichever way they wind: a hole wound like the
outer ring (signed area of the same sign) is reversed before use, so that the non-zero
rule leaves it empty.

### 3.3 Shape kernel

Every implementation provides the same operations on shapes, with identical algorithms:

* `bbox()`; `contains(p)`; signed `distance(p)` (negative inside);
* `support(d)`: the point of the shape that is extreme in direction `d` (for an edge or
  flat side: the point of that edge closest to the reference point's projection);
* `boundary_point(dir)`: first boundary hit of the ray from the reference point;
* `offset(o)`: Minkowski inflation by a disc of radius `o` (support point
  `support(d) + o·d/|d|`, exact for all shapes);
* `intersects_rect(r)`, `intersects_segment(s)`, `rasterize(grid)`.

Concave shapes use their convex hull for `support` (labels touch hull vertices, which
are true boundary points) and their true outline for containment, distance and
intersection tests.

---

## 4. Obstacles

### 4.1 Grid

Cell size `c = solver.grid_cell`, or `auto` = `clamp(min_font_size / 4, 1, 4)` where
`min_font_size` is the smallest effective font size of all labels. The grid covers the
canvas (or the unbounded working extent) with `cols = ceil(W / c)`, `rows = ceil(H / c)`
cells, origin at the canvas origin (or the extent's top-left).

The grid has at most 16 000 000 cells. When the `auto` cell size would exceed that (a
canvas of more than about 16 000 × 16 000 px), `c` becomes `max(c, sqrt(W·H / 16·10⁶))`
and is then multiplied by 1.25 until `cols · rows` fits. An explicit `solver.grid_cell`
that exceeds the limit, and a working extent that is not finite, are errors
(code `limit`).

Every class that occurs and is not `ignore` for both labels and leaders gets one
**coverage grid**: `u8` per cell, `0..255` = fraction of the cell covered (`255` = full).
A cell touched by geometry never stores 0 (minimum 1), so "any coverage" is
conservative. From each coverage grid a **summed-area table** (SAT) of `u32` values is
built with wrapping arithmetic (rectangle sums are exact as long as the true sum
< 2³², which holds for any grid up to 16.8 M cells).

**Covered area** of an axis-aligned rectangle `R` for class `k`: the integral of the
piecewise-constant coverage over `R`, computed exactly from the SAT by splitting `R`
into a 3 × 3 arrangement of interior, edge and corner blocks with fractional weights
(16 SAT lookups). In px²: `sum / 255 · c²`.

### 4.2 Vector rasterization

Own rasterizer, identical in all implementations: every primitive is rasterized with
**4 × 4 supersampling** per cell (sample positions at `(i + (2s+1)/8)·c`, s = 0..3) into
the class grid (coverage = samples inside / 16, scaled to 0..255, combined with `max`).
Primitives: discs (points, circles), axis-aligned rects, polygons (non-zero or even-odd),
polylines as **capsules** of the stroke width, shapes via their outline polygon.
Additionally every cell intersected by the primitive's exact geometry but with 0
samples inside gets coverage 1 (conservative touch).

### 4.3 Exact layers

Hard tests against vector geometry are **exact**: vector primitives of classes that are
hard for labels or leaders, all item marks, and the dynamic layers `labels` and
`leaders` are kept in uniform-grid spatial indexes and tested with exact geometry
(rect–circle, rect–polygon, rect–capsule, segment–segment, …). Raster-derived classes
are tested on their grid: a rectangle "touches" a raster class iff its covered area > 0.

### 4.4 Classes

* `items`: all item marks (their true shapes; area anchors contribute nothing, see §6.5).
* `labels`, `leaders`: placed labels and leaders (dynamic, exact).
* `canvas_edge`: outside of the label area (§2.3).
* `ink`, `text`: produced by SVG/raster backgrounds (and usable in vector layers).
* any other string: user classes.

`avoid.label[k]`, `avoid.leader[k]` give `"hard"`, `"ignore"` or a weight `w ≥ 0`; the
key `"*"` is the default for classes not listed. Unknown classes in `avoid` (not present
in any source and not reserved) produce a validation **warning** `unknown_class`.

**Marks of less important items** (`lower_items`, ADR 0040). The key `lower_items` of
`avoid.label` and `avoid.leader` (not a class; `"*"` does not set it) is the policy for
the marks of items `j` of lower priority key than the label's item `i` (§9.1:
`key(j) < key(i)`; never members of `i`'s group, §5.7); without it they follow `items`.
A soft `lower_items` counts its own coverage cost instead of that of `items` (§8). When
`avoid.label.lower_items` is given and not hard, a label of `i` that overlaps the mark
of a less important `j` (the exact test of `items`) **excludes every label of `j`**: the
two labels conflict like overlapping labels, whatever `avoid.label.labels` says. A
covered mark thus stays unlabeled, never wrongly attributed, and the labels of the
important items may claim the space of the marks around them — a hub keeps its label
in a dense region instead of losing it to the marks of minor items nearby.

**Label margin** (`defaults.margin`, 0.2 em; ADR 0028). Hard `labels` and `items` keep a
label away from what is not its own, while it touches its own mark at `placement.offset`:

* With `avoid.label.labels` hard, two labels conflict when their boxes come closer than
  the larger margin of their items, `m`: `dist(box_a, box_b) < m − EPS` (boxes `m` apart
  up to rounding, as in stacked columns, do not). With `m ≤ EPS`, their interiors must
  not overlap (exact shapes).
* With `avoid.label.items` hard, a label (not internal) overlaps no other item's mark and
  keeps its item's margin `m` from it: it is infeasible when `dist(mark_j, box) < m − EPS`
  and `dist(mark_j, box) < dist(mark_j, bbox(mark_i))` — never more than the other mark
  keeps from the bounding box of its own mark, so that items on top of or right next to
  each other can still be labeled.
* Warm-start candidates (§6.7: an item's warm-start box at any size, and its nudges)
  keep half the margin: two of them conflict below `m / 2`, and one is infeasible below
  `m / 2` from another mark. A label stays where it is until its neighbours come closer
  than half the margin, but takes a new place only with the whole margin.

**Own mark nearest** (`placement.own_nearest`, default `true`; ADR 0051). A label
without a distant leader — an adjacent or slider label, with or without a stub (§6.9) —
comes no closer to the mark of another item than to its own: it is infeasible when
`dist(mark_j, box) < dist(mark_i, box) − EPS` for an item `j` (not a member of `i`'s group)
whose mark the label may not cover (`items`, or `lower_items` for a less important `j`,
hard). Internal labels lie on their own mark, and the leader of a distant label says whose
it is: they are exempt. The margin above lets a mark that overlaps or touches the own mark
come closer than the margin; this rule still keeps it no closer than the own mark.

### 4.5 SVG backgrounds

Implemented identically by `label-anything-svg` and `@label-anything/svg` (ADR 0013) and
tested by `conformance/svg/`. All output is in canvas pixels, y down.

**Parsing.** XML 1.0 with namespaces and internal DTD entities; input that is not
well-formed is an error (`parse`). The root must be `<svg>` (SVG namespace or none,
else `invalid_value`); elements in other namespaces are never drawn. Limits (error
`limit`): 1024 nesting levels, 10⁶ elements, 2·10⁶ rendered elements after `<use>`
expansion, 8·10⁶ points; content more than 384 render levels deep (elements plus `<use>`
levels) is skipped with a `limit` warning.

**Viewport and canvas.** The root's `width`/`height` (unitless, px, pt, pc, in, cm, mm,
em = 16 px, ex, rem, %) give the viewport W × H. Percentages and missing values refer to
R = the `viewBox` size, else the canvas (if given), else 300 × 150; if exactly one of them
is missing and a `viewBox` exists, it follows the `viewBox` aspect ratio. The `viewBox` is
mapped into the viewport with `preserveAspectRatio` (all alignments, `meet`, `slice`,
`none`; default `xMidYMid meet`; a `viewBox` with width or height ≤ 0 is ignored), then
the viewport is scaled onto the canvas (non-uniform scale if the sizes differ; without a
canvas, canvas = viewport). Nested `<svg>` (x, y, width/height default 100 %, `viewBox`,
`transform`) and `<symbol>` instantiated by `<use>` (the `<use>`'s width/height override)
establish viewports the same way. Percent lengths refer to the nearest `viewBox` (else
viewport) size: x-like to the width, y-like to the height, others to √((w² + h²)/2).

**Styles.** Properties: `fill`, `stroke`, `stroke-width`, `fill-opacity`,
`stroke-opacity`, `opacity`, `fill-rule`, `display`, `visibility`, `font-size`,
`font-family`, `font-weight`, `font` (CSS only), `text-anchor`, `dominant-baseline`,
`vector-effect`. Priority (lowest first): presentation attributes, `<style>` rules
(by specificity, then source order; rules whose selector is outside the subset below, or
uses a pseudo-class, are dropped; @-rules are skipped), inline `style`, `!important`
rules, inline `!important`. Invalid values are ignored; `inherit`, `initial`, `unset`
work. All properties but `opacity`, `display` and `vector-effect` inherit; `opacity`
multiplies down the tree. A paint is *none* for `none`, colours with alpha 0
(`transparent`, `rgba(…, 0)`, `#rgba`, …) and `url(#id)` with a missing target and no
fallback; existing paint servers and `currentColor` count as opaque. An element is
**filled** if fill alpha × `fill-opacity` > 0 (images: always; `<line>`: never),
**stroked** if stroke alpha × `stroke-opacity` > 0 and `stroke-width` > 0, and **drawn**
if it is rendered (not `display:none`, not inside `<defs>`, `<clipPath>`, `<mask>`,
`<marker>`, `<pattern>`, `<symbol>` or other non-rendering elements unless instantiated by
`<use>`), its `visibility` is `visible` and the product of opacities is > 0.

**Geometry.** Drawn shapes (`rect` with `rx`/`ry`, `circle`, `ellipse`, `line`,
`polyline`, `polygon`, `path` with all commands, `image`) produce a polygon (one ring per
subpath, with the fill rule) if filled (never for lines), and a capsule polyline per
subpath if stroked, of width `stroke-width · √|det CTM|` (`vector-effect:
non-scaling-stroke`: unscaled). `<image>` is its `x/y/width/height` rectangle (no
intrinsic size). `<use>` (`href` or `xlink:href` to an element of the same document;
missing, external and circular references are skipped with an `ignored` warning) renders
its target with `transform · translate(x, y)`; styles inherit from the `<use>`.
`<switch>` renders its first child without `requiredExtensions` whose `systemLanguage`
(if any) includes English, skipping `<foreignObject>`; `<a>` acts like `<g>`. Not
modelled: clipping, masks, filters, markers, dashes, transparency inside gradients or
patterns, `<foreignObject>` content, external resources.

**Flattening** (tolerance `tolerance`, default 0.25 px): quadratic and cubic Béziers are
transformed to canvas px and split into n uniform parameter steps, n = ⌈√(k·M/tol)⌉,
M = maxᵢ |Pᵢ − 2Pᵢ₊₁ + Pᵢ₊₂|, k = ¼ (quadratic) or ¾ (cubic). Elliptical arcs (SVG
implementation notes F.6.5; radii that are too small are scaled up and the centre is the
chord midpoint), circles, ellipses and rounded corners are sampled uniformly in their
angle with n = max(⌈|Δθ| / (2·acos(1 − tol/r))⌉, ⌈|Δθ| / 90°⌉), r = the largest singular
value of CTM · R(φ) · diag(rx, ry); n ≤ 4096. All vertices lie on the exact curve and
the polyline is within `tol` of it.

**Text boxes.** Whitespace in a `<text>` collapses to single spaces and is trimmed at
both ends (`xml:space="preserve"`: tabs and newlines become spaces). `<tspan>`, `<a>` and
`<textPath>` content is laid out in order; the first value of `x`, `y`, `dx`, `dy`
(lengths, em, %) positions it, and an absolute `x` or `y` starts a new chunk. A run spans
`measure(text, font_size, first font family, weight)` horizontally and the measuring
font's ascent above / descent below the baseline (`dominant-baseline` `middle`,
`central`, `mathematical`: centred on y; `hanging`, `text-top`, `text-before-edge`: top at
y; `ideographic`, `text-bottom`, `text-after-edge`: bottom at y). The engine measures SVG
text with the bundled fonts (§5.2): their advances, and their ascender and descender
(1.069 em and 0.293 em, the vertical extent of a label line), as a browser's `getBBox`
does; an SVG parser without fonts uses 0.55 em per code point, 0.8 em and 0.2 em.
`text-anchor` shifts a chunk by 0, ½ or 1 times its advance. The box of each chunk (union of its visible,
painted runs) is transformed by the CTM; its axis-aligned bounding box is the `Rect`
primitive, attributed to the `<text>` element.

**Boxes and attribution.** Every rendered element has a geometry bbox (without stroke
width; ignoring visibility, paint and opacity, like `getBBox`): its own geometry or the
union over its rendered descendants (for `<use>`: its instance). Geometry drawn through
`<use>` is attributed to the **outermost** `<use>`: classification, `from_svg` lookups
and selectors see that element, never the referenced ones.

**Classification.** Primitives are classified by the first rule of `classes` (else the
preset's `svg_classes`) whose selector matches the element they are attributed to, else
by `default_class`; class `ignore` drops them. Selector subset (also for `from_svg`):
type selectors (case-sensitive), `*`, `.class`, `#id`, `[attr]`, `[attr=value]` (value
quoted or not, exact match), `[attr^=value]`, `[attr$=value]`, `[attr*=value]` (prefix,
suffix, substring; an empty value matches nothing), compound selectors
(`circle.outlier[data-k=1]`), descendant (whitespace) and child (`>`) combinators, comma
lists, CSS escapes, and the pseudo-classes
`:small` (element bbox ≤ 16 px in both dimensions), `:background` (bbox ≥ 90 % of the
canvas in both dimensions), `:filled` and `:unfilled`. Anything else (sibling
combinators, the `~=` and `|=` operators, attribute flags, other pseudo-classes and
pseudo-elements) is a `pattern` error.

`auto_mark_items: true`: items with `svg_id` take their mark geometry from that SVG
element (as `from_svg`), and that element is removed from its class. A `from_svg` mark is
the element's outline: per drawn shape its fill polygon, else its text boxes, else its
stroke capsules.

### 4.6 Raster backgrounds

The raster is decoded to RGBA8 (PNG, JPEG, WebP where available, or raw `rgba`) and
mapped onto the canvas with `scale` raster px per canvas px at `offset`. Modes produce a
per-pixel value in [0,1], which is area-averaged into the grid:

* `ink`: background colour = most frequent colour of the border pixels (quantized to 5
  bits per channel; ties → lowest quantized value), or `ink.background`. A pixel is
  composited over the background colour by its alpha and is ink (1) iff its OKLab
  distance to the background exceeds `ink.threshold`. After averaging, coverage is
  dilated by `ink.dilate` cells (3×3 max filter applied `dilate` times).
* `alpha`: 1 iff alpha/255 > `alpha.threshold`.
* `cost`: `1 − luma` of the pixel composited over white (`luma` = Rec. 709 of the sRGB
  values), or `luma` with `cost.invert`.
* `classmap`: each pixel goes to the class of the palette colour within
  `classmap_tolerance` (OKLab) of it (nearest wins, ties → first listed); background
  pixels (as in `ink`) are ignored; other pixels go to `ink` or nowhere (`unmatched`).
* `saliency`: Sobel gradient magnitude of the luma plus local contrast (|luma − 5×5 box
  mean|), each divided by its maximum over the image, averaged.

The rest of this section makes these rules exact. Decoding of PNG and raw RGBA, every
mode, the area averaging and the quantization are *identical* in all implementations
(reference: the `label-anything-raster` crate; tests: `conformance/raster`). Arithmetic
is IEEE-754 binary64 with `+ − × ÷ sqrt` only, evaluated in the order written
(left to right), plus exact integer arithmetic.

**Sources.** `source` is a `data:` URL (prefix and `;base64` marker case-insensitive,
media type not interpreted, payload base64 or percent-encoded) or bare base64; file
paths are resolved by the host. `rgba.data` is base64 of exactly `width·height·4` bytes.
Base64 accepts the standard and the URL-safe alphabet, ignores ASCII whitespace, and
allows padding only when it completes the last quantum (only whitespace may follow
it); a final quantum of one character is an error. Formats are recognized by
signature.

**PNG decoding** (the reference decodes with the Rust `image`/`png` crates; the
TypeScript decoder reproduces them): colour types 0/2/3/4/6, bit depths 1–16, Adam7.
Grey below 8 bit is scaled by `255 / (2^bits − 1)`, 16-bit samples become
`(v + 128) div 257`; palette indices beyond PLTE are opaque black; a palette `tRNS`
longer than the palette is ignored; a grey/RGB `tRNS` colour (compared on the low byte
of each sample below 16 bit) gets alpha 0. Gamma, colour profiles and APNG frames are
ignored (the default image is used). IHDR must come first; a PLTE length outside 3–768
or not a multiple of 3, duplicate IHDR/PLTE, unknown critical chunks before the image
data, IEND before IDAT and a CRC mismatch in a critical chunk are errors; ancillary
chunks with a bad CRC or content are ignored (the first valid `tRNS` before IDAT
counts). Only the first IDAT sequence is read; it must be followed by a complete chunk
header (length and type). The zlib header is checked, Adler-32 is not, and compressed
data beyond the image is ignored. An image whose expanded size (`w·h` times the bytes
per pixel after the expansion above, 2 per 16-bit sample) exceeds 512 MiB is rejected
(`limit_exceeded`) before its data is read.
JPEG and WebP are decoded where a decoder is available (Rust: `image`; TypeScript:
`createImageBitmap`); their pixels may differ between decoders.

Errors are structured, never crashes: `invalid_base64`, `invalid_data_url`,
`unsupported_format` (unknown signature), `corrupt_image`, `invalid_dimensions`,
`limit_exceeded`, `unsupported` (no decoder in this build/environment).

**Placement.** Raster pixel `(px, py)` covers the canvas square
`[ox + px/s, ox + (px+1)/s) × [oy + py/s, oy + (py+1)/s)` (`s` = `scale`,
`(ox, oy)` = `offset`); grid cell `(gx, gy)` covers
`[x0 + gx·c, x0 + (gx+1)·c) × [y0 + gy·c, y0 + (gy+1)·c)`.

**Compositing.** A pixel `(r, g, b, a)` is composited over a backdrop colour per
channel as `c' = (c·a + bg·(255 − a) + 127) div 255`, i.e.
`floor((c·a + bg·(255 − a)) / 255 + ½)` (no exact halves exist). The backdrop is the
background colour for `ink` and `classmap` and white for `cost` and `saliency`.

**Background colour** (`ink.background: "auto"`). Histogram of the border pixels (first
and last row and column, each pixel once) with alpha ≥ 128, keyed by the 5-bit
quantization `(r>>3, g>>3, b>>3)`; the most frequent key wins, ties go to the smallest
`(r5 << 10) | (g5 << 5) | b5`; the result is `(q << 3) | (q >> 2)` per channel. White if
no border pixel qualifies.

**OKLab** of an 8-bit colour. `r, g, b` are looked up in a 256-entry table holding the
sRGB EOTF of `i / 255` (`i/255/12.92` for `i ≤ 10`, else `((i/255 + 0.055)/1.055)^2.4`)
rounded once to binary64 (generated with exact arithmetic by
`tools/raster/gen_srgb_lut.py`). Then, with Björn Ottosson's matrices,

```
l = 0.4122214708·r + 0.5363325363·g + 0.0514459929·b
m = 0.2119034982·r + 0.6806995451·g + 0.1073969566·b
s = 0.0883024619·r + 0.2817188376·g + 0.6299787005·b
l' = cbrt(l), m' = cbrt(m), s' = cbrt(s)
L = 0.2104542553·l' + 0.7936177850·m' − 0.0040720468·s'
a = 1.9779984951·l' − 2.4285922050·m' + 0.4505937099·s'
b = 0.0259040371·l' + 0.7827717662·m' − 0.8086757660·s'
```

`cbrt` is deterministic: `±0`, `±∞` and NaN are returned unchanged and `cbrt(−x) =
−cbrt(x)`; for `x > 0` take the unique `k` with `u = x·8^k ∈ [1/8, 1)` (exact), start
from `y = ((0.5921815819·u − 1.385919418)·u + 1.458110692)·u + 0.3408421562`, apply three
Newton steps `y = y − ((y·y)·y − u) / ((3·y)·y)` and return `y·2^(−k)` (exact; within
1 ulp). The OKLab distance is `sqrt((ΔL·ΔL + Δa·Δa) + Δb·Δb)`.

**Pixel values.**

* `ink`: `v = 1` iff `distance(oklab(c'), oklab(bg)) > ink.threshold`, `c'` the pixel
  composited over the background colour `bg`.
* `alpha`: `v = 1` iff `a / 255 > alpha.threshold`.
* `cost`: with `n = 2126·R + 7152·G + 722·B` of the pixel composited over white (an
  integer; the Rec. 709 luma is `n / 2 550 000`), `v = (2 550 000 − n) / 2 550 000`, or
  `n / 2 550 000` with `cost.invert` (one division).
* `classmap`: the palette is the `classmap` object in document order (key order is
  significant). A pixel composited over the background colour (`ink.background`) is
  skipped if its distance to the background is ≤ `ink.threshold`. Otherwise it goes to
  the entry with the smallest distance among those within `classmap_tolerance`
  (`≤`; ties → first listed); an `"ignore"` entry drops it; without a match it goes to
  `ink` if `unmatched` is `"ink"`. The chosen class gets `v = 1`. One coverage grid is
  produced per class with non-zero coverage, in palette order of first occurrence,
  followed by `ink` for unmatched pixels if `ink` is not a palette class.
* `saliency`, on the integers `n` of `cost`: Sobel `gx`, `gy` with replicate-clamped
  neighbours (exact), `G = sqrt(gx·gx + gy·gy)`; the 5×5 window clipped to the image has
  `k` pixels with sum `S`, `C = |k·n − S| / k`; `v = (G / max G + C / max C) / 2` with the
  maxima over the whole image (a term is 0 when its maximum is 0). This is the
  normalized Sobel magnitude and `|luma − box mean|` (the luma scale cancels).

**Area averaging and quantization.** Per axis, a pixel interval `[p0, p1)` and a cell
interval `[g0, g1)` (computed as in *Placement*) have the weight
`w = (min(p1, g1) − max(p0, g0)) / c`, used iff the overlap is > 0. Then

```
h[py][gx]   = Σ over px ascending of  v(px, py) · wx(px, gx)
cov[gy][gx] = Σ over py ascending of  wy(py, gy) · h[py][gx]
```

each sum starting at +0 and adding term by term (zero terms may be skipped; they never
change a sum). The coverage byte is `q = min(255, floor(cov·255 + ½))`, and 1 if `q = 0`
but `cov > 0` (§4.1). Cells partially outside the raster simply receive less.

**Dilation** (`ink` only): a 3×3 maximum filter applied `ink.dilate` times to the
quantized grid, cells outside the grid ignored.

Inconsistent geometry (scale or cell not finite and > 0, non-finite offsets or grid
origin) yields zero coverage.

**Backdrop luma** (for the `contrast` cost term, §8; ADR 0037). With `weights.contrast >
0` and at least one raster source, the engine also records how light the backdrop behind
the labels is, whatever the sources' modes. The backdrop grid has cells of `C = 2c` from
the grid origin, `ceil(cols / 2) × ceil(rows / 2)` of them (one per 2 × 2 grid cells).
Each backdrop cell `(col, row)` is sampled at the 2 × 2 points
`(x0 + (2·col + i + 0.5)·(C/2), y0 + (2·row + j + 0.5)·(C/2))`, `i, j ∈ {0, 1}`: the
centres of its grid cells. A sample starts with the luma numerator
`n = 2126·R + 7152·G + 722·B` of `canvas.background`. Every raster source in order
(later sources lie on top) whose pixel `px = floor((x − ox)·s)`, `py = floor((y − oy)·s)`
exists (`0 ≤ px < width`, `0 ≤ py < height`) changes it with that pixel's alpha `a` and
the numerator `n_px` of its own colour: to `n_px` if `a = 255`, to
`(a·n_px + (255 − a)·n) / 255` if `0 < a < 255`, not at all if `a = 0`. The cell's value
`v = ((n₀₀ + n₁₀) + (n₀₁ + n₁₁)) / 4` (`n_ij` of sample `(i, j)`) is quantized to
`s = min(255, floor(v / 10 000 + ½))` (the Rec. 709 luma of `cost` × 255). Sources with
inconsistent geometry are skipped. If every cell has the same `s` there is no backdrop
and the term is 0; otherwise summed-area tables of `s` (`u32`, as in §4.1) and of `s²`
(exact integer sums, below 2⁵³) are built. SVG backgrounds and vector layers carry no
colours here: they do not change the backdrop.

### 4.7 Distance transform

The exact Euclidean distance transform (Felzenszwalb–Huttenlocher) of the union of all
**static hard** classes for labels (cells with coverage > 0, plus `canvas_edge` outside
the label area) is computed on the grid in cell units and stored in px. It drives
free-space seeds for distant candidates and early rejection.

---

## 5. Labels

### 5.1 Label kinds

* `text`: measured with the built-in shaper (§5.2) unless `width`/`height` are given, or
  with the host's measurement where a binding takes one (a `measure(text, font)` callback
  returning width, ascent and descent; called with the empty string for a font's vertical
  metrics; none: the built-in measurement).
* `icon`, `box`: fixed `width × height`; `shape` (`rect`, `rounded:r`, `circle`,
  `polygon` with `polygon` points) is used for exact collision tests.
* `composite`: parts laid out in a `row` (default) or `column`, `gap` (default 0)
  between consecutive parts, aligned `center` (default), `start` or `end` across the main
  axis. Text parts are single lines measured with their font (inheriting the composite's
  `font`), icon and box parts use their `width × height`; a part's own `padding` is
  ignored, the composite's `padding` (default `defaults.padding`) surrounds the whole
  row or column.

The **label box** is the content box grown by `padding` on every side. It is the
collision box and the reported `box`. Text is drawn at `x_offset = padding` and the
reported baselines.

### 5.2 Text measurement

Fonts: the bundled Noto Sans subset (Regular 400, Bold 700, families `default` and
`Noto Sans`) or fonts supplied in `font.file` / registered through the API: TrueType,
OpenType (CFF) or the first font of a collection; WOFF2 only in Rust with the `woff2`
feature. A request `(family, weight, style)` resolves to the family compared ASCII
case-insensitively, else `default`, else the first registered family; within it to the
requested style if it has one (else the other); then to the nearest weight (smallest
|Δ|, ties → the lighter weight, identical entries → the latest registered). Fonts without
`head`, `hhea`, `maxp`, `hmtx` or a usable `cmap`, or with `unitsPerEm` outside 16–16384,
are rejected; a malformed `OS/2`, `GDEF`, `GPOS` or `kern` table is ignored.

**Simple shaping** (identical in all implementations, ±0.01 px tested; in practice
bit-identical):

1. *cmap*: one subtable is used, the first with the best (platform, encoding) of (3,10),
   (0,4), (3,1), (0,3) whose format is 4 or 12. Its segments (groups) are stably sorted by
   start code and the first one containing a code point maps it. Unmapped code points and
   glyph ids ≥ `numGlyphs` give glyph 0. There is no Unicode normalization and no special
   treatment of default-ignorable code points: they are measured with the glyph the
   `cmap` gives them.
2. *Advances*: the `hmtx` advance of every glyph (glyphs after `numberOfHMetrics` repeat
   the last one).
3. *GPOS kerning*: the kern lookups are the union of the lookup indices of every `kern`
   feature referenced by any script's default or language system (its feature indices
   and its required feature), in ascending order; only PairPos subtables take part (lookup
   type 2, or subtables of a type 9 lookup whose extension type is 2). Each lookup walks the
   whole glyph sequence: position `i` is skipped if its glyph is a mark (GDEF glyph class
   3) and the lookup flag has IgnoreMarks (other flags are ignored); `j` is the next
   position, skipping marks under IgnoreMarks. The first subtable that matches
   `(g[i], g[j])` — format 1: the pair is listed; format 2: `g[i]` is covered and both
   classes are below their counts, so class 0 matches too — adds the `XAdvance` of both of
   its value records, and the walk continues at `j + 1` if its ValueFormat2 ≠ 0, else at
   `j`; without a match it continues at `i + 1`. Device tables are ignored. Coverage and
   ClassDef ranges are stably sorted by start (the first containing a glyph wins);
   duplicate glyphs and pairs keep their first record.
4. *Legacy kerning*: if no language system references a GPOS `kern` feature, a `kern` table
   (Microsoft version 0 or Apple version 1.0) is one IgnoreMarks lookup whose pairs never
   skip their second glyph and whose values are summed over its format 0 subtables that
   are horizontal, not cross-stream and not minimum values (Apple: not vertical, not
   cross-stream, no variation).
5. *Width* = `(Σ advances + Σ adjustments) · size / unitsPerEm`, computed in that order
   (integers first, one multiplication and one division).

**Full shaping** (Rust: rustybuzz with its default features, so `kern` is on) is used when
`text.shaping = "full"`, or `"auto"` and the text contains a code point of U+0590–08FF
(Hebrew, Arabic, Syriac, Thaana, NKo, …, Arabic Extended-A), U+0900–0DFF (Devanagari …
Malayalam, Sinhala), U+0E00–109F (Thai, Lao, Tibetan, Myanmar), U+1100–11FF (Hangul
Jamo), U+1780–18AF (Khmer, Mongolian) or the extension blocks U+1CD0–1CFF, U+A8E0–A8FF,
U+A960–A97F, U+A9E0–A9FF, U+AA60–AA7F, U+D7B0–D7FF, U+10EC0–10EFF, U+11660–1167F,
U+11B00–11B5F. TypeScript has no full shaping and measures such texts with simple
shaping unless the host supplies `width`/`height`.

**Vertical metrics:** ascent = `hhea.ascender`, descent = `−hhea.descender` (or the
OS/2 typo metrics when USE_TYPO_METRICS, `fsSelection` bit 7, is set), scaled by
`size/unitsPerEm`.

**Ink:** a font may carry the vertical bounds of its glyphs' outlines in a private table
`LAvb` (the bundled fonts do, `tools/fonts/bounds.py`): `uint16` version (1), `uint16`
numGlyphs, then per glyph id `int16` yMin, `int16` yMax in font units, both 0 for a glyph
without outline; a table of another version, of another glyph count than `maxp`'s or too
short for its count is ignored. The **ink** of a line is the lowest yMin and the
highest yMax over its code points' glyphs (the `cmap` of simple shaping) whose yMin ≠ yMax,
scaled by `size/unitsPerEm`; a line has none when its font has no `LAvb`, when none of
its glyphs has an outline, or when it is measured with full shaping.

**Text block:** a block of `n` lines has height `top + bottom + (n−1)·line_height·size`,
where `top` is the ink top (yMax) of the first line and `bottom` the ink bottom (−yMin) of
the last line; an edge whose line has no ink, or every edge when the host measures the
vertical metrics (a measurement of the empty string, §5.1), takes the ascent or descent
instead. The baseline of line `i` is at `padding + top + i·line_height·size` from the box
top. So a box fits its letters: one line of `Alpha` is `0.76 + 0.24 + 2 × 0.15 = 1.3 em`
high with the default padding (with ascent and descent: 1.662 em), and a label above or
below its anchor stands as close to it as one beside it (ADR 0052).

### 5.3 Line breaking, wrapping, truncation

Positions are **code point** indices `0 … n−1` of the text; `width(s)` is the measured
width of a string (§5.2, or a host measurement). *White space* is the Unicode `White_Space`
property; *combining marks* have General_Category Mn, Mc or Me (Unicode 15.1, one table
shared by all implementations, generated by `tools/text/gen_unicode_tables.py`).

**Break opportunities.** A line may end after position `k` (`0 ≤ k < n−1`), between
`a = text[k]` and `b = text[k+1]`, iff `b` is not a combining mark and one of:

| rule | condition |
|---|---|
| space | `a` is white space other than the no-break spaces U+00A0, U+2007, U+202F |
| punctuation | `a` is one of `/ \ . _ - , ; : \|`, except between two colons (`::` breaks only after the second) and except `.` or `,` with an ASCII digit on both sides (`3.14`, `1,000`) |
| camelCase | `a` is Lowercase and `b` is Uppercase (Unicode properties) |
| acronym | `a` and `b` are Uppercase and `text[k+2]` is Lowercase (`XMLHttp` → `XML`·`Http`) |
| CJK | `a` and `b` are both in U+2E80–9FFF, U+AC00–D7AF, U+F900–FAFF, U+FF00–FFEF or U+20000–2FFFF |

There are no mandatory breaks here (line feeds are ordinary white space); a label whose
text contains line feeds is laid out by them instead (*hard breaks*, below).

**Lines.** The line `[s..e]` is the text from `s` to `e` without trailing white space. The
first line starts at the first position that is not white space; after a line ending at
`e` the next one starts after `e`, skipping white space. A blank text is one empty line.
The searches below assume that extending a line never makes it narrower: they scan in
ascending order and stop at the first candidate that does not fit, which for such widths
is the same as taking the largest candidate that fits.

`greedy(W)`: the line starting at `s` is the rest of the text if `width([s..n−1]) ≤ W`;
otherwise it ends at the last break `k ≥ s` with `width([s..k]) ≤ W` (scanning up to the
first break that does not fit). If even the first break after `s` does not fit, the line
ends inside the segment `[s..t]` (`t` = the first break `≥ s`, or `n−1`; *emergency
break*): at the last fitting `e ∈ [s, t)` that is not followed by a combining mark
(scanning up to the first that does not fit), else at the first such `e`, else at `t`.

`balanced(N, M)` (`M` optional): the candidate widths are `width([s..k])` for every line
start `s` (the first one and the one after each break) and every `k ≥ s` among the
breaks and `n−1`; with `M`, `k` runs in ascending order and stops at the first width
`> M`, and `M` is a candidate itself. Candidates narrower than the *floor* are dropped:
the widest first segment of a line, `max_s width([s..t])` over the same line starts (`t` =
the first break `≥ s`, or `n−1`), and with `M` at most `M` — below it `greedy` would end a
line inside a word, which only a segment wider than `M` may force. Sorted ascending without
duplicates, the smallest candidate `c` such that `greedy(c)` has at most `N` lines is found
by binary search
(`lo = 0`, `hi = last`; `mid = ⌊(lo + hi)/2⌋`; `hi = mid` if `greedy(c[mid])` has at most
`N` lines, else `lo = mid + 1`). The result is `greedy(c[lo])`, or `greedy(M)` if that still
has more than `N` lines.

`truncate_end(text, W)`: the text itself if it fits; else `p + "…"` for the longest prefix
`p` of `m` code points (`m = 1, 2, …` in ascending order, skipping `m` where `text[m]` is a
combining mark, trailing white space removed) such that `p + "…"` fits; `"…"` if none does.

`truncate_middle(text, W, L)`: the text is trimmed (`n` code points). If `greedy(W)` has at
most `L` lines, that is the result. Otherwise a binary search (`lo = 1`, `hi = n`, as
above) finds the smallest `r` such that `greedy(W)` of `left + "…" + right` has at most `L`
lines, where `left` is the first `⌈(n−r)/2⌉` code points, shortened while the code point
after it is a combining mark, and `right` the last `⌊(n−r)/2⌋`, shortened while it starts
with a combining mark, both without the white space next to `…`; the result is that
`greedy(W)`.

**Hard breaks.** A text label whose text contains a line feed (U+000A) has a single
normal variant: the lines between its line feeds (a carriage return right before a line
feed is dropped), as given. It has no wrap or truncation variants — neither from wrap
settings nor from the `wrap` and `truncate` ladder steps. The rest of this section applies
to texts without line feeds.

**Variants** of a text label with wrap settings (`max_width = M`, `max_lines = L`):
`L_min` = lines of `greedy(M)` (without `M`: 1, the single line). If `L_min ≤ L`, the
variants are `balanced(n, M)` for `n = L_min … min(L_min + 2, L)` without duplicates
(`wrap.balance: false`: only `greedy(M)`). If `L_min > L`, the text is truncated per
`truncate`: `end` keeps the first `L − 1` lines of `greedy(M)` and adds
`truncate_end(rest, M)` for the text from the start of line `L` on; `middle` uses
`truncate_middle(text, M, L)`; `none` keeps the whole text as `balanced(L)` without `M`
(lines may be wider than `M`; not counted as truncated), because the line count bounds
the label height. A variant reports its lines and `width(line)` of every line.
Without wrap settings the normal variant is the single line; the `wrap` ladder step adds
`balanced(n)` (no `M`) for `n = 2 … degrade_options.wrap_max_lines`, without duplicates,
without single-line results, without results with an emergency break (a line ending
neither at a break opportunity nor at the end of the text: `United Kingdom` in three lines
would split a word) and without results with a line narrower than 1.5 em of the label's
font at its scale (`France 3` in two lines would strand the `3`).

### 5.4 Label variants

A **variant** is one concrete label shape: text lines (or fixed size), font scale and
its shape penalty `shape_penalty` (sum): `0.25` per extra line, `0.5` per alternative
index + 0.5, `1.0` if truncated, `2·(1 − scale)` for shrinking, `+2` for soft overlap.

---

## 6. Candidates

Candidates are generated per item and variant; every candidate has a label box, an
optional leader, a model, a position rank, a degradation level and a static cost.

### 6.1 Adjacent (8 fixed positions)

For position direction `d` (top `(0,−1)`, right `(1,0)`, bottom `(0,1)`, left `(−1,0)`,
top-right `(1,−1)`, bottom-right `(1,1)`, top-left `(−1,−1)`, bottom-left `(−1,1)`), with
the shape `S` inflated by `offset` (`S ⊕ o`) and the label half-size `(hw, hh)`:

```
s = support_{S⊕o}(d)
center = s + (sign(dx)·hw, sign(dy)·hh)
```

i.e. the label's corner (diagonal positions) or side midpoint (axis positions) opposite
to `d` sits on the support point. The label touches `S ⊕ o` and does not intersect it
(exact for convex shapes; concave shapes use the hull). `position_order` gives the rank
`0..7`: `perceptual` = top, right, bottom, left, top-right, bottom-right, top-left,
bottom-left (Bobák et al. 2026); `cartographic` = top-right, top-left, bottom-right,
bottom-left, right, left, top, bottom (Imhof); or an explicit list (unlisted positions
are not generated).

### 6.2 Slider

The touching positions of the label around `S ⊕ o` form a closed curve (the boundary of
the configuration obstacle `(S ⊕ o) ⊕ (−B)`). Between two angularly consecutive fixed
positions, `slider_per_quadrant` candidates are sampled at equal arc length along this
curve (excluding the endpoints). Their rank is the mean of the two neighbours' ranks
+ 0.5.

### 6.3 Internal

If `models` contains `internal` and the internal policy allows it (`auto`: prefer for
rect, ellipse, polygon, path marks and area anchors; allow for circles with
`r ≥ internal_circle_ratio × label height`; never for icons and r < that), candidates
at the pole of inaccessibility (polylabel, precision 0.5 px) and at the reference point,
accepted iff the label box grown by `inner_padding` lies inside the shape. `prefer` gives
them rank −1 (before all external positions); `allow` gives rank 8.

### 6.4 Distant (with leader)

Positions on `distant_rings` rings with radii evenly spaced in
`[min_distance, max_distance]` (measured from the shape boundary), in the directions of
the leader style (`straight`: `distant_directions` evenly spaced; `angles`/`elbow`: the
listed angles; `orthogonal`: 8 octilinear directions), plus free-space seeds (local
maxima of the distance transform within `max_distance` whose clearance ≥ label
half-height). For each target the label is attached by its port side facing the anchor
and the leader is built per style (§7). The `k_distant` cheapest (static cost) are kept.
An item whose `position_order` lists fewer than the 8 fixed positions keeps its distant
labels on those sides: only directions (and seeds, seen from the reference point) within
22.5° of a listed position's direction are used (`u·v ≥ cos 22.5° · |u|·|v|` less 10⁻⁹,
so that a direction between two octants belongs to both), e.g. `["right"]` keeps end
labels of a line chart off the lines to the left.

### 6.5 Area anchors

Internal candidates at the polygon's pole of inaccessibility and at grid samples
(spacing = label height) inside the polygon where the label box (+ `inner_padding`) fits,
ordered by clearance. If none fit, the item falls back to a point-like item at the pole
with mark `anchor.dot` (default circle r = 2), with external candidates and leaders. Area
polygons are not obstacles of other labels.

### 6.6 Boundary

Boundary candidates come from the `boundary` model or the `boundary` ladder step; the
default ladder has no `boundary` step, since a label that fits nowhere near its anchor
would get a leader across the picture (ADR 0019).
Slots in the margins along `placement.boundary.sides`, `margin` from the edge: an item's
candidates stand at its anchor's height (left and right; its x for top and bottom) and one,
two and three label heights (widths) above and below it. After the search and the fans
(§6.8), the labels on each side form a **column** (ADR 0030):

* **Layout.** The members, ordered by their anchors along the side (then index), keep
  their placed variant (else the first, at level 0 with the `boundary` model, else at the
  level of the ladder's `boundary` step); a column at **full size** takes, for a placed
  variant that the ladder's `shrink` step made, the first variant at scale 1 with the same
  text (lines, origin, truncation) instead. The labels are stacked by 1-D isotonic packing
  around their anchors' coordinates (`stack`) or evenly spread (`spread`), with gaps of
  the larger of `placement.boundary.gap` and the two labels' margin (§4.4). The labels
  align on the column's line facing the picture, `margin + depth` from the edge (`depth`
  the widest label on the left and right sides, the tallest on the top and bottom), where
  every leader ends. With `straight` and `angles` leaders the items are assigned to the
  slots by minimum total leader length (min-cost bipartite matching to the ports on that
  line), which keeps the leaders from crossing; with the other styles they keep their
  order. Labels the search placed keep their rank and level; others get rank 9.
* **Re-stacking.** The labels the search placed on a side (at least two) are laid out as
  one column at full size; it replaces them when every label stays feasible and free and
  their total cost drops. When it does not and a member's label is shrunk, the column is
  laid out again with the placed variants and replaces them on the same terms.
* **Filling.** Then, side by side in the order of `sides`, items without a label that may
  take a boundary label (with `boundary` among their models, from the model or the ladder
  step; not `keep_with` members and grouped items; reason `omitted_by_priority`,
  `no_feasible_candidate` or none) join the side's column one at a time, in total order:
  the column with the item is laid out at full size and its labels are tested, in column
  order, against everything placed, the members' own labels lifted; a member fails for a
  reason of its own (statically infeasible) or because of the first placed label in
  conflict, the one in its way. When a member fails and a member's label is shrunk, the
  column is laid out and tested again with the placed variants, and the failures are those
  of that layout. While the column fails, the first label in the way of a failing member
  (in column order) whose item may take a boundary label, and whose label is not internal
  and stands on the column's side of its anchor (center x < the anchor's for the left
  side, ≥ for the right, y likewise for top and bottom), brings its item into the column,
  which is laid out again; when no such label is left, the item stays without a label. A
  column without failures replaces its members' labels, unless it inverts priorities (the
  priority rule of §6.8) or takes the label area past `priority.budget.max_ink_fraction`
  (the item stays without a label); the fill stops when the labels reach `max_labels`. Not
  with `prefix` omission, after a cancellation or after the time guard; at most
  `max(20000, 20 × n_items)` label evaluations (one per label of each laid-out column).
* **Leaders** run from the anchor to the port (§7) and keep no `leaders.max_length`. Like
  fan leaders they leave a crowd of touching marks: a mark closer than the clearance to
  the leader's start they must only not cross (§7).

### 6.7 Static cost and pruning

Static cost = every cost term of §8 that does not depend on other labels. Candidates
violating a static hard constraint are infeasible (kept only for explanations).
Candidates with static cost > `prune_factor × best + 1` of the same item and level are
dropped.

Filtering while generating (ADR 0015), always exact:

* When labels may overlap no item mark (`avoid.label.items` and the own-mark policy
  hard), non-internal rectangular candidates whose box contains, with a 2·EPS margin,
  the center of an occupancy cell lying inside an item mark are not created; they are
  counted per item and reported as `items` among the blocking classes. The occupancy
  grid covers the extent with square cells of `max(2, sqrt(area / 10⁶))` px.
* Candidates generated while labels are placed (ladder steps, on-demand distant
  candidates) are not kept when a placed label or leader of higher or equal priority
  blocks them under a hard policy. With hard label–label overlaps and every placed
  label of key ≤ the item's, rectangular candidates are first tested against the same
  kind of occupancy grid of placed rectangular labels.
* The warm-start box of an item is an extra level-0 candidate of the level-0 variant of
  its size (width and height within 0.5 px; ADR 0016): slider-kind on the allowed
  position its center points to when it is at most `offset + 1` px from the mark, else a
  distant candidate; none when it overlaps the own mark or is statically infeasible. A
  `warm_start` entry with an `anchor` (the anchor point it was placed for, as a result
  reports it) is first moved by the item's anchor movement: `box + (reference − anchor)`,
  the reference point of §11. The same box can become a candidate of a ladder variant
  (§10.1).
* The leader of a distant warm-start candidate, within the leader length limits: with
  the `straight` style, a straight leader to the box; with `angles`, `elbow` and
  `orthogonal`, the entry's `leader` (its `points`, when its `style` is the one in use
  and the entry has no `leaders`), moved like the box, when it still starts where the
  item's leaders start (§7, `attach`) and ends on the box (both within 0.5 px) and, for
  `angles` and `elbow`, its first segment is within 0.5° of an allowed direction; with
  the `baseline` port (not `orthogonal`) it gets the variant's underline; not for the
  representative of a group (ADR 0027). With `curved` there is none.
* Nudges: for the warm-start box of the level-0 variant that lies on a slider path (its
  center within 0.75 px of the path of §6.2 over the item's allowed gaps, chained
  through consecutive gaps, curved stretches followed by their chords between the
  vertices), the points 0.05, 0.1, 0.2, 0.4 and 0.8 em along the path from the nearest
  point, each step forwards and then backwards (a path all around the mark wraps, one
  that ends stops there), are slider candidates of that variant, placed as those of
  §6.2 are, on the allowed position their center points to (as the warm-start box);
  only statically feasible ones count. They are made when §10.1 asks for them (ADR
  0027).
* Warm-start candidates (the warm-start box, at any size, and its nudges) keep half the
  label margin (§4.4, ADR 0028).

### 6.8 Fan labels

After the search (§10.3), crowds of items get their labels stacked in a column beside the
crowd, each with its own leader (model and anchor side `fan`; ADR 0022). `placement.fan`:
`auto` (default) for crowds with items left without a label, when the column places more
labels; `always` for every crowd, when the column places at least as many; `off`. There are
no fans with `prefix` omission, with the `angles` leader style (its leaders keep to the
allowed rays, which a column of labels cannot), after a cancellation or after the time
guard. Items that may not get leaders (neither their models, as extended by the `auto`
preset, nor the ladder have `distant` or `boundary`), `keep_with` members, area anchors
and grouped items take no part. `h` below is the height of an item's first variant, `em`
its font size.

* **Crowds.** In total order, every item not yet in a crowd seeds one (`auto`: only items
  without a label whose reason is `omitted_by_priority`, `no_feasible_candidate` or
  none). Breadth first from the seed, the items whose anchor lies within
  `(h_a + h_j) / 2` vertically of a member `a`'s and whose mark box is at most the larger
  `em` of the two away horizontally (the gap between the boxes, 0 when they overlap)
  join, nearest first (anchor distance, then index), up to 24 items. A crowd of one is
  left alone.
* **Sides.** A column stands right of the crowd when the seed's `position_order` has
  `right`, `top-right` or `bottom-right`, left of it when it has a left position. Each
  allowed side is laid out; the better plan is applied (labels for more important items:
  the sorted key lists compared lexicographically, then more labels, then the lower total
  static cost) and the other side is laid out again for the members left.
* **Members.** The crowd's items without a label (`always`: also those labeled on that
  side, by a non-internal label whose center x is ≥ the anchor's for the right side, < for
  the left), except one that fails in a column of its own for a reason of its own
  (below).
* **Layout.** Members ordered by anchor y, x, index keep their placed variant (else the
  first); at full size, a placed variant that the ladder's `shrink` step made is replaced
  by the first variant at scale 1 with the same text (lines, origin, truncation), as in
  boundary columns (§6.6). Each layout is made at full size first; when a member fails and
  a member's label is shrunk, it is made again with the placed variants, whose failures
  count. Their slots are stacked like boundary labels (`stack`, gaps
  `(h_a + h_b) / 2 + max(boundary.gap, m)` with `m` the larger margin of the two labels,
  within the label area) around the anchors' heights. The labels' near side is at
  `edge ± run`: `edge` the outermost side of the members' mark boxes,
  `run = max(min(rise, room), 1.5 em)` (`rise` the largest vertical distance between a
  member's anchor height and its slot, so that leaders are at most 45° steep; `room` what
  the label area leaves beyond `edge` and the widest label). Members take the slots in
  their order, unless (equal heights, `straight` leaders) the min-cost matching of anchors
  to the ports' points by distance is shorter by more than `10⁻⁶ · (1 + total)`. The
  leader is built like a boundary leader (§7) to the middle of the label's near side; a
  leader longer than `leaders.max_length` makes the label infeasible. The labels (rank 8)
  are evaluated (§8) and tested in column order against everything placed, the members'
  own labels lifted and the members tested before counting as placed: a member fails for a
  reason of its own (statically infeasible) or because of the first placed label in
  conflict (in query order), the one in its way.
* **Repair.** While the column fails: the first label in the way of a failing member
  whose item is placed, takes part, is not fixed, is labeled on that side and has a
  mark box within the crowd's horizontal extent ± `em` joins the column; else the first
  failing member that has a label keeps it and leaves the column (fixed); else the
  failing member of the highest rank (lowest priority) leaves. The column is given up
  when no member is without a label (`always`: and fewer than two members remain), when
  more than 40 members remain, or when the budget is spent; a column without failures
  replaces its members' labels.
* **Label budgets.** A column keeps to `priority.budget`: while its members without a
  label would take the number of labels past `max_labels`, or its labels (replacing the
  members' own) the label area past `max_ink_fraction`, the lowest-priority member without
  a label leaves (the ink is checked once the column is laid out without failures).
* **Priority.** A column is not applied when it would make an omitted item placeable once
  labels of strictly lower key were removed (the removal test of §9.2) where it was not
  before: the items checked are those with a candidate meeting (within the leader spacing
  reach) a label the column places or lifts.
* **Work.** At most `max(20000, 20 × n_items)` label evaluations in all (one per label
  of each laid-out column).

### 6.9 Stubs

In a crowd of points a label next to its point can be read as the label of a neighbour.
With `placement.stubs: auto` (default `off`; ADR 0050) such a label may stand off its point
a little, joined to it by a **stub**: a short straight leader at a right angle to the
label's side.

* **Ambiguous.** An adjacent or slider candidate (§6.1, §6.2) of item `i` is ambiguous
  when the mark of another item `j` (not a member of `i`'s group) comes closer to its box
  than `stub_reach` (`dist(S_j, box) < stub_reach`, the exact shape distance). Items whose
  mark is larger than their font size (the larger side of its bounding box `> em`) have no
  ambiguous candidates: a label against a large mark reads as attached to its outline.
* **Twin.** For an ambiguous candidate the same position is made with the offset
  `o + stub_length` (`o` = `placement.offset`): the adjacent position of the same direction
  on `S ⊕ (o + stub_length)`, or the slider sample of the same index on the path of
  `S ⊕ (o + stub_length)` (§6.2; concave polygons pushed in to that offset), with the same
  model, side and rank.
* **The stub** of a box with center `c`, width `w` and height `h`, for the mark's
  reference point `p`: horizontal when `|p.y − c.y| ≤ h / 4` and `p` lies left or right of
  the box, from the mark's boundary point in direction `±x` (`anchor_gap` outside it, or
  the tip of an icon mark) to `(x0, p.y)` or `(x1, p.y)` on the box; vertical when
  `|p.x − c.x| ≤ w / 4` and `p` lies above or below the box, to `(p.x, y0)` or `(p.x, y1)`,
  likewise. It meets the side of the label facing the mark at a right angle, within the
  middle half of that side. A box diagonal to the mark has no stub. `leaders.style`,
  `port`, `attach`, `min_length` and `max_length` do not apply; the result reports a stub
  as the label's `leader` with `stub: true`.
* **Replacement.** The twin with its stub replaces the ambiguous candidate when it has a
  stub and is statically feasible (§6.7, with the rules below); otherwise the candidate
  stays as it is. The candidate filter of §6.7 then applies to the one kept.
* **Rules.** A stub is a leader for the rules of §7: it crosses no other leader, passes
  through no label and keeps `leaders.clearance` from the marks of other items; it is
  exempt from the diverging-leaders rule, which compares distant leaders. With
  `avoid.leader.labels` hard, other labels also keep from a stub the space two labels keep
  (§4.4): a stub and the box of another label conflict when they come closer than the
  larger margin of the two items, `m` (`dist < m − EPS`). The label itself follows §4.4 as
  an adjacent label does, so with `own_nearest` no mark it may not cover is nearer to it
  than its own mark, `o + stub_length` away. Its costs are those of §8 for a leader, except
  that `w_leader_length · len / em` (term `stub`) replaces
  `w_leader + w_leader_length · len / em + w_bends · bends`; the label keeps its
  `w_distance` term (its gap includes the stub) and has no ambiguity term. The uncross
  repair (§10.3) does not move labels with stubs.

---

## 7. Leaders

* Start: on the item's true boundary toward the port, `anchor_gap` outside (or at the
  icon tip; `attach: center` uses the reference point).
* `straight`: one segment start → port.
* `angles`: as straight, but distant candidates are generated along the allowed rays,
  so the segment direction is one of `leaders.angles`.
* `orthogonal`: `po` (one bend: vertical then horizontal, or horizontal then vertical)
  or straight when aligned. Boundary and fan labels get `po` leaders too: parallel to
  the side up to the label's row (left, right) or column (top, bottom), then straight
  into the label, so that no leader bends twice. Minimal bends first.
* `elbow`: a first segment at an allowed angle, then horizontal into the label's side
  center.
* `curved`: quadratic Bézier, flattened for collision tests (reported in `curve`).
* `port`: `nearest` = point of the label box closest to the leader's previous point;
  `side-center` = midpoint of the side facing the anchor; `baseline` = the point of the
  side edge facing the leader at the height of an underline below the first text line,
  which continues the leader to the far end of that line (the underline is part of the
  leader; straight, angles and elbow leaders — curved and orthogonal leaders keep their
  own ports, and labels without text use `side-center`).
* Leaders never enter their own label except at the port, never pass through other
  labels (`avoid.leader.labels`, default hard), and never cross other leaders
  (`avoid.leader.leaders`, default hard). Leaders shorter than `min_length` are dropped
  (the label is then reported as adjacent) and longer than `max_length` are not
  generated, except those of boundary labels (§6.6).
* **Clearance from marks** (`avoid.leader.items`, default hard): every segment of a
  leader stays at least `clearance` (the item's `leaders.clearance`) away from the marks of
  other items — a leader passing a mark seems to point at it. Exempt are the marks of
  the item's own group and marks that contain the leader's anchor (the item's reference
  point; for a group label's leader to a member, the member's): no leader of the item
  avoids those. The leader of a fan or boundary label (§6.8, §6.6) is also exempt from
  marks that contain its start, and a mark closer than `clearance` to its start it must
  only not cross (it leaves a crowd of touching marks in the order of its column). With a soft weight `w`,
  every mark closer than `clearance` costs `w · (1 − d / clearance)`. The marks of less
  important items follow `avoid.leader.lower_items` where it is given (§4.4).
* **Spacing between leaders** (with `avoid.leader.leaders` hard): two leaders of
  different labels conflict when a segment of one intersects a segment of the other, or
  when a vertex of one (start, bends, port, underline ends) is closer than `clr` to a
  segment of the other, `clr` being the larger `leaders.clearance` of the two items;
  leaders that do not intersect are closest at such a vertex. The start of one leader is
  exempt when the other leader starts within `clr` of it: leaders of neighbouring marks
  start close together (if they stay close, their other vertices come close too). Two
  leaders closer than the clearance read as a crossing.
* **Diverging leaders** (with `avoid.leader.leaders` hard): two leaders of distant
  labels whose starts are closer than the larger font size of the two items conflict
  when the directions of their first segments differ by less than
  `leaders.min_angle_between` (`u·v > cos(α)·|u|·|v|`, `cos` from the deterministic math;
  0 turns the rule off). Boundary and fan leaders run in parallel by design and are
  exempt.

---

## 8. Cost model

For candidate `k` of item `i` (all terms ≥ 0, summed in this order):

```
cost = Σ_class w_label[class] · covered(label_k, class) / em²
     + Σ_class w_buffer[class] · covered(ring_k, class) / area(ring_k)
     + w_contrast · (4 · D(label_k) · C² / 65025) / em²
     + [leader] (w_leader + w_leader_length · len/em + Σ_class w_leader[class] · covered_len/em + w_bends · bends)
     + w_position · rank / n_positions
     + w_distance · gap(label_k, S_i) / em
     + w_shape · shape_penalty(variant)
     + w_edge · max(0, 1 − dist_to_label_area_edge / em)
     + w_ambiguity · ambiguity_k
     + w_stability · (min(1, d/em) + min(1, max(0, d/em − 1) / 4))
```

* Coverage costs count the covered amount in units of the item's font size: covered px²
  / em² for labels, covered length / em for leaders — what a label hides, whatever its
  size (a thin line across a long label costs as much as across a short one), and what a
  leader runs over, whatever its length. A weight `w` is thus the cost of hiding one em²
  of a class (`w_leader` = 1 costs as much as hiding 1 em² of weight 1). The same holds
  for `canvas_edge` (the label area outside the canvas), soft `items` (and soft
  `lower_items` for the marks of less important items, §4.4) and the relaxed
  costs of `soft_overlap`. Internal labels of point items cover only their own mark,
  which hides what lies under it: they have no soft class costs (hard classes still
  apply).
* `ring_k` = the label box grown by `buffer`, minus the label box.
* `D(label_k)` (ADR 0037): how much the backdrop luma `s` (§4.6) varies under the label
  box, `D = I₂ − I₁ · I₁ / A`, with `I₁` and `I₂` the exact integrals of `s` and `s²` over
  the box on the backdrop grid (as covered areas, §4.1, in backdrop cells) and `A` the
  area of the box inside that grid in backdrop cells (the box corners in cell units,
  clamped to the grid: `(u1 − u0) · (v1 − v0)`); `D = 0` when `A ≤ 0`, when
  `D ≤ 10⁻¹² · I₂` and without a backdrop. `4 · D · C² / 65025` is four times the
  integral of `(Y − Ȳ)²` over the box in px², `Y` the luma in `[0, 1]`: a label half on
  black and half on white costs `w_contrast` per em² of its box, a label on any uniform
  backdrop nothing. Internal labels of point items, which lie on their mark, have none.
* `d` = the distance between the centers of the label box and the item's warm-start box
  (§6.7): 1 per em up to 1 em, then 1/4 per em up to 5 em, so that a label that has to
  move prefers a near place (ADR 0027); 0 without a warm-start box.
* `covered_len` of a leader: the segment is sampled every `c/2` px; each sample adds the
  class coverage of its cell × the sample spacing.
* `ambiguity_k = clamp((d_own − d_other) / em + 0.5, 0, 1)` when another item's shape is
  closer to the label box (signed distance) than `d_own + 0.5 em`, else 0. For leaders
  the port is used instead of the box. A label with a stub (§6.9) has none: the stub says
  whose it is; its stub costs `w_leader_length · len / em` instead of the `[leader]`
  terms `w_leader`, `w_leader_length · len/em` and `w_bends · bends`, and the label keeps
  its `w_distance` term.
* Dynamic terms (other labels and leaders, only for soft settings) are added the same way
  using exact intersection areas/lengths: overlap area / em², a leader's length inside
  another label / em, a placed leader's stroke area inside the label / em² (em of the
  candidate's item).
* `lookahead_k = w_lookahead · Σ_j fraction of j's live candidates killed by k +
  w_starve · #{j : all live candidates of j killed}` over unplaced items `j` of the same
  or lower key (greedy only).

---

## 9. Priority and omission

See §4.4 of the brief, made precise here.

### 9.1 Key

`key(i) = (required, tier, reserved, band(score))`, compared lexicographically, higher
wins; the **total order** additionally sorts by `score` and then by the tie rule
(`input_order`: lower index first; `id`: code-point order; `anchor_x`: smaller x first,
then index; `random`/`random(n)`: a PCG32 permutation with seed `n` or `solver.seed`).
`rank` = position in the total order (0 = highest).

* `tier`: `item.tier`, else the first matching `priority.tiers` rule, else 0 (a higher
  tier outranks a lower one).
* `score`: `item.priority` if given, else Σ `weight · normalized(term)`, else 0.
* Built-in terms (raw values; larger = more important before `weight`):

  | term | raw value of item `i` |
  |---|---|
  | `input_order` | `n − i` (earlier items larger) |
  | `label_size` | area of the item's first label variant in em² (use a negative weight to prefer short labels) |
  | `mark_size` | area of the item's mark shape in px² |
  | `centrality` | −distance from the anchor to `priority.focus` (default: the canvas center, else the extent center) |
  | `degree` | numeric `attrs.degree` if present, else the number of `obstacles.vector` polyline endpoints within 0.5 px of the mark (incident edges) |
  | `outlierness` | gap to the `k`-th nearest neighbour (default `k` = 5): `max(0, d − r_j − r_i)` over the other item marks and the discs of the `points` class, with `d` the center distance and `r` the circle radius or the area-equivalent radius `sqrt(area/π)`; with fewer than `k` neighbours the largest gap found (or the extent size) |
  | `isolation` | the same gap with `k` = 1 |
  | `crowding` | −`isolation` |

* Terms: raw value → `transform` (`log1p`, `sqrt`, `neg`, `abs`) → normalization over all
  items: `rank` (average rank of equal values, scaled to [0,1]; 1 = largest),
  `minmax` ((v − min)/(max − min), 0 when max = min), `none`. Missing values → 0 after
  normalization (and are excluded from min/max/rank). An `attr` term whose attribute no
  item has in its `attrs` produces a validation **warning** `unknown_attr`.
* `band(score)`: with `priority.band = b > 0`, sorted scores are cut into bands whenever
  a score is more than `b` below the first score of the current band; with `b = 0`
  bands are exact score ties.
* Coverage: with `priority.coverage = {by, min_per_group: n}`, the top-n items (in total
  order) of every group get `reserved = true`.
* `keep_with` sets are handled as one unit with the maximum key of their members.

### 9.2 Omission modes

* `strict`: for every omitted `h`, `h` has no feasible candidate (over all ladder levels
  it may use) given only the placed items whose key ≥ key(h) (with a soft or ignored
  `avoid.label.lower_items`, a placed label of higher key covering the mark of `h`
  leaves `h` no candidate, §4.4). `stats.priority_inversions`
  counts violations of this (verified after solving by the same removal test) and MUST
  be 0.
* `prefix`: the placed set is a prefix of the total order. Items after the first omitted
  item are omitted with reason `omitted_by_priority`.
* `weighted`: maximize Σ max(score, 0) + ε per tier, tiers strict. Inversions are
  reported, not forbidden.

`max_labels` caps the placed set by total order.

### 9.3 Explanations

Unplaced items report `reason`: `no_feasible_candidate` (every candidate violates a
static hard constraint), `omitted_by_priority` (blocked only by placed labels/leaders of
higher or equal key, or cut by `prefix`/`max_labels`), `budget_exhausted` (not reached
before a cancellation, or past the time guard without a free level-0 candidate: its ladder
did not run, §10.1), `keep_with` (a member of its set failed), `grouped` (merged into a
group label). `blocking` lists the hard classes that rejected candidates (most frequent
first); `blocked_by` lists the placed items whose label or leader conflicts with the
item's best feasible candidates (the 5 cheapest statically feasible ones). Candidates
dropped while they were generated because placed labels blocked them (§6.7) count: when
no kept candidate of an omitted item is statically feasible, its dropped candidates are
generated again without the placed labels — the distant candidates and the models added
by ladder steps of its level-0 variants, then all candidates of its ladder variants, in
generation order — and evaluated until 5 statically feasible ones are found; with one,
the reason is `omitted_by_priority` and those candidates stand for the best feasible
ones. `stats.omission_order` lists omitted ids from the lowest
total-order position upward.

---


### 9.4 Font classes

`priority.font_classes` sets the type size by importance: a list of classes
`{first, scale, weight}` that take consecutive stretches of the total order (§9.1), the
most important labels first.

* With `n` items, class `k` ends at `e_k = max(e_{k−1}, min(n, end_k))` (`e_{−1} = 0`):
  `end_k` is `first` when it is a number of items, `ceil(p/100 · n − 10⁻⁹)` (at least 0)
  when it is a share `"p%"`, and `n` without `first`. The class takes the items with
  `e_{k−1} ≤ rank < e_k`; items after the last class keep their size. A group label
  (§5.7) takes the class of the best rank among its members.
* `scale` (default 1) multiplies the font size of the item and of every text of its label
  (each text part of a composite label), host-measured text sizes (`width`, `height`) and
  wrap widths (`max_width`, so that lines break as at the nominal size); `weight`, when
  given, replaces their font weight. Lengths given in em are resolved against the scaled
  font size (offsets, padding, distances, leader lengths and clearances, the gap of a
  composite label); lengths in px, icons and boxes keep their size.
* The priorities are those of the nominal sizes (the `label_size` term measures the label
  before its class applies). The labels are then measured again, and everything after
  (grid cell, candidates, the ladder) uses the scaled sizes. The `shrink` steps start from
  the class size but never go below `degrade_options.min_scale` of the size before a
  smaller class: with class scale `c < 1`, the factors `f, f², …` stop at
  `min_scale / c`.
* `placements[].priority.font_class` reports the class index; `text.font_size` and
  `text.font_weight` the size and weight drawn.

## 10. Solver

### 10.1 Greedy with ladder

Items are processed band by band in key order. Within a band, the next item is the one
with the fewest live (feasible, unconflicted) level-0 candidates, ties by total order
(most-constrained first). It takes its live candidate of minimal
`static + dynamic + lookahead` cost, the lookahead evaluated for the 8 cheapest by
`static + dynamic` cost, in that order, until one of them costs more by itself than the
best total so far (the lookahead is never negative, so it cannot win; ties by candidate
id). After a
band's level-0 pass, every unplaced item of the band runs the degradation ladder in
total order: for each step, candidates of that level are generated and the cheapest live
one is taken. `evict_lower` removes placed labels of strictly lower key that conflict
with the item's best candidate (fewest evictions, then cost) and re-queues them.
`soft_overlap` turns hard settings of `avoid.relaxable` classes into
`degrade_options.soft_overlap_weight`. `omit` gives up. Required items are a band of
their own above everything and therefore run first.

Time guard (ADR 0007, 0042, 0048): with a clock, the pass stops running bands and ladders
10 × `time_budget_ms` after it began (checked before every band and every 64 items).
The items still undecided then — except `keep_with` members and items whose level-0
attempt already failed — are visited once more in total order and take their best free
level-0 candidate as in a band's level-0 pass, without the ladder, until another
10 × `time_budget_ms` have passed (checked every 64 items); with `prefix` omission the
first of them without a free level-0 candidate ends the prefix. Every item left
undecided is `budget_exhausted`. Without a clock the guard never passes.

Warm starts (`warm_start`, with `weights.stability` > 0; ADR 0016, ADR 0025):

* Before a band's level-0 pass, its items (except `keep_with` members) whose level-0
  warm-start candidate (§6.7) is live take it, in total order. Then the others, in total
  order, take their free nudge (§6.7) of the smallest step, of the two directions the
  cheaper one (static plus dynamic cost), when there is one.
* An item whose level-0 attempt failed and whose warm box has the size of no level-0
  variant (the previous solve degraded the label) first tries that box: the ladder's
  steps run in order, as the ladder runs them (`evict_lower` and `soft_overlap` skipped;
  up to `omit`), until one creates a variant of the box's size; the box becomes a
  candidate of that variant and level as for level 0 (§6.7). When it is statically
  feasible and free, the item takes it; otherwise the ladder runs as usual. The steps
  run only once per item (the ladder reuses their candidates).

### 10.2 Local search

Moves: relocate one item; swap (relocate an item into a position that conflicts with one
other item which is relocated in turn); insert an unplaced item by an ejection chain of
depth ≤ 3; switch a label variant. Acceptance: hard feasibility is invariant; the
priority objective (strict: placed key multiset, lexicographic; prefix: prefix length;
weighted: tier-wise weight sums) must not get worse; cost changes are accepted by the
Metropolis rule `u < exp(−Δ/T)` with a geometric schedule from `T₀` to `T₀/1000` over the
iteration budget. `T₀` is the median increase of the static cost over 50 random
relocation probes, of those that increase it (0.1 when none does). `Δ` is the change of
the moved labels' own costs (static plus dynamic against the other labels); what a move
changes in the dynamic costs of the other labels is not part of it. The search keeps the
best state since the last insertion by the running sum of the `Δ`s and returns to it at
the end when the walk ended above it and its total cost, computed afresh, is lower than
the walk's. The iteration budget is
`min(max_iterations, time_budget_ms × rate, 400 × n_items)`, `rate` = 100 (Rust) or 40 (TS).

### 10.3 Uncross repair and verification

After search: fan labels (§6.8); the boundary labels of each side are re-stacked jointly
(§6.6) when that keeps them feasible and lowers their cost, and the sides' columns take in
items without a label (§6.6, filling); any two crossing leaders (only
possible when `avoid.leader.leaders` is soft) are uncrossed by exchanging label positions when that shortens the total leader
length. With `strict` omission, the **priority repair** then visits the omitted items in
total order (except `keep_with` members and items cut by the time guard): an item with a
usable candidate (statically feasible, or relaxed with `soft_overlap` in the ladder) that
conflicts with no placed label, or only with labels of strictly lower key (not required),
takes the candidate with the fewest such labels (then the smallest sum of their gains,
then the lowest cost, then the lowest candidate id) within the label budgets, and those
labels are removed and visited in their turn. An item without such a candidate may
**move one label aside** (ADR 0049): of its usable candidates (fan and boundary ones
excepted), cheapest first (relaxed ones at their relaxed cost, ties by id), the first 8
whose conflicts are one label `b` of a key not strictly lower than its own (or required,
not a fan or boundary label) and at most one removable label are tried; `b` moves to one
of the 16 cheapest of its usable candidates (fan and boundary ones excepted) and of its
level-0 candidates that the pruning of §6.7 dropped (generated again, without distant
ones, after all others on ties) that conflicts with neither the item's candidate nor a
placed label but removable ones; at most one label is removed in all, within the label
budgets. The choice: fewest removed, then the smallest gain removed, then the smallest
cost change (the item's candidate plus `b`'s new cost minus its old), the first found on
ties; the removed label is visited in its turn. When a label was moved aside, the pass
runs once more without such moves; in it, an item that gets no candidate by the first
rule tries its level-0 candidates that the pruning dropped by that rule too (fan and
boundary ones excepted, the first found on ties) when its mark (and area), inflated by
`placement.offset`, the largest width or height of its level-0 variants and the largest
label margin, touches the old place (box and leaders) of a moved label. The search keeps
the priority objective, but a move can free a position that a lower label then takes;
after the repair the removal test of §9.2 finds no inversion. Then all hard constraints are re-verified
exactly. A violation found here is a
bug; the offending lower-key label is removed and the item reported as omitted.

### 10.3a Cancellation and progress

Hosts may cancel a solve (a cancellation token, an `AbortSignal`). The solver polls the
request at every priority band and every 64 items of the greedy pass, every 256
local-search moves and every 4,096 exact-search nodes. Once cancelled it stops improving:
the greedy pass places no further items (they are reported as `budget_exhausted`), the
searches keep their best state, and repair and verification still run, so the result
is valid; `stats.cancelled` is `true`. Progress is reported per greedy band and every
256 local-search moves as `(phase, fraction)`.

### 10.4 Determinism

* No iteration over hash containers in decisions; stable sorts with total comparators.
* Float math only uses IEEE-754 `+ − × ÷ sqrt` (correctly rounded), exact operations
  (comparisons, negation, `abs`, `%` = fmod, scaling by powers of two) and the shared
  `det_math` functions. Platform math (`Math.sin`, `Math.round`, libm `exp`, `hypot`, …)
  MUST NOT be used. `det_math` is implemented with the same operation sequence in every
  implementation (Rust `la_expr::det_math`, TypeScript `detmath.ts`), so its results are
  *identical*; `conformance/math/` checks them bit for bit:

  | function | definition, special cases |
  |---|---|
  | `ln(x)` | natural logarithm; `ln(±0) = −∞`, `ln(x < 0) = NaN`, `ln(+∞) = +∞` |
  | `ln_1p(x)` | `ln(1 + x)`; `ln_1p(−1) = −∞`, `ln_1p(x < −1) = NaN`, `ln_1p(±0) = ±0` |
  | `exp(x)` | `eˣ`; overflow → `+∞`, underflow → `+0` (gradual underflow) |
  | `pow(x, y)` | special cases of C99 Annex F (`pow(x, ±0) = 1`, `pow(1, y) = 1` even for NaN, `pow(−1, ±∞) = 1`, signed zeros and infinities, finite `x < 0` with non-integer `y` → NaN); integer `y` with `\|y\| ≤ 2³⁰` by repeated squaring, otherwise `exp(y · ln\|x\|)` (sign from the parity of `y`), both in double-double precision |
  | `sin_cos_deg(d)` | `(sin d°, cos d°)`: `d % 360` exactly, reduced to `[−45°, 45°]` in degrees, then converted to radians with the double-double constant π/180; exact at multiples of 30° and 45° (`sin 45° = cos 45° = sqrt(0.5)`, `sin 30° = 0.5`, `cos 30° = sqrt(0.75)`); `cos` is never `−0`; `sin(±0) = ±0`, `sin(k·180°) = +0` for `k > 0` and `−0` for `k < 0`; non-finite `d` → NaN |
  | `atan2_deg(y, x)` | angle of `(x, y)` in degrees in `[−180, 180]` with the special cases of C99 `atan2` (signed zeros, infinities); exact on the axes and for `\|x\| = \|y\|` (±45°, ±135°) |
  | `cbrt(x)` | real cube root (odd function) |
  | `floor`, `ceil`, `trunc` | exact (C semantics incl. signed zeros) |
  | `round_half_away(x)` | nearest integer, halves away from zero (C `round`); **not** JS `Math.round` and not `floor(x + 0.5)` (wrong for 0.49999999999999994) |

  NaN results are the canonical quiet NaN (a conformance check accepts any NaN). Not
  normative but measured (`conformance/math/README.md`): the error is below 0.55 ulp for
  every function (subnormal results: one more ulp), and `det_math` agrees with glibc and
  V8 within 2 ulp.
* Random numbers: PCG32 (PCG-XSH-RR 64/32), `step()`: `state = state ·
  6364136223846793005 + 1442695040888963407 (mod 2⁶⁴)`:
  * seeding with a 64-bit `seed`: `state = 0; step(); state += seed; step()`;
  * `next_u32()`: `old = state; step(); x = u32(((old >> 18) ^ old) >> 27); rot = old >> 59;`
    result `x` rotated right by `rot`;
  * floats: `next_f64() = next_u32() / 2³²` in `[0, 1)`;
  * bounded integers: `next_below(n) = (next_u32() · n) >> 32` for `n < 2³²`, exact in 64
    bits (`= floor(u32 · n / 2³²)`); `next_below(0) = 0`; every call consumes one output;
  * `shuffle(a)`: Fisher–Yates from the end — for `i = len−1` down to `1`, swap `a[i]`
    and `a[next_below(i + 1)]`. A *PCG32 permutation* of `n` items (§9.1 `random` ties)
    is `shuffle([0, 1, …, n−1])` on a fresh generator; its `k`-th element is the input
    index of the item at position `k`.

  TypeScript emulates the 64-bit state without `BigInt` (32-bit halves, 16-bit limbs for
  the products). Vectors: `conformance/math/pcg32.json`.

---

## 11. Result

See `schema/result.v1.json`. Placements are reported in input order. `cost` is the final
total cost of the label (static + dynamic). `stats.hard_violations` and
`stats.leader_crossings` are computed by the independent verification pass. A placed
label reports `anchor`, its item's reference point in canvas px (point items: the
anchor; area items: the pole of their polygon, §6.5), so that a result passed as
`warm_start` moves with the anchors (§6.7).
