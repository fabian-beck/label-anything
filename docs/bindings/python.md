# Python

`label-anything` is the Python binding of the Rust engine: a PyO3 extension module
(`label_anything._native`, abi3, one wheel for CPython ≥ 3.9) plus a typed pure-Python
API (`py.typed`). The plotting helpers for matplotlib, Plotly and seaborn are a separate
pure-Python distribution, `label-anything-extras`.

## Install

```sh
pip install label-anything                  # the engine and the API (no dependencies)
pip install "label-anything[matplotlib]"    # + label_anything.matplotlib (also: plotly, seaborn, all)
```

Not on PyPI yet; from source, at the repository root (Rust ≥ 1.88 and
[maturin](https://www.maturin.rs/)):

```sh
maturin build --release -m rust/crates/la-py/Cargo.toml   # wheel in rust/target/wheels/
pip install rust/target/wheels/label_anything-*.whl bindings/python-extras
```

## Three ways to describe a problem

### One call

Positional anchors and labels; every keyword maps 1:1 to a field of
`spec/schema/problem.v1.json` (see the table below). `None` always means "not set".

```python
import label_anything as la

res = la.place(
    anchors=outliers_px,                        # [(x, y), ...], an (N, 2) array, la.Area(...), anchor dicts
    labels=names,                               # str | la.Text | la.Icon | la.Box | la.Composite | dict
    canvas=(800, 600),
    font_size=11,
    background="scatter.png",                   # path | bytes | NumPy RGBA | SVG string | PIL image | None
    avoid={"ink": 0.5, "outliers": "hard"},     # label vs. class; or {"label": ..., "leader": ..., "buffer": ...}
    leaders="elbow",                            # or la.Leaders(style="angles", angles=range(0, 360, 45))
    preset="scatter",
    attrs={"cbo": cbo},                         # per item: list of dicts, dict of columns, DataFrame
    priority=la.Priority.outlierness(k=5)       # or a column name, a list of numbers, a callable(item)
             + 0.5 * la.Priority.attr("cbo", "log1p", normalize="minmax")
             - 0.2 * la.Priority.label_size(),
    omission="strict",                          # strict | prefix | weighted
    max_labels=None,
)
print(res.omission_order)                       # ids given up, lowest priority first
for p in res.placed:
    print(p.id, p.box, p.anchor_side, p.model, p.leader, p.lines)
res.to_svg("debug.svg")
```

Anchors are `(x, y)` pairs, an `(N, 2)` array or a two-column DataFrame (x and y as two
separate sequences: `zip(x, y)`). Per-item keywords take one entry per anchor: `ids`,
`attrs`, `marks` (mark dicts, see `la.Mark`, or radii), `required` (bools or a set of
ids), `groups`, `keep_with`, `svg_ids`, `item_placement`, and `priority` / `tiers` when
given as lists of numbers. Attribute values are numbers, strings, booleans, lists and
dicts; NumPy scalars become numbers, dates and times (`datetime`, pandas `Timestamp`,
`datetime64`) ISO 8601 strings, which compare chronologically in expressions
(`attrs.when >= "2024-01-15"`), and durations seconds; NaN, `NA` and `NaT` are dropped.

Priority terms are normalized over the items, by `rank` unless `normalize="minmax"` or
`"none"`. Under `rank` only the order of a term's values counts, so a transform such as
`log1p` changes the scores only with `minmax` or `none` (above: the coupling `cbo`,
log-scaled, weighs against outlierness and label size).

| keyword | schema field | keyword | schema field |
|---|---|---|---|
| `canvas=(w, h)` or dict | `canvas` | `canvas_padding`, `allow_outside`, `region`, `device_pixel_ratio`, `canvas_background` | `canvas.*` |
| `y_axis`, `transform`, `preset` | same | `font` (`la.Font`), `font_family`, `font_size`, `font_weight`, `font_style`, `line_height`, `font_file` | `defaults.font.*` |
| `padding`, `buffer`, `margin`, `mark`, `wrap`, `truncate` | `defaults.*` | `shaping` | `text.shaping` |
| `models`, `position_order`, `offset`, `min_distance`, `max_distance`, `slider_per_quadrant`, `k_distant`, `distant_rings`, `distant_directions`, `free_space_seeds`, `internal`, `inner_padding`, `internal_circle_ratio`, `prune_factor`, `boundary`, `fan`, `own_nearest`, `stubs`, `stub_length`, `stub_reach` | `placement.*` | `leaders` | `leaders` |
| `avoid`, `avoid_leader`, `avoid_buffer`, `relaxable` | `avoid.*` | `priority`, `tiers`, `omission`, `coverage`, `ties`, `band`, `focus`, `font_classes` | `priority.*` |
| `max_labels`, `max_ink_fraction` | `priority.budget.*` | `strategy`, `time_budget_ms`, `max_iterations`, `seed`, `grid_cell` | `solver.*` |
| `degrade` | `degrade` | `min_scale`, `wrap_max_lines`, `soft_overlap_weight` | `degrade_options.*` |
| `weights`, `warm_start` (a `Result` works) | same | `debug_svg`, `cost_breakdown`, `candidates`, `item_shape` | `output.*` |
| `vector=[{class, points, ...}]`, `obstacles` | `obstacles.*` | `defaults`, `text`, `placement`, `solver`, `degrade_options`, `output` | whole sections (deep-merged; specific keywords win) |

### Builder

```python
p = (la.Problem(canvas=(800, 600), preset="map", seed=3)
       .item((120, 80), "Bamberg", id="bamberg", attrs={"pop": 77}, mark=la.Mark.circle(3))
       .items(points, names, attrs=df)
       .background("map.svg", svg_classes={"#roads path": "lines", "text": "text"})
       .vector("rivers", polylines=[river], width=2)
       .avoid(lines=0.8, text="hard")
       .leaders("straight", max_length="6em")
       .priority(la.Priority.attr("pop"))
       .tier("attrs.capital == true", 1)
       .option("output.cost_breakdown", True))
problem = p.build()          # the problem dict (JSON-serializable)
res = p.solve()
```

The constructor and `set()` take the keywords of `la.place`; per-item `priority` /
`tiers` lists given before the items apply to them at `build()`.

`build(embed_background=True)` / `to_json()` embed a NumPy background as base64 so the
JSON is self-contained (e.g. for the CLI).

### Raw JSON

```python
res = la.place_problem(problem_dict)            # or JSON text, a path to a .json file, a Problem
report = la.validate(problem_dict)              # Report(valid, errors, warnings); never raises
svg = la.render_svg(problem_dict, res)
```

Invalid problems raise `la.ValidationError` (a `ValueError`); `e.errors` lists
`{"pointer", "code", "message"}` dicts, the pointers being RFC 6901 JSON Pointers
(`/items/3/anchor/y`). Warnings (`unknown_class`, ...) are in `res.warnings`.

## Results

`Result.placements` holds one frozen `Placement` per item in input order: `id`, `placed`,
`box` (`BBox(x, y, w, h)` in canvas px, y down), `anchor` (the item's point; passed back
as `warm_start`, the boxes move with it), `anchor_side`, `model`, `leader`
(`Leader(points, style, port, underline, curve, member, stub)`), `lines`, `baselines`,
`reason` (why it was omitted), `priority` (`{tier, score, rank}`), `degrade_steps`,
`blocking`, `blocked_by`, `members`/`leaders` (group labels), `parts` (composite labels)
and `raw`. `Result` also has `placed`, `unplaced`, `omission_order`, `stats`, `warnings`,
`raw`, `problem`, `res["id"]` and `res.get("id")` (ids are strings; other keys are looked
up as `str(key)`, as the API converts ids: `res[101]`, or `res[0]` for items without an
id), `to_dict()`, `to_json()` and `to_svg(path=None)` (the overlay rendered during the
solve when `debug_svg=True`, with cost-grid heatmaps).

## Callbacks

Callbacks are host extensions, not schema fields; they are passed to `place`,
`Problem.solve` or `place_problem`.

* `measure(text, font: la.FontSpec) -> la.TextMetrics | {width, ascent, descent} |
  (w, a, d) | None`: measure text with the host's engine (`font.size` in px; `None` uses
  the bundled font). `measure("", font)` asks for the vertical metrics: label boxes then
  span the ascent and descent it returns (with the bundled font's, they fit the ink of
  the text, spec §5.2). Results are
  cached per `(text, font)` during a solve. Wrapping then calls it for every distinct
  candidate line; without a callback the fonts measure candidate lines in constant time
  (ADR 0018).
* `cost(candidate: la.Candidate) -> float ≥ 0`: an extra cost term per candidate
  (`candidate.id`, `.box`, `.leader`), evaluated once per candidate.
* `progress(phase, fraction)`: `"greedy"`, `"local"`, `"exact"` as they start, then
  `("done", 1.0)`.
* `cancelled`: a `la.CancelToken` (polled without the GIL; `token.cancel()` from any
  thread), a callable returning `True`, a `threading.Event`, or an object with a
  `cancelled` attribute. A cancelled solve raises `la.Cancelled`.
* `priority=callable(item) -> score | (tier, score)`: evaluated once per item in Python
  before the solve; the values are written into the problem as explicit `priority` /
  `tier` (replacing `priority.terms`; tiers rules, `required` and ties still apply).

The solve runs with the GIL released; callbacks reacquire it. An exception raised in a
callback stops the solve (the clock jumps past the time budget, so the greedy pass and
local search end at their next check) and is re-raised to the caller with its
traceback. Ctrl-C is honoured the same way on the main thread.

## Backgrounds

`background=` (one or a list):

| input | becomes |
|---|---|
| `str` / `Path` of a PNG, JPEG or WebP file (extension or content) | `obstacles.raster.source` (absolute path) |
| `str` / `Path` of an SVG file | `obstacles.svg.path` |
| `bytes` of an encoded image | `obstacles.raster.source` as a `data:` URL |
| `bytes` / `str` of SVG markup | `obstacles.svg.source` |
| NumPy `uint8` `H×W×4`, `H×W×3`, `H×W` (floats in [0, 1] and bools are converted; floats outside [0, 1], such as 0–255 values, raise `ValueError`), PIL image | pixels handed to the engine directly (`raster_override`, one copy); the problem gets a placeholder `{"rgba": {"width", "height", "data": ""}}` carrying the options |

Options: `background_mode` (`ink`, `alpha`, `cost`, `classmap`, `saliency`),
`background_class`, `background_scale`, `background_offset`, `background_options`
(merged into the source, e.g. `{"ink": {"threshold": 0.2}}`), `svg_classes`
(`[{"selector", "class"}]`, `[(selector, class)]` or `{selector: class}`),
`svg_default_class`, `auto_mark_items`. Without `canvas`, the canvas is the raster size
divided by its scale, or the SVG viewport. `la.capabilities()` lists the raster formats
and whether the SVG backend is compiled in.

## Plotting helpers

```python
import matplotlib.pyplot as plt
from label_anything.matplotlib import label_points

fig, ax = plt.subplots()
ax.scatter(x, y, s=16)
out = label_points(ax, x, y, names, priority=la.Priority.outlierness(), max_labels=20)
out.result, out.texts, out.leaders          # the Result and the created artists
fig.savefig("plot.png")                      # any dpi: labels are in data coordinates
```

`label_points(ax, x, y, labels, **opts)` draws the figure, fixes the axes limits (the
layout is computed for this view), renders the figure **without its text artists** with
Agg as the background (an RGBA array of the axes region, ink background = axes
facecolor), adds the visible texts as hard `text` obstacles and legends as hard
`legend` obstacles, measures labels with the figure's own renderer, solves, and adds one
`Text` per label line plus `Line2D` leaders. `x` and `y` are in the units of the plotted
data: dates, categories and other matplotlib units are converted by the axes, and a
warning says when no point lies inside the axes. Options:

* `region="axes" | "figure"` (labels may use the figure margins);
* `background="raster" | "svg" | None`, or any `background=` input of `la.place`;
* `fontsize` (points or a size name), `fontfamily`, `fontweight`, `fontstyle`: the label
  font, measured with the figure's renderer (`measure=False`: the bundled font, or a
  `measure` callable);
* `marker_size` (points², like `scatter(s=)`; one number or one per point): the marks
  the labels keep clear of;
* `avoid_texts` (default `True`): the figure's visible texts are hard obstacles;
* `draw` (default `True`): add the artists, or only solve;
* `text_kw`, `leader_kw`: extra properties of the `Text` and `Line2D` artists. Font keys
  of `text_kw` (`fontsize`/`size`, `fontfamily`/`family`, `fontweight`/`weight`,
  `fontstyle`/`style`) act like the arguments above; keys that would change the drawn
  text after it was measured (`rotation`, `fontproperties`, `fontstretch`, `usetex`,
  alignment, `transform`, ...) raise `TypeError`;
* `preset` (default `"scatter"`);
* everything else goes to `la.place` (`priority`, `max_labels`, `avoid`, `leaders`,
  `degrade`, `ids`, `attrs`, ...).

Call `label_points` when the figure is final: its size and layout (`tight_layout`,
constrained layout), the axis scales and limits, colorbars and legends. The labels are
in data coordinates, so any savefig dpi works, but a later change of the axes' size or
scale moves the points under labels that keep their size, and labels then overlap
points and each other.

With a `priority` (or `tiers`), the helpers set `avoid` `lower_items` (10 for labels, 2.5
for leaders): an important label may cover the markers of less important points, which
then go unlabeled. Otherwise an important point in a crowd of minor ones could be left
without a label while minor points at the edge of the crowd keep theirs
([important labels over minor marks](../tutorials/priority.md#important-labels-over-minor-marks)).
Your own `avoid` wins; `avoid={"lower_items": "hard"}` keeps every marker clear.

`background="svg"` saves the figure as SVG (texts hidden) and classifies it with
`svg_classes()`: the figure and axes background patches are tagged with gids and
ignored (the axes patch covers less than 90 % of the figure, so the presets'
`:background` rule would class it `lines`), markers are `points`, strokes `lines`,
fills `ink`. Use the same rules when you pass a matplotlib SVG yourself:
`la.place(..., background=svg_text, svg_classes=svg_classes())` after setting
`fig.patch.set_gid("la-bg-figure")` and `ax.patch.set_gid("la-bg-axes-0")`.

`label_anything.plotly.label_points(fig, x, y, labels, **opts)` returns (and adds)
`annotations` centred on the label boxes and leader `shapes` (`type="path"`), computed
from the layout size, margins, axis domains and ranges; it fixes the figure size and the
axis ranges. Linear and log axes; other scatter traces on the axes are obstacles.
Options: `xref`/`yref` or `row`/`col`, `font_size` (px), `marker_size` (marker diameter
in px, one number or one per point), `avoid_traces`, `add`, `annotation_kw` (a `font`
there is merged into the measured one; a different `size` raises `TypeError`),
`line_kw`, `preset` (default `"scatter"`); everything else goes to `la.place`.

`label_anything.seaborn.label_points(ax, data=df, x="gdp", y="life", label="country",
attrs=["pop"], **opts)` resolves seaborn-style column names for axes-level plots;
`priority="pop"`, a column name, puts that column into the items' `attrs` by itself.

## Limitations

* The engine core does not poll `Env::cancelled()` yet: cancellation (and stopping
  after a callback exception) takes effect at the greedy pass's priority-band
  boundaries and every 256 local-search moves, through the clock.
* `memoryview` and other generic buffers cost one extra copy (the abi3 build for
  Python 3.9 cannot use the C buffer API, which joined the limited API in 3.11); NumPy
  arrays (array interface), `bytes` and `bytearray` are copied once.
* The Plotly helper measures text with the bundled font, not the browser's, and assumes
  the figure is shown at the fixed size it sets (legends that auto-expand the margins
  shift the plot area).
* The matplotlib helper draws text labels and the text parts of composites; icons and
  boxes are reported in the result for the caller to draw.
