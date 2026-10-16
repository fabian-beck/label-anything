"""Seaborn helpers for axes-level plots (``scatterplot``, ``regplot``, ``stripplot`` ...).

``label_points(ax, data=df, x="gdp", y="life", label="country", **opts)`` resolves the
columns the way seaborn does (names in ``data`` or vectors) and calls
:func:`label_anything_extras.matplotlib.label_points` on the axes. Seaborn's default
marker size (``s=`` of ``scatterplot``, about 36 pt²) is used for the marks unless
``marker_size`` is given.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any, List, Optional

from matplotlib.axes import Axes

from .matplotlib import MatplotlibLabels
from .matplotlib import label_points as _mpl_label_points

__all__ = ["label_points"]


def _column(data: Any, v: Any, name: str) -> List[Any]:
    if isinstance(v, str):
        if data is None:
            raise ValueError(f"{name}={v!r} is a column name but no data was given")
        try:
            col = data[v]
        except (KeyError, IndexError, TypeError):
            raise KeyError(f"{name}: no column {v!r} in data") from None
        return list(col)
    if v is None:
        raise ValueError(f"{name} is required")
    return list(v)


def label_points(
    ax: Optional[Axes] = None,
    data: Any = None,
    *,
    x: Any,
    y: Any,
    label: Any,
    marker_size: Any = None,
    **opts: Any,
) -> MatplotlibLabels:
    """Label the points of an axes-level seaborn plot.

    ``x``, ``y``, ``label``: column names of ``data`` (a DataFrame or a dict of columns)
    or sequences. ``ax`` defaults to the current axes. ``attrs`` may name columns too:
    ``attrs=["population"]`` puts those columns into each item's ``attrs`` (for
    ``priority=la.Priority.attr("population")``). Other keywords go to
    :func:`label_anything_extras.matplotlib.label_points`.
    """
    if ax is None:
        import matplotlib.pyplot as plt

        ax = plt.gca()
    xs = _column(data, x, "x")
    ys = _column(data, y, "y")
    labels = [str(v) for v in _column(data, label, "label")]
    attrs = opts.get("attrs")
    if isinstance(attrs, Sequence) and not isinstance(attrs, (str, Mapping)) and attrs and all(isinstance(a, str) for a in attrs):
        opts["attrs"] = {a: _column(data, a, "attrs") for a in attrs}
    if marker_size is None:
        import matplotlib as mpl

        # seaborn.scatterplot draws markers of rcParams lines.markersize² (36 pt²)
        marker_size = float(mpl.rcParams["lines.markersize"]) ** 2
    return _mpl_label_points(ax, xs, ys, labels, marker_size=marker_size, **opts)
