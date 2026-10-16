"""matplotlib set-up shared by the textalloc and adjustText adapters.

Coordinates. The figure is exactly the canvas: ``W/DPI × H/DPI`` inches at
``DPI = 72``, so one display pixel is one canvas px and one typographic point
(1/72 in) is one px. The axes cover the problem's label area (canvas minus
``canvas.padding``, or ``canvas.region``) and their data limits are that area
in canvas px with y flipped (``y_data = H − y_canvas``). Hence display
coordinates equal data coordinates, and "inside the axes" is "inside the label
area". y is flipped instead of inverting the axis because adjustText transforms
object bounding boxes corner by corner, which assumes increasing axes.

Text. Noto Sans from ``fonts/`` is registered with matplotlib and used for every
text; a font size of ``s`` px is ``s · 72 / DPI = s`` pt. matplotlib measures text
differently from spec §5 (no GPOS kerning, line height from the 'lp' glyph
extents, no label padding), so each tool is handed the problem's label box: the
``Text`` objects' window extent is the box (w × h, padding included) placed by
the text's alignment (``fix_extent``). The glyphs matplotlib would draw are never
used; the benchmark renderer draws every result.
"""
from __future__ import annotations

import os

from ..common import paths
from ..common.geom import Box

DPI = 72.0
_READY = False


def px_to_pt(px: float) -> float:
    """Font size in points for a size in canvas px (figure at ``DPI``)."""
    return px * 72.0 / DPI


def ensure_matplotlib():
    """Import matplotlib with the Agg backend and the bundled Noto Sans registered."""
    global _READY
    os.environ.setdefault("MPLBACKEND", "Agg")
    import matplotlib

    if not _READY:
        matplotlib.use("Agg", force=True)
        from matplotlib import font_manager

        for f in ("NotoSans-Regular.ttf", "NotoSans-Bold.ttf"):
            font_manager.fontManager.addfont(str(paths.FONTS / f))
        matplotlib.rcParams["font.family"] = "Noto Sans"
        matplotlib.rcParams["svg.fonttype"] = "none"
        _READY = True
    return matplotlib


class Canvas:
    """A figure of exactly the canvas size whose axes are the label area (display px == data)."""

    def __init__(self, width: float, height: float, area: Box):
        ensure_matplotlib()
        from matplotlib.backends.backend_agg import FigureCanvasAgg
        from matplotlib.figure import Figure

        self.W, self.H, self.area = float(width), float(height), area
        self.fig = Figure(figsize=(self.W / DPI, self.H / DPI), dpi=DPI)
        FigureCanvasAgg(self.fig)
        W, H = self.W, self.H
        self.ax = self.fig.add_axes((area.x0 / W, (H - area.y1) / H, area.w / W, area.h / H))
        self.ax.set_xlim(area.x0, area.x1)
        self.ax.set_ylim(H - area.y1, H - area.y0)
        self.ax.set_autoscale_on(False)
        self.ax.set_axis_off()

    # canvas (y down) <-> data / display (y up)
    def to_data(self, x: float, y: float) -> tuple[float, float]:
        return float(x), self.H - float(y)

    def to_canvas(self, xd: float, yd: float) -> tuple[float, float]:
        return float(xd), self.H - float(yd)

    def box_to_canvas(self, x0: float, y0: float, w: float, h: float) -> Box:
        """Box given by its lower-left corner (data/display, y up) and size -> canvas box."""
        return Box(x0, self.H - y0 - h, x0 + w, self.H - y0)

    def xlims(self) -> tuple[float, float]:
        return self.area.x0, self.area.x1

    def ylims(self) -> tuple[float, float]:
        return self.H - self.area.y1, self.H - self.area.y0

    def close(self) -> None:
        self.fig.clear()


H_OFF = {"left": 0.0, "center": 0.5, "right": 1.0}
V_OFF = {"bottom": 0.0, "baseline": 0.0, "center": 0.5, "center_baseline": 0.5, "top": 1.0}


def fix_extent(text, w: float, h: float) -> None:
    """Make ``text.get_window_extent()`` the label box (w × h display px) placed by the text's current
    position and alignment (left/center/right × bottom/baseline/center/top)."""
    from matplotlib.transforms import Bbox

    def extent(renderer=None, dpi=None):
        x, y = text.get_transform().transform(text.get_unitless_position())
        x0 = x - H_OFF.get(text.get_horizontalalignment(), 0.0) * w
        y0 = y - V_OFF.get(text.get_verticalalignment(), 0.0) * h
        return Bbox.from_bounds(x0, y0, w, h)

    text.get_window_extent = extent
    text.get_tightbbox = lambda renderer=None: extent()
    text._la_size = (w, h)
