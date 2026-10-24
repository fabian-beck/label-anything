# Python

`label-anything` is the Python binding of the Rust engine: one wheel (abi3) for CPython
≥ 3.9, typed, without dependencies. The plotting helpers for matplotlib, Plotly and
seaborn are the optional package `label-anything-extras`.

## Install

```sh
pip install label-anything                 # the engine
pip install "label-anything[matplotlib]"   # + label_anything.matplotlib (also: plotly, seaborn, all)
```

Neither is on PyPI yet. Until it is, build the wheel in a clone of the repository (Rust ≥
1.88 and [maturin](https://www.maturin.rs/)) and install it together with the helpers:

```sh
pip install maturin
maturin build --release -m rust/crates/la-py/Cargo.toml
pip install rust/target/wheels/label_anything-*.whl bindings/python-extras
pip install matplotlib plotly seaborn      # the plotting libraries you use
```

## One call

`la.place` takes the anchors and their labels, and every option as a keyword:

```python
--8<-- "examples/tutorials/python/basics.py:one-call"
```

Anchors are `(x, y)` pairs, an `(N, 2)` array or a two-column DataFrame; labels are
strings or `la.Text`, `la.Icon`, `la.Box` and `la.Composite` objects. Keywords with one
entry per anchor are `ids`, `attrs` (a list of dicts, a dict of columns or a DataFrame),
`marks`, `required`, `groups`, `keep_with`, `svg_ids`, `item_placement`, and `priority` or
`tiers` given as lists of numbers. Attribute values may be NumPy scalars, dates
(`datetime`, `Timestamp`, `datetime64`: ISO 8601 strings, which compare chronologically in
[expressions](../reference/expressions.md)) and durations (seconds); NaN, `NA` and `NaT`
are dropped.

Every other keyword sets a field of the [problem](../concepts/problem.md). `None` means
"not set": the [default](../reference/defaults.md) applies.

| Keywords | Problem field |
|---|---|
| `canvas=(w, h)` or a dict; `canvas_padding`, `allow_outside`, `region`, `device_pixel_ratio`, `canvas_background` | `canvas` |
| `y_axis`, `transform`, `preset`, `weights`, `degrade`, `warm_start` (a `Result` works) | the field of that name |
| `font` (`la.Font`), `font_family`, `font_size`, `font_weight`, `font_style`, `line_height`, `font_file` | `defaults.font` |
| `padding`, `buffer`, `margin`, `mark`, `wrap`, `truncate`; `shaping` | `defaults`; `text.shaping` |
| every field of `placement` (`models`, `position_order`, `offset`, `max_distance`, `internal`, `boundary`, `fan`, …) | `placement` |
| `leaders`: a style name or `la.Leaders(style="angles", angles=range(0, 360, 45))` | `leaders` |
| `avoid` (labels, or a dict with `label`, `leader`, `buffer`), `avoid_leader`, `avoid_buffer`, `relaxable` | `avoid` |
| `priority`, `tiers`, `omission`, `coverage`, `ties`, `band`, `focus`, `font_classes`; `max_labels`, `max_ink_fraction` | `priority`; `priority.budget` |
| `strategy`, `time_budget_ms`, `max_iterations`, `seed`, `grid_cell` | `solver` |
| `min_scale`, `wrap_max_lines`, `soft_overlap_weight` | `degrade_options` |
| `debug_svg`, `cost_breakdown`, `candidates`, `item_shape` | `output` |
| `background` and its options ([below](#backgrounds)), `vector=[{"class": …, "points": …}]`, `obstacles` | `obstacles` |
| `defaults`, `text`, `placement`, `solver`, `degrade_options`, `output` | the whole section, merged; the keywords above win |

## The builder

`la.Problem` collects items, backgrounds, obstacles and options step by step. Its
constructor and `set()` take the keywords of `la.place`; `build()` returns the problem as
a dict, `solve()` the result.

```python
--8<-- "examples/tutorials/python/basics.py:builder"
```

`build(embed_background=True)` and `to_json()` embed a NumPy background as base64, so the
JSON is self-contained (for the CLI, say).

## Raw JSON

Problems from elsewhere — files, other tools, the [problem format](../concepts/problem.md)
written by hand — go to `la.place_problem`: a dict, JSON text, a `pathlib.Path` of a file,
or a `Problem`.

```python
--8<-- "examples/tutorials/python/basics.py:raw"
```

## Results

`Result.placements` holds one frozen `Placement` per item, in input order; `res["id"]`
looks one up (ids are strings; `res[101]` looks up `"101"`).

```python
--8<-- "examples/tutorials/python/basics.py:result"
```

A `Placement` has the fields of the [result format](../concepts/result.md): `id`,
`placed`, `box` (a `BBox` with `x, y, w, h` in canvas px, y down, and `x1, y1, cx, cy`),
`anchor`, `anchor_side`, `model`, `leader` (`points`, `style`, `port`, `underline`,
`curve`), `lines`, `baselines`, `priority`, `degrade_steps`; for omitted items `reason`,
`blocking` and `blocked_by`; `members` and `leaders` of group labels, `parts` of composite
labels, and the JSON object as `raw`. `Result` also has `placed`, `unplaced`,
`omission_order`, `stats`, `warnings`, `to_dict()` and `to_svg(path=None)`, the debug
overlay (with heatmaps when solved with `debug_svg=True`).

## Errors

An invalid problem raises `la.ValidationError` (a `ValueError`) with one
`{pointer, code, message}` per problem; `pointer` is a JSON Pointer into the problem.
[Errors and validation](../concepts/errors.md) lists the codes.

```python
--8<-- "examples/tutorials/python/basics.py:errors"
```

```text
/canvas/width range must be > 0
/defaults/padding unit invalid length "3qq": use a number (px) or <number>px|pt|em
```

## Backgrounds

`background=` takes one background or a list:

| Input | Becomes |
|---|---|
| a `str` or `Path` of a PNG, JPEG or WebP file | a raster source (by its absolute path) |
| a `str` or `Path` of an SVG file | an SVG source |
| `bytes` of an encoded image | a raster source (as a `data:` URL) |
| `str` or `bytes` of SVG markup | an SVG source |
| a NumPy `uint8` array (H × W × 4, × 3 or grey; floats in [0, 1] and bools are converted), a PIL image | pixels handed to the engine directly, in one copy |

Its options are `background_mode` (`ink`, `alpha`, `cost`, `classmap`, `saliency`),
`background_class`, `background_scale`, `background_offset`, `background_options` (merged
into the source, e.g. `{"ink": {"threshold": 0.2}}`), `svg_classes` (`(selector, class)`
pairs, a `{selector: class}` dict or rule objects), `svg_default_class` and
`auto_mark_items`. Without a `canvas`, the canvas is the raster's size divided by its scale,
or the SVG's viewport. `la.capabilities()` lists the image formats this build decodes. The
tutorials on [raster](../tutorials/raster-backgrounds.md) and
[SVG](../tutorials/svg-background.md) backgrounds show them at work.

## Callbacks

Host functions that are not part of the JSON go to `la.place`, `Problem.solve` and
`la.place_problem`:

```python
--8<-- "examples/tutorials/python/basics.py:callbacks"
```

* `measure(text, font)` measures text with your own fonts (`font.size` in px), returning
  a `la.TextMetrics`, `{width, ascent, descent}`, `(w, a, d)`, or `None` for the bundled
  font; `measure("", font)` asks for the vertical metrics. Results are cached per text and
  font during a solve.
* `cost(candidate)` adds a cost ≥ 0 per candidate (`candidate.id`, `.box`, `.leader`).
* `progress(phase, fraction)` reports `"greedy"`, `"local"` and `"exact"` as they start,
  then `("done", 1.0)`.
* `cancelled` stops the solve early: a `la.CancelToken` (`token.cancel()` from any
  thread), a callable returning `True`, a `threading.Event`, or an object with a
  `cancelled` attribute. A cancelled solve raises `la.Cancelled`.
* `priority=callable(item)` returns a score or `(tier, score)`, once per item before the
  solve ([a priority function](../tutorials/priority.md#a-priority-function)).

The solve runs without the GIL; callbacks take it back. An exception in a callback stops
the solve and is re-raised with its traceback; Ctrl-C works the same way on the main
thread.

## Plotting helpers

### matplotlib

`label_points(ax, x, y, labels, **opts)` draws the figure, renders it without its texts as
the background, adds the visible texts and legends as hard obstacles, measures labels with
the figure's renderer, solves, and adds the label texts and leaders to the axes. `x` and
`y` are in the units of the plotted data (dates and categories too).

```python
--8<-- "examples/tutorials/python/helpers_matplotlib.py:matplotlib"
```

![Output of the matplotlib helper](../assets/figures/matplotlib.png){ width="560" }

The default [degradation ladder](../concepts/candidates.md#the-degradation-ladder) may
shrink a label that fits nowhere else or relax hard obstacle classes; the shorter ladder
of the example leaves both out, so every label keeps its size and the labels that do not
fit are omitted.

Call `label_points` when the figure is final — its size and layout (`tight_layout`), the
axis scales and limits, colorbars and legends. The labels are in data coordinates, so any
savefig dpi works, but a later change of the axes' size or scale moves the points under
labels that keep their size.

With a `priority`, an important label may cover the markers of less important points,
which then go unlabeled, so that the important labels survive a crowd
([important labels over minor marks](../tutorials/priority.md#important-labels-over-minor-marks));
`avoid={"lower_items": "hard"}` keeps every marker clear.

The helper's own options; everything else goes to `la.place`:

* `region="axes"` or `"figure"` (labels may use the figure's margins);
* `background="raster"` (default), `"svg"`, `None`, or any `background=` input of
  `la.place`;
* `fontsize` (points or a size name), `fontfamily`, `fontweight`, `fontstyle`: the label
  font, measured with the figure's renderer (`measure=False`: the bundled font);
* `marker_size` (points², as `scatter(s=)`; one number or one per point): the markers the
  labels keep clear of;
* `avoid_texts` (default `True`): the figure's visible texts are hard obstacles;
* `draw` (default `True`): add the artists, or only solve;
* `text_kw`, `leader_kw`: extra properties of the `Text` and `Line2D` artists;
* `preset` (default `"scatter"`).

`label_points` returns the `result` and the artists it added (`texts`, `leaders`).

### Plotly

`label_anything.plotly.label_points(fig, x, y, labels, **opts)` adds layout annotations
and leader shapes, computed from the figure size, margins, axis domains and ranges, which
it fixes. Linear and log axes work; other scatter traces of the same axes are obstacles.

```python
--8<-- "examples/tutorials/python/helpers_plotly.py:plotly"
```

Its own options are `xref`/`yref` or `row`/`col`, `font_size` (px), `marker_size`
(marker diameter in px), `avoid_traces`, `add`, `annotation_kw`, `line_kw` and `preset`
(default `"scatter"`).

### seaborn

`label_anything.seaborn.label_points(ax, data=df, x=..., y=..., label=...)` takes column
names like seaborn's axes-level functions; a `priority` given as a column name
(`priority="pop"`) ranks the points by that column.

```python
--8<-- "examples/tutorials/python/helpers_seaborn.py:seaborn"
```

## Limitations

* The Plotly helper measures text with the bundled font, not the browser's, and assumes
  the figure is shown at the fixed size it sets; legends that widen the margins shift the
  plot area.
* The matplotlib helper draws text labels and the text parts of composites; icons and
  boxes are in the result for you to draw.

All programs on this page are in
[`examples/tutorials/python`](gh:examples/tutorials/python) and run in CI. They read their
data (`points.csv`, …) from [`examples/tutorials/data`](gh:examples/tutorials/data): run
them there, or all at once with `python3 examples/tutorials/run.py python`.
