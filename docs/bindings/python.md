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

From source (Rust ≥ 1.88 and [maturin](https://www.maturin.rs/)):

```sh
cd rust/crates/la-py && maturin build --release      # wheel in rust/target/wheels/
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
    priority=la.Priority.outlierness(k=5) + 0.5 * la.Priority.attr("cbo", "log1p")
             - 0.2 * la.Priority.label_size(), # or a column name, a list of numbers, a callable(item)
    omission="strict",                          # strict | prefix | weighted
    max_labels=None,
)
print(res.omission_order)                       # ids given up, lowest priority first
for p in res.placed:
    print(p.id, p.box, p.anchor_side, p.model, p.leader, p.lines)
res.to_svg("debug.svg")
```

Per-item keywords take one entry per anchor: `ids`, `attrs`, `marks` (mark dicts, see
`la.Mark`, or radii), `required` (bools or a set of ids), `groups`, `keep_with`,
`svg_ids`, `item_placement`, and `priority` / `tiers` when given as lists of numbers.

| keyword | schema field | keyword | schema field |
|---|---|---|---|
| `canvas=(w, h)` or dict | `canvas` | `canvas_padding`, `allow_outside`, `region`, `device_pixel_ratio` | `canvas.*` |
| `y_axis`, `transform`, `preset` | same | `font` (`la.Font`), `font_family`, `font_size`, `font_weight`, `font_style`, `line_height`, `font_file` | `defaults.font.*` |
| `padding`, `buffer`, `mark`, `wrap`, `truncate` | `defaults.*` | `shaping` | `text.shaping` |
| `models`, `position_order`, `offset`, `min_distance`, `max_distance`, `slider_per_quadrant`, `k_distant`, `distant_rings`, `distant_directions`, `free_space_seeds`, `internal`, `inner_padding`, `internal_circle_ratio`, `prune_factor`, `boundary` | `placement.*` | `leaders` | `leaders` |
| `avoid`, `avoid_leader`, `avoid_buffer`, `relaxable` | `avoid.*` | `priority`, `tiers`, `omission`, `coverage`, `ties`, `band`, `focus` | `priority.*` |
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
       .priority(la.Priority.attr("pop", "log1p"))
       .tier("attrs.capital == true", 1)
       .option("output.cost_breakdown", True))
problem = p.build()          # the problem dict (JSON-serializable)
res = p.solve()
```

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
`box` (`BBox(x, y, w, h)` in canvas px, y down), `anchor_side`, `model`, `leader`
(`Leader(points, style, port, underline, curve, member)`), `lines`, `baselines`,
`reason` (why it was omitted), `priority` (`{tier, score, rank}`), `degrade_steps`,
`blocking`, `blocked_by`, `members`/`leaders` (group labels), `parts` (composite labels)
and `raw`. `Result` also has `placed`, `unplaced`, `omission_order`, `stats`, `warnings`,
`raw`, `problem`, `res["id"]`, `to_dict()`, `to_json()` and `to_svg(path=None)` (the
overlay rendered during the solve when `debug_svg=True`, with cost-grid heatmaps).

## Callbacks

Callbacks are host extensions, not schema fields; they are passed to `place`,
`Problem.solve` or `place_problem`.

* `measure(text, font: la.FontSpec) -> la.TextMetrics | {width, ascent, descent} |
  (w, a, d) | None`: measure text with the host's engine (`font.size` in px; `None` uses
  the bundled font). `measure("", font)` asks for the vertical metrics. Results are
  cached per `(text, font)` during a solve.
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
| NumPy `uint8` `H×W×4`, `H×W×3`, `H×W` (floats in [0, 1] and bools are converted), PIL image | pixels handed to the engine directly (`raster_override`, one copy); the problem gets a placeholder `{"rgba": {"width", "height", "data": ""}}` carrying the options |

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
`Text` per label line plus `Line2D` leaders. Options: `region="axes" | "figure"`,
`background="raster" | "svg" | None`, `fontsize` (points), `fontfamily`, `fontweight`,
`marker_size` (points², like `scatter(s=)`), `measure`, `draw`, `text_kw`, `leader_kw`;
everything else goes to `la.place`.

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

`label_anything.seaborn.label_points(ax, data=df, x="gdp", y="life", label="country",
attrs=["pop"], **opts)` resolves seaborn-style column names for axes-level plots.

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
