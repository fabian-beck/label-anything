"""Plotly helpers: label data points of a Plotly figure.

``label_points(fig, x, y, labels, **opts)`` maps the points to pixels of the plot area
(layout ``width``/``height``, ``margin`` and the axis ``domain`` and ``range``), places
the labels with :func:`label_anything.place` and returns layout **annotations** (one per
label, centred on its box) and leader **shapes** (``type="path"``), adding them to the
figure unless ``add=False``.

Positions are exact for a fixed figure size, so the helper sets ``layout.width`` /
``height`` (default 700 × 450) and the axis ranges (computed from the data when unset)
on the figure. Linear and log axes are supported. Markers of the other scatter traces
on the same axes are ``points`` obstacles and their lines ``lines`` obstacles. Text is
measured with the engine's bundled font (the browser's font may differ slightly; the
annotations are centred on their boxes to absorb this).
"""

from __future__ import annotations

import math
from collections.abc import Mapping, Sequence
from typing import Any, Dict, List, NamedTuple, Optional, Tuple

import label_anything as la

__all__ = ["PlotlyLabels", "label_points"]

_DEFAULT_SIZE = (700.0, 450.0)
_DEFAULT_MARGIN = {"l": 80.0, "r": 80.0, "t": 100.0, "b": 80.0}


class PlotlyLabels(NamedTuple):
    """What :func:`label_points` returns."""

    result: la.Result
    #: ``layout.annotations`` entries (dicts), one per placed label.
    annotations: List[Dict[str, Any]]
    #: ``layout.shapes`` entries (dicts) for the leader lines.
    shapes: List[Dict[str, Any]]


def _get(obj: Any, *path: str) -> Any:
    for k in path:
        if obj is None:
            return None
        try:
            obj = obj[k]
        except (KeyError, IndexError, TypeError, ValueError):
            return None
    return obj


def _layout(fig: Any, *path: str) -> Any:
    """A layout value, falling back to the figure's template."""
    v = _get(fig.layout, *path)
    if v is None:
        v = _get(fig.layout, "template", "layout", *path)
    return v


def _axis_name(ref: str) -> str:
    return ("xaxis" if ref.startswith("x") else "yaxis") + ref[1:]


class _Axis:
    """Data → pixel mapping of one axis (range in axis units: log10 for log axes)."""

    def __init__(self, fig: Any, ref: str, values: List[float], pixel0: float, pixel1: float) -> None:
        name = _axis_name(ref)
        self.ref = ref
        self.name = name
        typ = _layout(fig, name, "type")
        if typ in ("date", "category", "multicategory"):
            raise ValueError(f"{name}: only linear and log axes are supported (type {typ!r})")
        self.log = typ == "log"
        rng = _layout(fig, name, "range")
        if rng is not None and len(rng) == 2 and None not in rng:
            r0, r1 = float(rng[0]), float(rng[1])
            self.explicit = True
        else:
            vals = [self.to_range(v) for v in values]
            vals = [v for v in vals if math.isfinite(v)]
            if not vals:
                r0, r1 = -1.0, 6.0
            else:
                lo, hi = min(vals), max(vals)
                span = hi - lo if hi > lo else (abs(lo) or 1.0)
                r0, r1 = lo - 0.06 * span, hi + 0.06 * span
            if _layout(fig, name, "autorange") == "reversed":
                r0, r1 = r1, r0
            self.explicit = False
        self.r0, self.r1 = r0, r1
        self.p0, self.p1 = pixel0, pixel1

    def to_range(self, v: float) -> float:
        if self.log:
            return math.log10(v) if v > 0 else math.nan
        return float(v)

    def to_pixel(self, v: float) -> float:
        return self.p0 + (self.to_range(v) - self.r0) / (self.r1 - self.r0) * (self.p1 - self.p0)

    def range_at(self, px: float) -> float:
        """Axis-range value (log10 on log axes) at a pixel — annotation positions."""
        return self.r0 + (px - self.p0) / (self.p1 - self.p0) * (self.r1 - self.r0)

    def data_at(self, px: float) -> float:
        """Data value at a pixel — shape positions (plotly converts log axes itself)."""
        r = self.range_at(px)
        return 10.0**r if self.log else r


def _numeric(seq: Any) -> List[float]:
    out: List[float] = []
    if seq is None:
        return out
    for v in seq:
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            out.append(math.nan)
    return out


def _sizes(marker_size: Any, n: int) -> List[float]:
    """Marker diameters: one number for all points, or one per point (a sequence, NumPy
    array or pandas Series)."""
    if isinstance(marker_size, (str, bytes)):
        raise TypeError(f"marker_size must be a number or one number per point (got {marker_size!r})")
    try:
        sizes = [float(s) for s in marker_size]
    except TypeError:  # a number (also a NumPy scalar or 0-d array)
        return [float(marker_size)] * n
    if len(sizes) != n:
        raise ValueError(f"marker_size has {len(sizes)} values but there are {n} points")
    return sizes


def _fmt(v: float) -> str:
    return repr(round(v, 6))


def label_points(
    fig: Any,
    x: Sequence[Any],
    y: Sequence[Any],
    labels: Sequence[Any],
    *,
    xref: str = "x",
    yref: str = "y",
    row: Optional[int] = None,
    col: Optional[int] = None,
    font_size: Optional[float] = None,
    marker_size: Any = None,
    avoid_traces: bool = True,
    add: bool = True,
    annotation_kw: Optional[Mapping[str, Any]] = None,
    line_kw: Optional[Mapping[str, Any]] = None,
    preset: Optional[str] = "scatter",
    **opts: Any,
) -> PlotlyLabels:
    """Place labels for the points ``(x, y)`` of a ``plotly.graph_objects.Figure``.

    * ``xref`` / ``yref`` (or ``row`` / ``col`` of a subplot grid): the axes.
    * ``font_size``: px (default: the layout font size, else 12).
    * ``marker_size``: marker diameter in px, scalar or one per point (default 6).
    * ``avoid_traces``: other scatter traces on these axes are obstacles.
    * ``add``: add the annotations and shapes to ``fig``.
    * ``annotation_kw`` / ``line_kw``: extra annotation properties / shape line style; a
      ``font`` in ``annotation_kw`` is merged into the measured one (``color``,
      ``family``, ...); a different ``size`` raises ``TypeError`` (use ``font_size``).
    * ``**opts``: keyword options of :func:`label_anything.place`.
    """
    for k in ("canvas", "anchors", "labels", "background"):
        if k in opts:
            raise TypeError(f"label_points computes {k!r} itself")
    if row is not None or col is not None:
        sub = fig.get_subplot(row or 1, col or 1)
        xref = sub.xaxis.plotly_name.replace("axis", "")
        yref = sub.yaxis.plotly_name.replace("axis", "")
    xs, ys = _numeric(x), _numeric(y)
    label_list = list(labels)
    n = len(label_list)
    if len(xs) != n or len(ys) != n:
        raise ValueError(f"x, y and labels must have the same length ({len(xs)}, {len(ys)}, {n})")

    width = float(fig.layout.width or _layout(fig, "width") or _DEFAULT_SIZE[0])
    height = float(fig.layout.height or _layout(fig, "height") or _DEFAULT_SIZE[1])
    margin = {k: float(_layout(fig, "margin", k) if _layout(fig, "margin", k) is not None else d) for k, d in _DEFAULT_MARGIN.items()}
    plot_w = width - margin["l"] - margin["r"]
    plot_h = height - margin["t"] - margin["b"]
    if plot_w <= 0 or plot_h <= 0:
        raise ValueError("the figure margins leave no plot area")
    xdom = _layout(fig, _axis_name(xref), "domain") or (0.0, 1.0)
    ydom = _layout(fig, _axis_name(yref), "domain") or (0.0, 1.0)
    # canvas = the plot area of these axes; pixels from its top-left corner
    cw = (float(xdom[1]) - float(xdom[0])) * plot_w
    ch = (float(ydom[1]) - float(ydom[0])) * plot_h

    traces = [
        t
        for t in fig.data
        if getattr(t, "type", None) in ("scatter", "scattergl")
        and (getattr(t, "xaxis", None) or "x") == xref
        and (getattr(t, "yaxis", None) or "y") == yref
    ]
    all_x = list(xs) + [v for t in traces for v in _numeric(t.x)]
    all_y = list(ys) + [v for t in traces for v in _numeric(t.y)]
    ax_x = _Axis(fig, xref, all_x, 0.0, cw)
    ax_y = _Axis(fig, yref, all_y, ch, 0.0)  # y up: range start at the bottom

    def to_canvas(px: float, py: float) -> Tuple[float, float]:
        return ax_x.to_pixel(px), ax_y.to_pixel(py)

    keep = [i for i in range(n) if all(math.isfinite(v) for v in to_canvas(xs[i], ys[i]))]
    anchors = [to_canvas(xs[i], ys[i]) for i in keep]

    ids_opt = opts.pop("ids", None)
    ids = [str(i) for i in (ids_opt if ids_opt is not None else range(n))]
    sizes = _sizes(6.0 if marker_size is None else marker_size, n)
    marks = [la.Mark.circle(sizes[i] / 2.0) for i in keep]

    def pick(v: Any) -> Any:
        if v is None:
            return None
        if isinstance(v, Mapping):
            return {k: [list(col)[i] for i in keep] for k, col in v.items()}
        if hasattr(v, "iloc"):
            return v.iloc[keep]
        vals = list(v)
        return [vals[i] for i in keep]

    per_item = {k: pick(opts.pop(k)) for k in ("attrs", "required", "groups", "keep_with", "item_placement") if k in opts}
    for k in ("priority", "tiers"):
        v = opts.get(k)
        if v is not None and not isinstance(v, (str, Mapping, la.Priority)) and not callable(v):
            vals = list(v)
            if len(vals) == n:
                opts[k] = [vals[i] for i in keep]

    vector: List[Dict[str, Any]] = list(opts.pop("vector", None) or [])
    if avoid_traces:
        labeled = {(round(a[0], 3), round(a[1], 3)) for a in anchors}
        for t in traces:
            tx, ty = _numeric(t.x), _numeric(t.y)
            pts = [to_canvas(a, b) for a, b in zip(tx, ty)]
            pts = [p for p in pts if all(math.isfinite(c) for c in p)]
            mode = getattr(t, "mode", None) or ("lines+markers" if len(pts) < 20 else "lines")
            if "markers" in mode:
                size = _get(t, "marker", "size")
                r = (float(size) / 2.0) if isinstance(size, (int, float)) else 3.0
                free = [list(p) for p in pts if (round(p[0], 3), round(p[1], 3)) not in labeled]
                if free:
                    vector.append({"class": "points", "points": free, "r": r})
            if "lines" in mode and len(pts) >= 2:
                lw = _get(t, "line", "width")
                vector.append({"class": "lines", "polylines": [[list(p) for p in pts]], "width": float(lw) if lw else 2.0})

    if font_size is None:
        fs = _layout(fig, "font", "size")
        font_size = float(fs) if fs else 12.0
    res = la.place(
        anchors,
        [label_list[i] for i in keep],
        ids=[ids[i] for i in keep],
        marks=marks,
        canvas=(cw, ch),
        font_size=font_size,
        preset=preset,
        vector=vector or None,
        **per_item,
        **opts,
    )

    akw: Dict[str, Any] = {"showarrow": False, "xanchor": "center", "yanchor": "middle"}
    akw.update(annotation_kw or {})
    font_kw: Dict[str, Any] = dict(akw.pop("font", None) or {})
    if font_kw.get("size") not in (None, font_size):
        raise TypeError(
            f"annotation_kw font size {font_kw['size']!r} differs from the measured labels "
            f"({font_size!r} px); set it with font_size="
        )
    line: Dict[str, Any] = {"color": "#555555", "width": 1}
    line.update(line_kw or {})
    annotations: List[Dict[str, Any]] = []
    shapes: List[Dict[str, Any]] = []
    for p in res.placed:
        if p.box is None:
            continue
        cx, cy = p.box.center
        size = float((p.text or {}).get("font_size", font_size))
        ann: Dict[str, Any] = {
            "x": ax_x.range_at(cx),
            "y": ax_y.range_at(cy),
            "xref": xref,
            "yref": yref,
            "text": "<br>".join(p.lines),
            "font": {**font_kw, "size": size},
        }
        ann.update(akw)
        annotations.append(ann)
        for ld in p.all_leaders:
            for poly in (ld.points, ld.underline or ()):
                if len(poly) < 2:
                    continue
                path = " ".join(
                    f"{'M' if i == 0 else 'L'} {_fmt(ax_x.data_at(px))},{_fmt(ax_y.data_at(py))}"
                    for i, (px, py) in enumerate(poly)
                )
                shapes.append(
                    {"type": "path", "path": path, "xref": xref, "yref": yref, "line": dict(line), "layer": "above"}
                )

    # fix size, margins and ranges so the computed pixel positions stay valid
    fig.update_layout(width=width, height=height, margin={k: margin[k] for k in ("l", "r", "t", "b")})
    fig.update_layout({ax_x.name: {"range": [ax_x.r0, ax_x.r1], "autorange": False}})
    fig.update_layout({ax_y.name: {"range": [ax_y.r0, ax_y.r1], "autorange": False}})
    if add:
        fig.update_layout(
            annotations=list(fig.layout.annotations or ()) + annotations,
            shapes=list(fig.layout.shapes or ()) + shapes,
        )
    return PlotlyLabels(res, annotations, shapes)
