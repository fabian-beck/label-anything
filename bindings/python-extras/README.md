# label-anything-extras

Plotting helpers for [Label Anything](https://github.com/fabian-beck/label-anything), the
label placement engine:

* `label_anything_extras.matplotlib.label_points(ax, x, y, labels, **opts)` places labels
  for data points of a matplotlib `Axes`, avoiding everything already drawn (the figure
  is rendered without its texts as the background), and draws the labels and leaders;
* `label_anything_extras.plotly.label_points(fig, x, y, labels, **opts)` returns (and
  adds) layout annotations and leader shapes for a Plotly figure;
* `label_anything_extras.seaborn.label_points(ax, data=df, x=..., y=..., label=...)` for
  axes-level seaborn plots.

The same functions are available as `label_anything.matplotlib`, `.plotly` and
`.seaborn` once this package is installed:

```sh
pip install "label-anything[matplotlib]"   # or [plotly], [seaborn], [all]
```

See `docs/bindings/python.md` in the repository. MIT License.
