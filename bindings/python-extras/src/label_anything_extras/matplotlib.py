"""Matplotlib helpers: place labels for data points of an ``Axes`` and draw them.

``label_points(ax, x, y, labels, **opts)``

1. draws the figure (so the layout and the data → pixel transform are final) and fixes
   the axes limits;
2. renders the figure **without its text artists** as the background: with Agg as an
   RGBA array of the axes region (``background="raster"``, the default), or as SVG
   (``background="svg"``) with explicit class rules;
3. adds the existing visible texts (titles, tick labels, annotations, earlier labels)
   as hard ``text`` obstacles and legends as hard ``legend`` obstacles;
4. measures label text with the figure's own renderer, so the boxes match the drawn text;
5. solves with :func:`label_anything.place` (``**opts`` are its keyword options) and
   draws a text artist per label line plus ``Line2D`` leaders.

Coordinates: matplotlib display pixels (origin bottom-left, ``fig.dpi``) map to canvas
pixels (origin top-left) of either the axes region (``region="axes"``) or the whole
figure (``region="figure"``, labels may use the margins).
"""

from __future__ import annotations

import contextlib
import io
import math
import warnings
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Tuple, Union

import numpy as np
from matplotlib import cbook
from matplotlib.artist import Artist
from matplotlib.axes import Axes
from matplotlib.backends.backend_agg import FigureCanvasAgg, RendererAgg
from matplotlib.colors import to_hex, to_rgba
from matplotlib.figure import Figure
from matplotlib.font_manager import FontProperties
from matplotlib.lines import Line2D
from matplotlib.text import Text

import label_anything as la
from label_anything.problem import avoid_dict, merge

__all__ = [
    "FigureBackground",
    "Frame",
    "MatplotlibLabels",
    "figure_background",
    "label_points",
    "svg_classes",
    "text_measure",
]

#: gid given to the figure background patch while the SVG background is rendered.
FIGURE_PATCH_GID = "la-bg-figure"
#: gid prefix of the axes background patches (``la-bg-axes-0``, ...).
AXES_PATCH_GID = "la-bg-axes-"


def svg_classes(patch_gids: Sequence[str] = (FIGURE_PATCH_GID, AXES_PATCH_GID + "0")) -> List[Dict[str, str]]:
    """Class rules for matplotlib's SVG output.

    The figure and axes background patches (rendered with the given gids) are ignored —
    the axes patch covers less than 90 % of the figure, so the generic ``:background``
    rule of the presets would not catch it. Markers (``<use>``) are ``points``, stroked
    paths (lines, spines, ticks) are ``lines``, everything else (bars, fills, images) is
    ``ink``.
    """
    ignore = ", ".join(f"#{g} *" for g in patch_gids)
    return [
        {"selector": ignore, "class": "ignore"},
        {"selector": "use, circle, ellipse", "class": "points"},
        {"selector": "path:unfilled, line, polyline", "class": "lines"},
        {"selector": "*", "class": "ink"},
    ]


@dataclass(frozen=True)
class Frame:
    """Maps display pixels (origin bottom-left) to canvas pixels (origin top-left)."""

    #: Height of the rendered figure in display px.
    fig_height: float
    #: Display x of the canvas's left edge.
    left: float
    #: Distance of the canvas's top edge from the figure top (px).
    top: float
    width: float
    height: float

    def to_canvas(self, disp: Any) -> Any:
        d = np.asarray(disp, dtype=float).reshape(-1, 2)
        return np.column_stack([d[:, 0] - self.left, (self.fig_height - d[:, 1]) - self.top])

    def to_display(self, pts: Any) -> Any:
        p = np.asarray(pts, dtype=float).reshape(-1, 2)
        return np.column_stack([p[:, 0] + self.left, self.fig_height - (p[:, 1] + self.top)])

    def rect(self, x0: float, y0: float, x1: float, y1: float) -> List[float]:
        """Canvas ``[x, y, w, h]`` of a display-space box."""
        return [x0 - self.left, (self.fig_height - y1) - self.top, x1 - x0, y1 - y0]


@dataclass
class FigureBackground:
    """A rendered figure, ready to be passed to :func:`label_anything.place`."""

    #: RGBA ``uint8`` array (raster) or SVG markup.
    background: Any
    frame: Frame
    #: ``la.place`` keyword options: ``canvas`` and, for SVG, ``region``, ``svg_classes``;
    #: for rasters, ``background_options`` with the ink background colour.
    options: Dict[str, Any] = field(default_factory=dict)
    #: Canvas ``[x, y, w, h]`` of the visible texts (before they were hidden).
    text_rects: List[List[float]] = field(default_factory=list)
    #: Canvas ``[x, y, w, h]`` of the legends.
    legend_rects: List[List[float]] = field(default_factory=list)
    renderer: Optional[RendererAgg] = None


class MatplotlibLabels(NamedTuple):
    """What :func:`label_points` returns: the result and the created artists."""

    result: la.Result
    #: One text artist per label line, in placement order.
    texts: List[Text]
    #: Leader lines (and baseline underlines).
    leaders: List[Line2D]

    @property
    def artists(self) -> List[Artist]:
        return [*self.texts, *self.leaders]

    def remove(self) -> None:
        """Remove the created artists from the axes."""
        for a in self.artists:
            a.remove()


def _root_figure(obj: Union[Axes, Figure]) -> Figure:
    """The root figure of an axes, figure or subfigure."""
    fig: Any = obj.figure if isinstance(obj, Axes) else obj
    while not isinstance(fig, Figure):  # SubFigure → parent
        fig = fig.figure
    return fig


def _refresh(fig: Figure) -> None:
    """Schedule a redraw of interactive canvases (plain Agg canvases redraw on save)."""
    if type(fig.canvas) is not FigureCanvasAgg:
        with contextlib.suppress(Exception):
            fig.canvas.draw_idle()


@contextlib.contextmanager
def _agg_canvas(fig: Figure) -> Iterator[Any]:
    """The figure's Agg canvas, or a temporary one (the original canvas is restored).

    (Typed ``Any``: ``backend_agg`` has no type annotations.)"""
    canvas = fig.canvas
    if isinstance(canvas, FigureCanvasAgg):
        yield canvas
        return
    agg = FigureCanvasAgg(fig)
    try:
        yield agg
    finally:
        fig.set_canvas(canvas)


@contextlib.contextmanager
def _without_text(fig: Figure, renderer: RendererAgg) -> Iterator[None]:
    """Hide every visible text artist (and mute the renderer's text calls)."""
    hidden = [t for t in fig.findobj(match=Text) if t.get_visible()]
    for t in hidden:
        t.set_visible(False)
    muted = ("draw_text", "draw_tex")

    def _nothing(*args: Any, **kwargs: Any) -> None:
        return None

    for name in muted:
        setattr(renderer, name, _nothing)
    try:
        yield
    finally:
        for name in muted:
            with contextlib.suppress(AttributeError):
                delattr(renderer, name)
        for t in hidden:
            t.set_visible(True)


def _facecolor(*colors: Any) -> str:
    """First opaque colour as ``#rrggbb`` (white if all are transparent)."""
    for c in colors:
        rgba = to_rgba(c)
        if rgba[3] >= 0.5:
            return str(to_hex(rgba, keep_alpha=False))
    return "#ffffff"


def _axes_box(ax: Axes, renderer: RendererAgg) -> Tuple[float, float, float, float]:
    bb = ax.get_window_extent(renderer)
    return float(bb.x0), float(bb.y0), float(bb.x1), float(bb.y1)


def figure_background(
    target: Union[Axes, Figure],
    *,
    kind: Optional[str] = "raster",
    region: str = "axes",
) -> FigureBackground:
    """Render a figure without its texts as a background.

    ``target``: the axes whose region is the canvas (``region="axes"``), or a figure
    (whole figure). ``kind``: ``"raster"`` (Agg RGBA array), ``"svg"`` (SVG markup with
    :func:`svg_classes` rules) or ``None`` (only the frame, text and legend boxes).
    """
    if kind not in ("raster", "svg", None):
        raise ValueError(f"kind must be 'raster', 'svg' or None (got {kind!r})")
    if region not in ("axes", "figure"):
        raise ValueError(f"region must be 'axes' or 'figure' (got {region!r})")
    ax = target if isinstance(target, Axes) else None
    fig = _root_figure(target)
    if ax is None:
        region = "figure"
    with _agg_canvas(fig) as canvas:
        canvas.draw()
        renderer: Any = canvas.get_renderer()
        # the Agg buffer has integer size; SVG keeps the exact figure size
        if kind == "svg":
            fig_w, fig_h = float(fig.bbox.width), float(fig.bbox.height)
        else:
            fig_w, fig_h = float(renderer.width), float(renderer.height)
        if region == "axes" and ax is not None:
            x0, y0, x1, y1 = _axes_box(ax, renderer)
            if kind == "svg":
                frame = Frame(fig_h, 0.0, 0.0, fig_w, fig_h)
            else:
                c0, c1 = max(0, math.floor(x0)), min(int(fig_w), math.ceil(x1))
                r0, r1 = max(0, math.floor(fig_h - y1)), min(int(fig_h), math.ceil(fig_h - y0))
                frame = Frame(fig_h, float(c0), float(r0), float(c1 - c0), float(r1 - r0))
        else:
            frame = Frame(fig_h, 0.0, 0.0, fig_w, fig_h)
        # boxes of the visible texts and legends, measured before the texts are hidden
        text_rects: List[List[float]] = []
        for t in fig.findobj(match=Text):
            if not t.get_visible() or not t.get_text().strip():
                continue
            bb = t.get_window_extent(renderer)
            if bb.width > 0 and bb.height > 0:
                text_rects.append(frame.rect(bb.x0, bb.y0, bb.x1, bb.y1))
        legends = [lg for lg in [*(a.get_legend() for a in fig.axes), *fig.legends] if lg is not None]
        legend_rects = []
        for lg in legends:
            if lg.get_visible():
                bb = lg.get_window_extent(renderer)
                legend_rects.append(frame.rect(bb.x0, bb.y0, bb.x1, bb.y1))
        options: Dict[str, Any] = {"canvas": (frame.width, frame.height)}
        background: Any = None
        if kind == "raster":
            with _without_text(fig, renderer):
                canvas.draw()
                rgba = np.asarray(canvas.buffer_rgba())
            c0, r0 = int(frame.left), int(frame.top)
            background = rgba[r0 : r0 + int(frame.height), c0 : c0 + int(frame.width)].copy()
            face = _facecolor(ax.get_facecolor(), fig.get_facecolor()) if region == "axes" and ax is not None else _facecolor(fig.get_facecolor())
            options["background_options"] = {"ink": {"background": face}}
        elif kind == "svg":
            gids = [FIGURE_PATCH_GID] + [f"{AXES_PATCH_GID}{i}" for i in range(len(fig.axes))]
            patches = [fig.patch] + [a.patch for a in fig.axes]
            old = [p.get_gid() for p in patches]
            for p, g in zip(patches, gids):
                p.set_gid(g)
            buf = io.StringIO()
            try:
                with _without_text(fig, renderer):
                    fig.savefig(buf, format="svg", bbox_inches=fig.bbox_inches)
            finally:
                for p, g0 in zip(patches, old):
                    p.set_gid(g0)
            background = buf.getvalue()
            options["svg_classes"] = svg_classes(gids)
            if region == "axes" and ax is not None:
                x0, y0, x1, y1 = _axes_box(ax, renderer)
                options["region"] = frame.rect(x0, y0, x1, y1)
    _refresh(fig)
    return FigureBackground(
        background=background,
        frame=frame,
        options=options,
        text_rects=text_rects,
        legend_rects=legend_rects,
        renderer=renderer,
    )


def text_measure(fig: Figure, renderer: Optional[RendererAgg] = None) -> Callable[[str, la.FontSpec], la.TextMetrics]:
    """A ``measure`` callback that uses the figure's text engine (font size px → pt at
    ``fig.dpi``); ascent and descent are those matplotlib uses for line layout."""
    if renderer is None:
        with _agg_canvas(fig) as canvas:
            renderer = canvas.get_renderer()
    r = renderer
    dpi = float(fig.dpi)
    vmetrics: Dict[Tuple[str, int, bool, float], Tuple[float, float]] = {}

    def prop(font: la.FontSpec) -> FontProperties:
        family = None if font.family.lower() in ("default", "") else font.family
        return FontProperties(
            family=family,
            weight=font.weight,
            style="italic" if font.italic else "normal",
            size=font.size * 72.0 / dpi,
        )

    def measure(text: str, font: la.FontSpec) -> la.TextMetrics:
        key = (font.family, font.weight, font.italic, font.size)
        p = prop(font)
        if key not in vmetrics:
            _, h, d = r.get_text_width_height_descent("lp", p, ismath=False)
            vmetrics[key] = (float(h - d), float(d))
        ascent, descent = vmetrics[key]
        width = 0.0
        if text:
            ismath: Any = bool(cbook.is_math_text(text))
            width = float(r.get_text_width_height_descent(text, p, ismath=ismath)[0])
        return la.TextMetrics(width, ascent, descent)

    return measure


#: ``text_kw`` keys (matplotlib aliases) that are the label font: measured like the
#: ``fontsize``, ``fontfamily``, ``fontweight`` and ``fontstyle`` arguments.
_FONT_KW = {
    "fontsize": "fontsize",
    "size": "fontsize",
    "fontfamily": "fontfamily",
    "family": "fontfamily",
    "fontname": "fontfamily",
    "fontweight": "fontweight",
    "weight": "fontweight",
    "fontstyle": "fontstyle",
    "style": "fontstyle",
}
#: ``text_kw`` keys that change the size, shape or position of the drawn text in ways the
#: measurement does not see.
_UNMEASURED_KW = (
    "fontproperties",
    "font_properties",
    "font",
    "fontstretch",
    "stretch",
    "fontvariant",
    "variant",
    "rotation",
    "usetex",
    "math_fontfamily",
    "wrap",
    "horizontalalignment",
    "ha",
    "verticalalignment",
    "va",
    "transform",
)


def _split_text_kw(text_kw: Optional[Mapping[str, Any]], font: Dict[str, Any]) -> Dict[str, Any]:
    """Move the font keys of ``text_kw`` into ``font`` (the measured font) and reject keys
    that would make the drawn labels differ from the measured ones; returns the rest."""
    rest = dict(text_kw or {})
    for key, name in _FONT_KW.items():
        if key not in rest:
            continue
        value = rest.pop(key)
        if font[name] is not None and font[name] != value:
            raise TypeError(
                f"the label {name} is given twice: {name}={font[name]!r} and text_kw[{key!r}]={value!r}"
            )
        font[name] = value
    bad = [k for k in rest if k in _UNMEASURED_KW]
    if bad:
        raise TypeError(
            f"text_kw[{bad[0]!r}] would change the drawn labels after they were measured and placed; "
            "set the font with fontsize=, fontfamily=, fontweight= and fontstyle="
        )
    return rest


def _font_px(fontsize: Union[float, str, None], dpi: float) -> float:
    pt = FontProperties(size=fontsize).get_size_in_points()
    return float(pt) * dpi / 72.0


def label_points(
    ax: Axes,
    x: Any,
    y: Any,
    labels: Sequence[Any],
    *,
    region: str = "axes",
    background: Any = "raster",
    fontsize: Union[float, str, None] = None,
    fontfamily: Optional[str] = None,
    fontweight: Union[int, str, None] = None,
    fontstyle: Optional[str] = None,
    marker_size: Any = None,
    measure: Union[bool, Callable[[str, la.FontSpec], Any]] = True,
    avoid_texts: bool = True,
    draw: bool = True,
    text_kw: Optional[Mapping[str, Any]] = None,
    leader_kw: Optional[Mapping[str, Any]] = None,
    preset: Optional[str] = "scatter",
    **opts: Any,
) -> MatplotlibLabels:
    """Place and draw labels for the points ``(x, y)`` (data coordinates) of ``ax``.

    * ``region``: ``"axes"`` (labels stay inside the axes) or ``"figure"`` (labels may
      use the figure margins).
    * ``background``: ``"raster"`` (the figure rendered with Agg without its texts, the
      default), ``"svg"`` (the figure as SVG without its texts, classified with
      :func:`svg_classes`), ``None``/``False`` (no background), or any ``background=``
      input of :func:`label_anything.place` matching the canvas.
    * ``fontsize`` (points or a size name; default ``rcParams["font.size"]``),
      ``fontfamily``, ``fontweight``, ``fontstyle``: label font.
    * ``marker_size``: marker area in points² like ``scatter(s=...)`` (scalar or one per
      point; default ``rcParams["lines.markersize"] ** 2``).
    * ``measure``: ``True`` measures with the figure's renderer, ``False`` uses the
      engine's bundled font, or a callable.
    * ``avoid_texts``: the figure's visible texts are hard ``text`` obstacles.
    * ``draw``: add the text and leader artists (otherwise only solve).
    * ``text_kw`` / ``leader_kw``: extra properties of the text and ``Line2D`` artists
      (``color``, ``zorder``, ``bbox``, ...). Font keys (``fontsize``/``size``,
      ``fontfamily``/``family``, ``fontweight``/``weight``, ``fontstyle``/``style``) act
      like the arguments above; keys that change the text without being measured
      (``rotation``, ``fontproperties``, ``fontstretch``, ``usetex``, alignment, ...)
      raise ``TypeError``.
    * ``preset``: the problem preset (default ``"scatter"``).
    * ``**opts``: keyword options of :func:`label_anything.place` (``priority``,
      ``max_labels``, ``leaders``, ``avoid``, ``ids``, ``attrs``, ...).

    ``x`` and ``y`` are in the units of the axes' data: dates, categories and other
    matplotlib units are converted like the plotted data. The axes limits are fixed
    (autoscaling off), because the layout is computed for the current view; call
    ``label_points`` when the figure is final (size, layout, scales, colorbars and
    legends), as later changes move the data under the labels. Points with non-finite
    coordinates are skipped; a warning says when no point lies inside the canvas.
    """
    for k in ("canvas", "anchors", "labels"):
        if k in opts:
            raise TypeError(f"label_points computes {k!r} itself")
    fig = _root_figure(ax)
    font: Dict[str, Any] = dict(fontsize=fontsize, fontfamily=fontfamily, fontweight=fontweight, fontstyle=fontstyle)
    text_kw = _split_text_kw(text_kw, font)
    fontsize, fontfamily = font["fontsize"], font["fontfamily"]
    fontweight, fontstyle = font["fontweight"], font["fontstyle"]
    # dates, categories, ...: the axes' unit converters give the plotted values
    xs = np.asarray(_axis_units(ax.xaxis, x), dtype=float).ravel()
    ys = np.asarray(_axis_units(ax.yaxis, y), dtype=float).ravel()
    label_list = list(labels)
    n = len(label_list)
    if len(xs) != n or len(ys) != n:
        raise ValueError(f"x, y and labels must have the same length ({len(xs)}, {len(ys)}, {n})")
    # fix the view: the layout is only valid for these limits
    ax.set_xlim(ax.get_xlim())
    ax.set_ylim(ax.get_ylim())

    kind: Optional[str]
    explicit_bg: Any = None
    if background is None or background is False:
        kind = None
    elif isinstance(background, str) and background in ("raster", "svg"):
        kind = background
    else:
        kind, explicit_bg = None, background
    snap = figure_background(ax, kind=kind, region=region)
    frame = snap.frame
    dpi = float(fig.dpi)

    disp = ax.transData.transform(np.column_stack([xs, ys]))
    canvas_xy = frame.to_canvas(disp)
    keep = np.isfinite(canvas_xy).all(axis=1)
    idx = np.flatnonzero(keep)
    inside = (canvas_xy[idx] >= 0.0).all(axis=1) & (canvas_xy[idx] <= (frame.width, frame.height)).all(axis=1)
    if len(idx) and not inside.any():
        where = "axes" if region == "axes" else "figure"
        warnings.warn(
            f"label_points: none of the {len(idx)} points lies inside the {where} "
            "(are x and y in the units of the plotted data?)",
            stacklevel=2,
        )

    ids_opt = opts.pop("ids", None)
    ids = [str(i) for i in (ids_opt if ids_opt is not None else range(n))]
    if len(ids) != n:
        raise ValueError("ids must have one entry per point")

    def pick(v: Any) -> Any:
        if v is None:
            return None
        if isinstance(v, Mapping):  # dict of columns
            return {k: [list(col)[i] for i in idx] for k, col in v.items()}
        if hasattr(v, "iloc"):  # pandas
            return v.iloc[idx]
        vals = list(v)
        return [vals[i] for i in idx]

    per_item = {k: pick(opts.pop(k)) for k in ("attrs", "required", "groups", "keep_with", "svg_ids", "item_placement") if k in opts}
    for k in ("priority", "tiers"):
        v = opts.get(k)
        if v is not None and not isinstance(v, (str, Mapping, la.Priority)) and not callable(v):
            vals = list(v)
            if len(vals) == n and all(t is None or isinstance(t, (int, float)) or hasattr(t, "item") for t in vals):
                opts[k] = [vals[i] for i in idx]

    user_marks = opts.pop("marks", None)
    if user_marks is not None:
        marks = pick([user_marks] * n if isinstance(user_marks, Mapping) else user_marks)
    else:
        if marker_size is None:
            import matplotlib as mpl

            marker_size = float(mpl.rcParams["lines.markersize"]) ** 2
        sizes = np.broadcast_to(np.asarray(marker_size, dtype=float), (n,))
        marks = [la.Mark.circle(math.sqrt(max(float(sizes[i]), 0.0)) / 2.0 * dpi / 72.0) for i in idx]

    font_px = _font_px(fontsize, dpi)
    measure_fn: Any = None
    if measure is True:
        measure_fn = text_measure(fig, snap.renderer)
    elif callable(measure):
        measure_fn = measure

    vector = list(opts.pop("vector", None) or [])
    if avoid_texts and snap.text_rects:
        vector.append({"class": "text", "rects": snap.text_rects})
    avoid: Dict[str, Any] = {}
    if snap.legend_rects:
        vector.append({"class": "legend", "rects": snap.legend_rects})
        avoid = {"label": {"legend": "hard"}}
    user_avoid = opts.pop("avoid", None)
    if user_avoid is not None:
        merge(avoid, avoid_dict(user_avoid))

    place_opts: Dict[str, Any] = dict(snap.options)
    if explicit_bg is not None:
        place_opts["background"] = explicit_bg
    elif snap.background is not None:
        place_opts["background"] = snap.background
    for k in ("background_options", "svg_classes", "region"):
        if k in opts:
            place_opts[k] = opts.pop(k)
    place_opts.update(
        font_size=font_px,
        font_family=fontfamily,
        font_weight=fontweight,
        font_style="italic" if fontstyle in ("italic", "oblique") else None,
        preset=preset,
        vector=vector or None,
        avoid=avoid or None,
        measure=measure_fn,
    )
    place_opts.update(opts)
    res = la.place(
        [tuple(canvas_xy[i]) for i in idx],
        [label_list[i] for i in idx],
        ids=[ids[i] for i in idx],
        marks=marks,
        **per_item,
        **place_opts,
    )
    texts: List[Text] = []
    leaders: List[Line2D] = []
    if draw:
        texts, leaders = _draw(ax, res, frame, dpi, fontfamily, fontweight, fontstyle, text_kw, leader_kw)
    _refresh(fig)
    return MatplotlibLabels(res, texts, leaders)


def _axis_units(axis: Any, v: Any) -> Any:
    """Values in the units of an axis (dates, categories, ... through its unit converter);
    one-shot iterators become a list first, as the converters look at the values twice."""
    return axis.convert_units(list(v) if isinstance(v, Iterator) else v)


def _label_aligns(res: la.Result) -> Dict[str, str]:
    out: Dict[str, str] = {}
    items = (res.problem or {}).get("items", [])
    for i, it in enumerate(items):
        align = it.get("label", {}).get("align")
        if align:
            out[str(it.get("id", i))] = str(align)
    return out


def _draw(
    ax: Axes,
    res: la.Result,
    frame: Frame,
    dpi: float,
    fontfamily: Optional[str],
    fontweight: Union[int, str, None],
    fontstyle: Optional[str],
    text_kw: Optional[Mapping[str, Any]],
    leader_kw: Optional[Mapping[str, Any]],
) -> Tuple[List[Text], List[Line2D]]:
    inv = ax.transData.inverted()
    aligns = _label_aligns(res)
    texts: List[Text] = []
    leaders: List[Line2D] = []
    tkw: Dict[str, Any] = {"zorder": 3, "clip_on": False}
    tkw.update(text_kw or {})
    lkw: Dict[str, Any] = {"color": "0.35", "linewidth": 0.6, "zorder": 2.5, "clip_on": False}
    lkw.update(leader_kw or {})

    def to_data(pts: Any) -> Any:
        return inv.transform(frame.to_display(pts))

    def add_text(box: la.BBox, info: Mapping[str, Any], align: str) -> None:
        lines = list(info.get("lines", []))
        offsets = list(info.get("baseline_offsets", []))
        x_off = float(info.get("x_offset", 0.0))
        size_pt = float(info.get("font_size", 12.0)) * 72.0 / dpi
        family = info.get("font_family") or fontfamily
        if family in ("default", ""):
            family = fontfamily
        weight = info.get("font_weight") or fontweight
        for line, off in zip(lines, offsets):
            if align == "center":
                cx, ha = box.x + box.w / 2.0, "center"
            elif align == "end":
                cx, ha = box.x + box.w - x_off, "right"
            else:
                cx, ha = box.x + x_off, "left"
            (dx, dy), = to_data([[cx, box.y + float(off)]])
            kw = dict(tkw)
            kw.setdefault("fontsize", size_pt)
            if family:
                kw.setdefault("fontfamily", family)
            if weight is not None:
                kw.setdefault("fontweight", weight)
            if fontstyle:
                kw.setdefault("fontstyle", fontstyle)
            t = ax.text(dx, dy, line, ha=ha, va="baseline", **kw)
            t.set_in_layout(False)
            texts.append(t)

    def add_line(pts: Sequence[Tuple[float, float]]) -> None:
        if len(pts) < 2:
            return
        d = to_data(pts)
        ln = Line2D(d[:, 0], d[:, 1], **lkw)
        ln.set_in_layout(False)
        ax.add_artist(ln)
        leaders.append(ln)

    for p in res.placed:
        if p.box is None:
            continue
        align = aligns.get(p.id, "start")
        if p.text:
            add_text(p.box, p.text, align)
        for part in p.parts:
            b, info = part.get("box"), part.get("text")
            if b and info:
                add_text(la.BBox(b["x"], b["y"], b["w"], b["h"]), info, "start")
        for ld in p.all_leaders:
            add_line(ld.points)
            if ld.underline:
                add_line(ld.underline)
    return texts, leaders
