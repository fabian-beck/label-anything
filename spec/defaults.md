# Defaults

This table is **data**. `tools/codegen.mjs` parses the rows between the
`defaults:begin` and `defaults:end` markers and generates the constants used by the
Rust (`rust/crates/la-core/src/generated/spec_data.rs`) and TypeScript
(`ts/packages/core/src/generated/spec-data.ts`) implementations. Never copy a value by
hand: edit this table and run `node tools/codegen.mjs`. CI fails if the generated files
are stale.

* **Key** is a dotted path into the problem. `obstacles.raster.*`, `obstacles.svg.*` and
  `obstacles.vector.*` are defaults for every source/layer object.
* **Default** is a JSON literal. Lengths may carry units (`em` = the label's font size).
  An object default for a map (`avoid.label`, ...) is merged key by key with the user's
  map; the key `"*"` is the weight of classes the map does not list.
* Merge order: this table ← preset (`spec/presets/<name>.json`) ← the problem. Objects
  merge recursively, arrays and scalars replace.

<!-- defaults:begin -->
| Key | Default | Rule | Description |
|---|---|---|---|
| `canvas.padding` | `4` | length ≥ 0 | Keep labels this far inside the canvas (or `canvas.region`). |
| `canvas.allow_outside` | `false` | bool | Allow labels outside the canvas; disables the `canvas_edge` class. |
| `canvas.device_pixel_ratio` | `1` | > 0 | Informational. Raster resolution is set per source with `obstacles.raster.scale`. |
| `canvas.region` | `null` | rect or null | Sub-rectangle labels must stay inside; leaders may leave it. |
| `canvas.background` | `"#ffffff"` | #rrggbb | Colour of the canvas where no raster lies: the backdrop of labels there (`contrast` cost term). |
| `y_axis` | `"down"` | down \| up | `up` flips input y: y_px = canvas.height − y (after `transform`). |
| `transform` | `null` | 6 numbers or null | Affine data→pixel map `[a,b,c,d,e,f]`. |
| `preset` | `"auto"` | enum | Bundle of defaults, see `spec/presets/`. |
| `defaults.font.family` | `"default"` | string | `default` = bundled Noto Sans (Latin/Greek/Cyrillic). |
| `defaults.font.size` | `12` | > 0 | Font size in px. |
| `defaults.font.weight` | `400` | 1–1000 | Nearest available weight is used (bundled: 400, 700). |
| `defaults.font.style` | `"normal"` | normal \| italic | Bundled font has no italic; italic falls back to upright. |
| `defaults.font.line_height` | `1.2` | > 0 | Line pitch in em for wrapped text. |
| `defaults.padding` | `"0.15em"` | length ≥ 0 | Label box inflation (part of the reported box). |
| `defaults.buffer` | `"0.3em"` | length ≥ 0 | Soft ambiguity buffer ring around each label (Mumtaz et al. 2019). |
| `defaults.margin` | `"0.2em"` | length ≥ 0 | Space a label keeps from other items' marks while `avoid.label.items` is hard (spec §4.4): not from its own mark (`placement.offset`), never more than another mark keeps from the own mark's box, half for warm-start candidates; also the least space from other labels. |
| `defaults.spacing` | `null` | length ≥ 0 or null | Space a label keeps from other labels and their stubs while `avoid.label.labels` is hard (the larger of the two labels' spacings, each at least its margin; spec §4.4); `null`: twice the margin (0.4 em), so that with the padding their letters stand farther apart than the lines of one label. Half for warm-start candidates. |
| `defaults.mark` | `{"shape":"circle","r":2}` | mark | Mark of point anchors without `anchor.mark`. |
| `defaults.wrap` | `null` | wrap or null | No wrap settings: single line; the `wrap` ladder step may still try 2–3 lines. |
| `defaults.truncate` | `"none"` | none \| end \| middle | Truncation when wrapped text exceeds `max_lines`. |
| `text.shaping` | `"auto"` | auto \| simple \| full | `simple` is identical in every implementation. |
| `placement.models` | `["adjacent","slider","distant"]` | list | Candidate models. Preset `auto` adds `distant` only when crowded. |
| `placement.position_order` | `"perceptual"` | enum or list | perceptual = top, right, bottom, left, top-right, bottom-right, top-left, bottom-left. A list also keeps distant labels on its sides (spec §6.4). |
| `placement.offset` | `1` | length ≥ 0 | Gap between the (inflated) mark and an adjacent label. |
| `placement.max_distance` | `"8em"` | length ≥ 0 | Largest anchor–label distance of distant labels. |
| `placement.min_distance` | `"1.5em"` | length ≥ 0 | Innermost ring of distant candidates. |
| `placement.slider_per_quadrant` | `4` | int ≥ 0 | Slider samples between two fixed positions. |
| `placement.k_distant` | `24` | int ≥ 0 | Distant candidates kept per item variant (lowest static cost). |
| `placement.distant_rings` | `4` | int ≥ 1 | Rings between `min_distance` and `max_distance`. |
| `placement.distant_directions` | `16` | int ≥ 4 | Directions per ring for `straight` leaders. |
| `placement.free_space_seeds` | `true` | bool | Add distant candidates at distance-transform maxima. |
| `placement.internal` | `"auto"` | auto \| prefer \| allow \| never | auto = prefer for rect/ellipse/polygon/path marks and areas, allow for circles. |
| `placement.inner_padding` | `"0.2em"` | length ≥ 0 | Clearance of internal labels from the shape boundary. |
| `placement.internal_circle_ratio` | `1.5` | ≥ 0 | Circles get internal candidates when r ≥ ratio × label height. |
| `placement.prune_factor` | `4` | ≥ 1 | Drop candidates whose static cost exceeds factor × the item's best (+ 1). |
| `placement.boundary.sides` | `["right","left"]` | list | Canvas sides used by the boundary model. |
| `placement.boundary.align` | `"stack"` | stack \| spread | stack: as close to the anchors as possible; spread: evenly distributed. |
| `placement.boundary.gap` | `2` | length ≥ 0 | Gap between stacked boundary labels. |
| `placement.boundary.margin` | `4` | length ≥ 0 | Distance of boundary labels from the canvas (region) edge. |
| `placement.fan` | `"auto"` | auto \| always \| off | Fan labels (spec §6.8): a crowd's labels stacked in a column beside it with fanning leaders. `auto`: crowds of items left without a label, when that places more labels; `always`: every crowd of two or more items. |
| `placement.own_nearest` | `true` | bool | A label without a distant leader comes no closer to another item's mark than to its own, and without a stub it is nearer to its own by its margin (at most by the distance between the two marks; marks it may not cover; spec §4.4). |
| `placement.stubs` | `"off"` | off \| auto | Stubs (spec §6.9): with `auto`, a label next to its mark that another item's mark comes within `stub_reach` of stands `stub_length` farther out, joined to its mark by a short leader at a right angle to its side (`leader.stub`; in the middle of a left or right side), where that is feasible; such a crowded label without a stub costs as much as a leader (`w_leader`). |
| `placement.stub_length` | `"0.5em"` | length ≥ 0 | How much farther out a label with a stub stands than an adjacent one. |
| `placement.stub_reach` | `"0.75em"` | length ≥ 0 | A label is ambiguous where another item's mark comes closer than this to its adjacent box. |
| `leaders.style` | `"straight"` | enum | straight \| angles \| orthogonal \| elbow \| curved. |
| `leaders.angles` | `[0,45,90,135,180,225,270,315]` | list of degrees | 0 = right, 90 = up. Used by `angles` and the first segment of `elbow`. |
| `leaders.port` | `"nearest"` | nearest \| side-center \| baseline | Where the leader meets the label. |
| `leaders.attach` | `"auto"` | auto \| boundary \| center \| tip | auto = boundary, tip for icon marks. |
| `leaders.min_length` | `6` | length ≥ 0 | Shorter leaders are not drawn (label counts as adjacent). |
| `leaders.max_length` | `"10em"` | length ≥ 0 | Longest leader. |
| `leaders.anchor_gap` | `1.5` | length ≥ 0 | Leaders stop this far from the mark boundary. |
| `leaders.clearance` | `"0.4em"` | length ≥ 0 | Distance leaders keep from other items' marks and from other leaders (spec §7). |
| `leaders.min_angle_between` | `10` | 0–90 degrees | Distant leaders starting within 1 em of each other must diverge at least this much. |
| `leaders.width` | `1` | ≥ 0 | Leader stroke width for collision tests. |
| `avoid.label` | `{"labels":"hard","items":"hard","text":"hard","canvas_edge":"hard","own_mark":"hard","ink":0.1,"*":1.0}` | map | Label box vs. classes. Key `own_mark`: the own-mark policy; key `lower_items`: the policy for the marks of items of lower priority key (default: that of `items`; when given and not hard, a label covering such a mark excludes that item's label; spec §4.4). |
| `avoid.leader` | `{"leaders":"hard","labels":"hard","items":"hard","ink":0.05,"*":0.2}` | map | Leader vs. classes (`leaders` = crossings and approaches closer than `leaders.clearance`, `items` = other marks within `leaders.clearance`; key `lower_items`: the policy for the marks of items of lower priority key, default that of `items`). |
| `avoid.buffer` | `{"items":1.0,"leaders":0.5}` | map | Soft ambiguity buffer ring vs. classes. |
| `avoid.relaxable` | `["points","ink","lines"]` | list | Classes the `soft_overlap` step may relax from hard to soft. |
| `priority.terms` | `[]` | list | No terms: score = explicit `item.priority`, else 0 (ties by `priority.ties`). |
| `priority.tiers` | `[]` | list | Tier rules `{where, tier}`, first match wins. |
| `priority.omission` | `"strict"` | strict \| prefix \| weighted | Omission semantics (spec §4.4). |
| `priority.coverage` | `null` | object or null | Keep ≥ `min_per_group` labels per group of `by`. |
| `priority.coverage.min_per_group` | `1` | int ≥ 1 | Used when `priority.coverage` is given. |
| `priority.ties` | `"input_order"` | enum | Deterministic tie-breaker. |
| `priority.band` | `0` | ≥ 0 | Scores within `band` form one equal-key band (0 = exact ties only). |
| `priority.budget.max_labels` | `null` | int or null | Cap on placed labels, by priority order. |
| `priority.budget.max_ink_fraction` | `null` | 0–1 or null | Cap on the canvas fraction covered by labels. |
| `priority.focus` | `null` | point or null | Focus point of the `centrality` term (default: canvas center). |
| `priority.font_classes` | `[]` | list | Font sizes by priority: classes `{first, scale, weight}` over the total order (spec §9.4). |
| `priority.term.k` | `5` | int ≥ 1 | Neighbour count of `outlierness`. |
| `priority.term.weight` | `1` | number | Term weight. |
| `priority.term.normalize` | `"rank"` | rank \| minmax \| none | Normalization of a term across items. |
| `priority.term.transform` | `"none"` | enum | Applied to raw values before normalization. |
| `solver.strategy` | `"auto"` | auto \| greedy \| local \| exact | auto = greedy + local search; exact when small and budget ≥ 500 ms. |
| `solver.time_budget_ms` | `{"rust":100,"ts":250}` | > 0 | Per implementation. Converted to a deterministic iteration budget. |
| `solver.max_iterations` | `200000` | int ≥ 0 | Cap on local-search iterations. |
| `solver.seed` | `0` | 0 – 2³²−1 | Seed of the PCG32 generator. |
| `solver.grid_cell` | `"auto"` | auto or > 0 | auto = clamp(min font size / 4, 1, 4) px. |
| `degrade` | `["alternatives","wrap","distant","evict_lower","shrink:0.85","soft_overlap","omit"]` | list | Degradation ladder (spec §10.1). No `boundary` step: margin labels need leaders across the picture; use the `boundary` model or step where they are intended. |
| `degrade_options.min_scale` | `0.7` | (0,1] | Smallest font scale of `shrink:f` steps (f, f², … ≥ min_scale), relative to the size before a smaller font class (spec §9.4). |
| `degrade_options.wrap_max_lines` | `3` | int ≥ 1 | Line limit of the `wrap` step for labels without wrap settings. |
| `degrade_options.soft_overlap_weight` | `10` | ≥ 0 | Weight replacing `hard` for relaxed classes. |
| `weights.position` | `0.6` | ≥ 0 | × position rank / number of positions. |
| `weights.distance` | `0.3` | ≥ 0 | × gap between label and own shape, in em. |
| `weights.leader` | `1.0` | ≥ 0 | Fixed cost of having a leader. |
| `weights.leader_length` | `0.25` | ≥ 0 | × leader length in em. |
| `weights.bends` | `0.3` | ≥ 0 | × number of leader bends. |
| `weights.shape` | `0.5` | ≥ 0 | × shape penalty (wrap, alternative, truncate, shrink, relaxed overlap). |
| `weights.edge` | `0.2` | ≥ 0 | × proximity to the canvas edge (1 at the edge, 0 at ≥ 1 em). |
| `weights.ambiguity` | `1.0` | ≥ 0 | Label closer to another item's shape than to its own. |
| `weights.lookahead` | `0.3` | ≥ 0 | × Σ fraction of other unplaced items' candidates invalidated. |
| `weights.starve` | `2.0` | ≥ 0 | × number of unplaced items whose last candidates would be invalidated. |
| `weights.contrast` | `0.5` | ≥ 0 | × 4 · lightness variance of the raster backdrop under the label box, per em² (spec §8): a label half on black, half on white costs the weight per em² of its box. |
| `weights.stability` | `1.0` | ≥ 0 | × displacement from `warm_start`: 1 per em up to 1 em, then 1/4 per em up to 5 em (at most 2 per label). |
| `obstacles.vector.r` | `2` | ≥ 0 | Radius of vector points. |
| `obstacles.vector.width` | `1` | ≥ 0 | Stroke width of vector polylines. |
| `obstacles.vector.fill_rule` | `"nonzero"` | nonzero \| evenodd | Fill rule of vector polygons. |
| `obstacles.svg.default_class` | `"ink"` | class or ignore | Class of drawn SVG elements no rule matches. |
| `obstacles.svg.auto_mark_items` | `false` | bool | Take item marks from SVG elements with the item's `svg_id`. |
| `obstacles.svg.tolerance` | `0.25` | > 0 | Curve flattening tolerance (px). |
| `obstacles.raster.mode` | `"ink"` | enum | ink \| alpha \| cost \| classmap \| saliency. |
| `obstacles.raster.class` | `"ink"` | class | Class produced by ink, alpha, cost and saliency modes. |
| `obstacles.raster.scale` | `1` | > 0 | Raster pixels per canvas pixel. |
| `obstacles.raster.offset` | `[0,0]` | point | Canvas position of the raster's top-left corner. |
| `obstacles.raster.ink.background` | `"auto"` | auto or #rrggbb | auto = most frequent border colour. |
| `obstacles.raster.ink.threshold` | `0.12` | ≥ 0 | OKLab distance above which a pixel is ink. |
| `obstacles.raster.ink.dilate` | `1` | int ≥ 0 | Dilation of the ink coverage, in grid cells. |
| `obstacles.raster.alpha.threshold` | `0.1` | 0–1 | Alpha above which a pixel is ink. |
| `obstacles.raster.cost.invert` | `false` | bool | false: dark = high cost. |
| `obstacles.raster.classmap_tolerance` | `0.08` | ≥ 0 | Max OKLab distance of a classmap match. |
| `obstacles.raster.unmatched` | `"ink"` | ink \| ignore | Class of non-background pixels no classmap colour matches. |
| `output.debug_svg` | `false` | bool | Emit the debug SVG overlay in `result.debug_svg`. |
| `output.cost_breakdown` | `false` | bool | Report per-term costs of placed labels. |
| `output.candidates` | `false` | bool | Report all candidates. |
| `output.item_shape` | `false` | bool | Echo resolved item geometry. |
<!-- defaults:end -->

## Notes

* **Time budget vs. determinism.** `solver.time_budget_ms` is converted into a fixed
  iteration budget (`budget_ms × 100` local-search moves in Rust, `budget_ms × 40` in
  TypeScript, both capped by `solver.max_iterations` and `400 × number of items`), so a
  solve is deterministic for a given input and seed on every machine. A wall-clock guard at 3 × the budget stops the
  search on pathologically slow machines and sets `stats.time_guard_hit`. See ADR 0007.
* **Hard vs. soft.** `"hard"` classes are filters: a candidate touching them is discarded.
  Numbers are soft weights per em² of covered area for labels (covered px² / em²) and per
  em of covered length for leaders (spec §8): a label hiding one em² of a class of weight
  1 costs as much as having a leader (`weights.leader`).
  `"ignore"` means no interaction.
* **Reserved classes:** `items` (all anchored marks), `labels` (placed labels), `leaders`
  (placed leaders), `canvas_edge`, `ink`, `text`. Everything else is a free string.
