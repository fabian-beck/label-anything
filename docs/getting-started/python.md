# Python

`label-anything` is the Python binding of the Rust engine: one abi3 wheel for CPython
≥ 3.9, typed (`py.typed`), without dependencies. The plotting helpers for matplotlib,
Plotly and seaborn are the optional package `label-anything-extras`. The complete API is
in the [Python API reference](../bindings/python.md).

```sh
pip install label-anything                 # the engine
pip install "label-anything[matplotlib]"   # + label_anything.matplotlib (also: plotly, seaborn, all)
```

Neither is on PyPI yet: until it is, build both from the repository (Rust ≥ 1.88 and
[maturin](https://www.maturin.rs/); [details](index.md#install-from-this-repository)):

```sh
maturin build --release -m rust/crates/la-py/Cargo.toml
pip install rust/target/wheels/label_anything-*.whl bindings/python-extras
```

## One call

Anchors and labels are positional; every keyword maps to a field of the problem
(`canvas`, `font_size`, `background`, `avoid`, `leaders`, `priority`, `max_labels`, …;
the table is in the [API reference](../bindings/python.md#one-call)). `None` always means
"not set": the [default](../reference/defaults.md) applies.

```python
--8<-- "examples/tutorials/python/basics.py:one-call"
```

## The builder

`la.Problem` collects items, backgrounds, obstacles and options fluently; `build()` gives
the problem as a dict (`problem.v1`), `solve()` the result.

```python
--8<-- "examples/tutorials/python/basics.py:builder"
```

## Raw JSON

Problems from elsewhere (files, other tools, the [problem format](../concepts/problem.md)
written by hand) go to `la.place_problem`. A `str` is JSON text; pass a `pathlib.Path`
for a file.

```python
--8<-- "examples/tutorials/python/basics.py:raw"
```

## Results

`Result.placements` holds one frozen `Placement` per item, in input order; `res["id"]`
looks one up. `BBox` has `x, y, w, h` (canvas px, y down) and `x1, y1, cx, cy`.

```python
--8<-- "examples/tutorials/python/basics.py:result"
```

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

## Callbacks

Host functions that are not part of the JSON: text measurement with your own fonts, an
extra cost per candidate, progress, cancellation (a `la.CancelToken`, a callable, a
`threading.Event`), and `priority=callable` (evaluated once per item). The solve runs
without the GIL; callbacks take it back.

```python
--8<-- "examples/tutorials/python/basics.py:callbacks"
```

## Plotting helpers

### matplotlib

`label_points(ax, x, y, labels, **opts)` draws the figure, renders it without its texts as
the background, adds the visible texts and legends as hard obstacles, measures labels with
the figure's renderer, solves, and adds the label texts and leaders to the axes. `x` and
`y` are in the units of the plotted data (dates and categories too). Every other keyword
goes to `la.place`; the [API reference](../bindings/python.md#plotting-helpers) lists the
helper's own options.

```python
--8<-- "examples/tutorials/python/helpers_matplotlib.py:matplotlib"
```

![Output of the matplotlib helper](../assets/figures/matplotlib.png){ width="560" }

The default [degradation ladder](../concepts/candidates.md) may shrink a label that fits
nowhere else (`shrink:0.85`, down to 0.7) or relax hard obstacle classes
(`soft_overlap`); the example's shorter ladder leaves both out, so every label keeps the
chosen size and the labels that do not fit are omitted.

Call `label_points` when the figure is final — size, layout (`tight_layout`), axis scales
and limits, colorbars, legends: the labels are in data coordinates, so any savefig dpi
works, but a later change of the axes' size or scale moves the points under labels that
keep their size. With a `priority`, an important label may cover the dots of less
important points, which then go unlabeled, so the most important labels survive a crowd
([important labels over minor marks](../tutorials/priority.md#important-labels-over-minor-marks));
`avoid={"lower_items": "hard"}` keeps every dot clear.

### Plotly

`label_anything.plotly.label_points(fig, x, y, labels, **opts)` returns (and adds) layout
annotations and leader shapes, computed from the figure size, margins, axis domains and
ranges, which it fixes. Other scatter traces of the same axes are obstacles.

```python
--8<-- "examples/tutorials/python/helpers_plotly.py:plotly"
```

### seaborn

`label_anything.seaborn.label_points(ax, data=df, x=..., y=..., label=...)` takes column
names like seaborn's axes-level functions, and seaborn's default marker size; a
`priority` given as a column name (`priority="pop"`) ranks the points by that column.

```python
--8<-- "examples/tutorials/python/helpers_seaborn.py:seaborn"
```

All programs on this page are in
[`examples/tutorials/python`](gh:examples/tutorials/python) and run in CI. They read their
data (`points.csv`, ...) from [`examples/tutorials/data`](gh:examples/tutorials/data):
run them there, or all at once with `python3 examples/tutorials/run.py python`.
