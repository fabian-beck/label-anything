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

Pipeline: `validate → normalize → prepare obstacles → measure & build label variants →
candidates → greedy (+ ladder) → local search → (exact) → uncross repair → verify →
finalize`.

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
| `em` | the font size (px) of the label the length is resolved for |

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

Every mark is an obstacle of the reserved class `items` (§4.4).

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

### 4.5 SVG backgrounds

The SVG viewport (`width`/`height`, else the `viewBox` size) is mapped onto the canvas
(non-uniform scale if the sizes differ; normally they are equal). `viewBox` is honored
with `preserveAspectRatio` (default `xMidYMid meet`). Elements are classified by the
first matching rule of `classes` (else the preset's `svg_classes`, else
`default_class`). Selector subset: type selectors, `*`, `.class`, `#id`, `[attr]`,
`[attr=value]` (quotes optional), descendant combinator (space), comma lists, and the
pseudo-classes `:small` (geometry bbox ≤ 16 px in both dimensions), `:background` (bbox
≥ 90 % of the canvas in both dimensions), `:filled` and `:unfilled`. Fills (fill ≠ none,
effective opacity > 0) become polygons, strokes become capsule polylines of the
transformed stroke width, text elements become their bounding rectangles. Elements with
`display:none`, `visibility:hidden`, zero opacity, inside `<defs>`, `<clipPath>`,
`<mask>`, `<marker>`, `<pattern>` or `<symbol>` (unless instantiated by `<use>`) are not
drawn. Curves are flattened with tolerance `tolerance` (0.25 px).

`auto_mark_items: true`: items with `svg_id` take their mark geometry from that SVG
element (as `from_svg`), and that element is removed from its class.

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

### 4.7 Distance transform

The exact Euclidean distance transform (Felzenszwalb–Huttenlocher) of the union of all
**static hard** classes for labels (cells with coverage > 0, plus `canvas_edge` outside
the label area) is computed on the grid in cell units and stored in px. It drives
free-space seeds for distant candidates and early rejection.

---

## 5. Labels

### 5.1 Label kinds

* `text`: measured with the built-in shaper (§5.2) unless `width`/`height` are given.
* `icon`, `box`: fixed `width × height`; `shape` (`rect`, `rounded:r`, `circle`,
  `polygon` with `polygon` points) is used for exact collision tests.
* `composite`: parts laid out in a `row` (default) or `column` with `gap`, aligned
  `center` (default) across the main axis.

The **label box** is the content box grown by `padding` on every side. It is the
collision box and the reported `box`. Text is drawn at `x_offset = padding` and the
reported baselines.

### 5.2 Text measurement

Fonts: the bundled Noto Sans subset (Regular 400, Bold 700) or fonts supplied in
`font.file` / registered through the API, keyed by family and weight (nearest weight).

**Simple shaping** (identical in all implementations, ±0.01 px tested; in practice
bit-identical): map code points through `cmap` (formats 4 and 12; unmapped → glyph 0),
sum `hmtx` advances, add GPOS pair kerning: for every lookup index referenced by a `kern`
feature of any script's default or language system (union, ascending), if the lookup is
of type 2 (or type 9 extension to type 2), walk the glyph sequence pairwise (skipping
mark glyphs per GDEF class 3 when the lookup flag has IgnoreMarks) and apply the first
matching subtable (PairPos format 1 or 2); add `XAdvance` of the first value record (and
of the second, which also advances past the pair when ValueFormat2 ≠ 0). Without GPOS a
legacy `kern` format-0 table is used. Width = `(Σ advances + Σ adjustments) · size / unitsPerEm`
computed in that order (integers first, one multiplication and one division).

**Full shaping** (Rust: rustybuzz) is used when `text.shaping = "full"`, or `"auto"` and
the text contains code points from scripts that need it (Arabic, Hebrew, Indic, Thai, …).

**Vertical metrics:** ascent = `hhea.ascender`, descent = `−hhea.descender` (or the
OS/2 typo metrics when USE_TYPO_METRICS is set), scaled by `size/unitsPerEm`. A text
block of `n` lines has height `ascent + descent + (n−1)·line_height·size`; the baseline of
line `i` is at `padding + ascent + i·line_height·size` from the box top.

### 5.3 Line breaking, wrapping, truncation

Break opportunities (after position `k` = between char `k` and `k+1`):
after a space (the space is dropped at the end of a line and leading spaces of a line
are trimmed), after `/`, `.`, `_`, `-`, `,`, `;`, `:` (but `::` only after the second
colon), between a lowercase letter and an uppercase letter (camelCase), between a letter
and a digit run start, and between two CJK ideographs. Within a token wider than the
available width, any character boundary is allowed (emergency break).

`greedy(width W)`: fill lines left to right, breaking at the last opportunity that
keeps the line ≤ W.

`balanced(n)`: the smallest W (searched over the sorted set of distinct candidate line
widths) such that `greedy(W)` produces ≤ n lines; ties → fewer lines.

Variants of a text label (with wrap settings `max_width = M`, `max_lines = L`):
`L_min` = lines of `greedy(M)` (1 if no `M`). Normal variants: `balanced(n)` for
`n = L_min … min(L_min + 2, L)` (deduplicated; `wrap.balance: false` uses
`greedy(M)` only). If `L_min > L`, the text is truncated per `truncate`:
`end` keeps the first L lines of `greedy(M)` and shortens the last with `…`;
`middle` removes the fewest code points from the middle of the text (replaced by `…`)
such that `greedy(M)` fits in L lines; `none` lets lines exceed `M`.
Without wrap settings the normal variant is the single line; the `wrap` ladder step adds
`balanced(2)` and `balanced(3)` (up to `degrade_options.wrap_max_lines`).

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

### 6.5 Area anchors

Internal candidates at the polygon's pole of inaccessibility and at grid samples
(spacing = label height) inside the polygon where the label box (+ `inner_padding`) fits,
ordered by clearance. If none fit, the item falls back to a point-like item at the pole
with mark `anchor.dot` (default circle r = 2), with external candidates and leaders. Area
polygons are not obstacles of other labels.

### 6.6 Boundary

Slots in the margins along `placement.boundary.sides`, `margin` from the edge. Labels on
one side are stacked by 1-D isotonic packing around their anchors' coordinates (`stack`)
or evenly spread (`spread`); the assignment of items to slots minimizes total leader
length (min-cost bipartite matching), which is crossing-free for straight leaders.

### 6.7 Static cost and pruning

Static cost = every cost term of §8 that does not depend on other labels. Candidates
violating a static hard constraint are infeasible (kept only for explanations).
Candidates with static cost > `prune_factor × best + 1` of the same item and level are
dropped.

---

## 7. Leaders

* Start: on the item's true boundary toward the port, `anchor_gap` outside (or at the
  icon tip; `attach: center` uses the reference point).
* `straight`: one segment start → port.
* `angles`: as straight, but distant candidates are generated along the allowed rays,
  so the segment direction is one of `leaders.angles`.
* `orthogonal`: `po` (one bend: vertical then horizontal, or horizontal then vertical)
  or straight when aligned; `opo` (two bends) for boundary labels. Minimal bends first.
* `elbow`: a first segment at an allowed angle, then horizontal into the label's side
  center.
* `curved`: quadratic Bézier, flattened for collision tests (reported in `curve`).
* `port`: `nearest` = point of the label box closest to the leader's previous point;
  `side-center` = midpoint of the side facing the anchor; `baseline` = end of the
  underline below the first text line (the underline is part of the leader).
* Leaders never enter their own label except at the port, never pass through other
  labels (`avoid.leader.labels`, default hard), and never cross other leaders
  (`avoid.leader.leaders`, default hard). Leaders shorter than `min_length` are dropped
  (the label is then reported as adjacent) and longer than `max_length` are not
  generated.

---

## 8. Cost model

For candidate `k` of item `i` (all terms ≥ 0, summed in this order):

```
cost = Σ_class w_label[class] · covered(label_k, class) / area(label_k)
     + Σ_class w_buffer[class] · covered(ring_k, class) / area(ring_k)
     + [leader] (w_leader + w_leader_length · len/em + Σ_class w_leader[class] · covered_len/len + w_bends · bends)
     + w_position · rank / n_positions
     + w_distance · gap(label_k, S_i) / em
     + w_shape · shape_penalty(variant)
     + w_edge · max(0, 1 − dist_to_label_area_edge / em)
     + w_ambiguity · ambiguity_k
     + w_stability · min(1, displacement_from_warm_start / em)
```

* `ring_k` = the label box grown by `buffer`, minus the label box.
* `covered_len` of a leader: the segment is sampled every `c/2` px; each sample adds the
  class coverage of its cell × the sample spacing.
* `ambiguity_k = clamp((d_own − d_other) / em + 0.5, 0, 1)` when another item's shape is
  closer to the label box (signed distance) than `d_own + 0.5 em`, else 0. For leaders
  the port is used instead of the box.
* Dynamic terms (other labels and leaders, only for soft settings) are added the same way
  using exact intersection areas/lengths.
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

* `tier`: `item.tier`, else the first matching `priority.tiers` rule, else 0.
* `score`: `item.priority` if given, else Σ `weight · normalized(term)`, else 0.
* Terms: raw value → `transform` (`log1p`, `sqrt`, `neg`, `abs`) → normalization over all
  items: `rank` (average rank of equal values, scaled to [0,1]; 1 = largest),
  `minmax` ((v − min)/(max − min), 0 when max = min), `none`. Missing values → 0 after
  normalization (and are excluded from min/max/rank).
* `band(score)`: with `priority.band = b > 0`, sorted scores are cut into bands whenever
  a score is more than `b` below the first score of the current band; with `b = 0`
  bands are exact score ties.
* Coverage: with `priority.coverage = {by, min_per_group: n}`, the top-n items (in total
  order) of every group get `reserved = true`.
* `keep_with` sets are handled as one unit with the maximum key of their members.

### 9.2 Omission modes

* `strict`: for every omitted `h`, `h` has no feasible candidate (over all ladder levels
  it may use) given only the placed items whose key ≥ key(h). `stats.priority_inversions`
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
before the time guard), `keep_with` (a member of its set failed), `grouped` (merged into a
group label). `blocking` lists the hard classes that rejected candidates (most frequent
first); `blocked_by` lists the placed items whose label or leader conflicts with the
item's best feasible candidates. `stats.omission_order` lists omitted ids from the lowest
total-order position upward.

---

## 10. Solver

### 10.1 Greedy with ladder

Items are processed band by band in key order. Within a band, the next item is the one
with the fewest live (feasible, unconflicted) level-0 candidates, ties by total order
(most-constrained first). It takes its live candidate of minimal
`static + dynamic + lookahead` cost (lookahead evaluated for the 8 cheapest). After a
band's level-0 pass, every unplaced item of the band runs the degradation ladder in
total order: for each step, candidates of that level are generated and the cheapest live
one is taken. `evict_lower` removes placed labels of strictly lower key that conflict
with the item's best candidate (fewest evictions, then cost) and re-queues them.
`soft_overlap` turns hard settings of `avoid.relaxable` classes into
`degrade_options.soft_overlap_weight`. `omit` gives up. Required items are a band of
their own above everything and therefore run first.

### 10.2 Local search

Moves: relocate one item; swap (relocate an item into a position that conflicts with one
other item which is relocated in turn); insert an unplaced item by an ejection chain of
depth ≤ 3; switch a label variant. Acceptance: hard feasibility is invariant; the
priority objective (strict: placed key multiset, lexicographic; prefix: prefix length;
weighted: tier-wise weight sums) must not get worse; cost changes are accepted by the
Metropolis rule `u < exp(−Δ/T)` with a geometric schedule from `T₀` (median |Δ| of 50
probe moves) to `T₀/1000` over the iteration budget. The iteration budget is
`min(max_iterations, time_budget_ms × rate, 400 × n_items)`, `rate` = 100 (Rust) or 40 (TS).

### 10.3 Uncross repair and verification

After search: any two crossing leaders (only possible when `avoid.leader.leaders` is
soft) are uncrossed by exchanging label positions when that shortens the total leader
length; then all hard constraints are re-verified exactly. A violation found here is a
bug; the offending lower-key label is removed and the item reported as omitted.

### 10.4 Determinism

* No iteration over hash containers in decisions; stable sorts with total comparators.
* Float math only uses `+ − × ÷ sqrt` and the shared `det_math` functions
  (`sin`, `cos` of degrees, `exp`, `log`, `log1p`), implemented identically.
* Random numbers: PCG32 (XSH-RR, 64-bit state, multiplier 6364136223846793005, increment
  1442695040888963407, seeded with `state = 0; step; state += seed; step`), floats as
  `u32 / 2³²`, bounded integers as `floor(u32 · n / 2³²)`.

---

## 11. Result

See `schema/result.v1.json`. Placements are reported in input order. `cost` is the final
total cost of the label (static + dynamic). `stats.hard_violations` and
`stats.leader_crossings` are computed by the independent verification pass.
