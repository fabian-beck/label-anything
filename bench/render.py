"""The benchmark renderer: problem + result (+ background) → SVG and/or PNG.

The same renderer is used for every implementation and baseline in the report:

* background: the problem's raster sources (embedded images), its SVG sources
  (embedded as an image in SVG output; for PNG output a pre-rendered
  ``<config>.bg.png`` next to the problem is used when present), and the vector
  obstacle layers (light grey),
* item marks with their true shapes (circles, ellipses, rotated/rounded rects,
  polygons, paths, icons; area anchors dashed), in the item's data color when its
  ``attrs.color`` is a ``#rrggbb`` string (a region, a series, a community), else blue,
* labels: box outline and text drawn at the reported baselines and x offsets,
  font Noto Sans from ``fonts/`` (PNG: glyphs positioned with the same GPOS
  kerning as the measurement, so drawn text matches the reported boxes),
* leaders (polylines, underlines) and unplaced items as red ×,
* with ``marks`` (``evaluate(..., marks=True)["marks"]``), the violations the evaluator counts,
  drawn over the result (``VIOLATIONS``): conflicts in red (the area two labels share, the
  outline of a label over a mark, an obstacle or the canvas edge, a leader through a label or a
  mark, a ring where leaders cross), ambiguous labels in orange (outlined, with a line to the
  point a label may be taken for: solid where that point is nearer than its own, dashed where it
  is about as near), covered data points with a magenta ring, and labels too close to each
  other in purple (a line across the gap; leaders too close to another leader or a mark
  dashed).

``standalone_svg`` draws the same picture as one self-contained vector image (the gallery's
images): SVG backgrounds inlined, raster backgrounds embedded, the label text set in a subset
of Noto Sans embedded in the file, every glyph at the pen position of the measurement.

    python bench/render.py problem.json result.json -o out.svg [--png out.png] [--standalone] [--violations]
"""
from __future__ import annotations

import argparse
import base64
import io
import functools
import math
import re
import sys
from pathlib import Path
from xml.sax.saxutils import escape

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

from bench.common import text as textmod  # noqa: E402
from bench.common.geom import Circle, Ellipse, Polygon, RoundedRect  # noqa: E402
from bench.common.jsonio import read_json  # noqa: E402
from bench.common.model import load_problem, raster_bytes  # noqa: E402

MARK_FILL = "#7aa6d8"
MARK_STROKE = "#2c5d8f"
LABEL_FILL_OPACITY = 0.75
"""Label boxes: white at this opacity, no outline; label text and icons black (no colors)."""
LABEL_TEXT = "#000000"
LEADER = "#333333"
OBST = "#b8b8b8"
UNPLACED = "#d62728"
CONFLICT = "#e31a1c"
AMBIGUOUS = "#ff7f00"
COVERED = "#c51b7d"
CLOSE = "#6a3d9a"
MARK_W = 1.5
"""Stroke width of the violation marks (px of the canvas)."""
RING_W = 1.0
"""Stroke width of the rings around covered points (often many: thinner)."""
VIOLATIONS = [
    ("conflict", CONFLICT, "conflict: overlapping labels (filled); label over a mark, an obstacle or the canvas "
                           "edge (outlined); leader through a label or a mark; crossing leaders (ring)"),
    ("ambiguous", AMBIGUOUS, "ambiguous label (outlined), with a line to the competing data point: solid if that "
                             "point is nearer than the label's own (misattributed); dashed if it is less than 0.2 em "
                             "farther (unclear), also for labels with leaders"),
    ("covered", COVERED, "data point covered by the label of another item"),
    ("close", CLOSE, "labels less than 0.4 em apart (line across the gap; dot where they touch); leader within the "
                     "clearance of another leader or a mark (dashed)"),
]
"""The violation marks: key, color and meaning (for the legends of the report and the gallery)."""


def violation_icon(key: str) -> str:
    """A small inline SVG of the violation mark ``key`` of ``VIOLATIONS``, on a grey ground, for legends."""
    box = 'fill="#ffffff" fill-opacity="0.9"'
    dot = f'fill="{MARK_FILL}" stroke="{MARK_STROKE}" stroke-width="0.8"'
    body = {
        "conflict": (f'<rect x="3" y="3" width="22" height="9" {box} stroke="{CONFLICT}" stroke-width="{MARK_W}"/>'
                     f'<rect x="17" y="7" width="24" height="8" {box} stroke="{CONFLICT}" stroke-width="{MARK_W}"/>'
                     f'<rect x="17" y="7" width="8" height="5" fill="{CONFLICT}" fill-opacity="0.45"/>'),
        "ambiguous": (f'<circle cx="6" cy="9" r="3" {dot}/><rect x="10" y="4" width="20" height="10" {box} '
                      f'stroke="{AMBIGUOUS}" stroke-width="{MARK_W}" stroke-dasharray="3 2"/>'
                      f'<circle cx="38" cy="9" r="3" {dot}/>'
                      f'<line x1="30" y1="9" x2="38" y2="9" stroke="{AMBIGUOUS}" stroke-width="{MARK_W}" '
                      f'stroke-dasharray="3 2"/><circle cx="38" cy="9" r="2" fill="{AMBIGUOUS}"/>'),
        "covered": (f'<circle cx="30" cy="10" r="3" {dot}/><rect x="6" y="4" width="26" height="10" {box}/>'
                    f'<circle cx="30" cy="10" r="4.5" fill="none" stroke="{COVERED}" stroke-width="{RING_W}"/>'),
        "close": (f'<rect x="2" y="4" width="16" height="10" {box}/><rect x="26" y="4" width="16" height="10" {box}/>'
                  f'<line x1="18" y1="9" x2="26" y2="9" stroke="{CLOSE}" stroke-width="{MARK_W}"/>'),
    }[key]
    return (f'<svg width="44" height="18" viewBox="0 0 44 18" aria-hidden="true"><rect width="44" height="18" '
            f'fill="{OBST}"/>{body}</svg>')


_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def mark_color(it) -> str | None:
    """The item's data color (``attrs.color``, ``#rrggbb``), or None."""
    c = (it.attrs or {}).get("color")
    return c if isinstance(c, str) and _HEX.match(c) else None


def _darker(c: str, f: float = 0.62) -> str:
    """``c`` scaled towards black (mark outlines of colored marks)."""
    r, g, b = (int(c[k:k + 2], 16) for k in (1, 3, 5))
    return "#{:02x}{:02x}{:02x}".format(round(r * f), round(g * f), round(b * f))


def _fmt(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def _pts(pts) -> str:
    return " ".join(f"{_fmt(x)},{_fmt(y)}" for x, y in pts)


def _shape_svg(shp, fill: str, stroke: str, opacity: float = 0.55, dash: str | None = None) -> str:
    da = f' stroke-dasharray="{dash}"' if dash else ""
    style = f'fill="{fill}" fill-opacity="{opacity}" stroke="{stroke}" stroke-width="0.8"{da}'
    if isinstance(shp, Circle):
        return f'<circle cx="{_fmt(shp.cx)}" cy="{_fmt(shp.cy)}" r="{_fmt(max(shp.r, 0.6))}" {style}/>'
    if isinstance(shp, Ellipse):
        return (f'<ellipse cx="{_fmt(shp.cx)}" cy="{_fmt(shp.cy)}" rx="{_fmt(shp.rx)}" ry="{_fmt(shp.ry)}" '
                f'transform="rotate({_fmt(shp.rotation)} {_fmt(shp.cx)} {_fmt(shp.cy)})" {style}/>')
    if isinstance(shp, RoundedRect) and shp.ref == (shp.cx, shp.cy):
        return (f'<rect x="{_fmt(shp.cx - shp.w / 2)}" y="{_fmt(shp.cy - shp.h / 2)}" width="{_fmt(shp.w)}" '
                f'height="{_fmt(shp.h)}" rx="{_fmt(shp.cr)}" '
                f'transform="rotate({_fmt(shp.rotation)} {_fmt(shp.cx)} {_fmt(shp.cy)})" {style}/>')
    d = " ".join("M" + " L".join(f"{_fmt(x)} {_fmt(y)}" for x, y in r) + " Z" for r in shp.rings())
    return f'<path d="{d}" fill-rule="evenodd" {style}/>'


def _line_starts(t: dict) -> list[float]:
    """Where each line of a text layout starts, relative to the box: ``x_offsets`` (the lines
    aligned per ``align``), or the text block's left edge for results without them."""
    xs = t.get("x_offsets")
    if xs is None:
        return [t.get("x_offset", 0.0)] * len(t.get("lines", []))
    return list(xs)


def _text_svg(x0: float, y0: float, t: dict, color: str = LABEL_TEXT) -> list[str]:
    out = []
    size = t.get("font_size", 12)
    weight = t.get("font_weight", 400)
    for line, base, xo in zip(t.get("lines", []), t.get("baseline_offsets", []), _line_starts(t)):
        out.append(f'<text x="{_fmt(x0 + xo)}" y="{_fmt(y0 + base)}" font-size="{_fmt(size)}" '
                   f'font-weight="{weight}" fill="{color}">{escape(line)}</text>')
    return out


def _background_items(problem: dict, bg_svg_path: Path | None) -> list[str]:
    out = []
    obs = problem.get("obstacles") or {}
    rasters = obs.get("raster")
    for r in ([rasters] if isinstance(rasters, dict) else (rasters or [])):
        data = raster_bytes(r)
        if data is None:
            continue
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            fmt = (im.format or "PNG").lower()
        s = float(r.get("scale", 1))
        off = r.get("offset", [0, 0])
        mime = "image/jpeg" if fmt in ("jpeg", "jpg") else f"image/{fmt}"
        out.append(f'<image x="{_fmt(off[0])}" y="{_fmt(off[1])}" width="{_fmt(w / s)}" height="{_fmt(h / s)}" '
                   f'href="data:{mime};base64,{base64.b64encode(data).decode()}"/>')
    svgs = obs.get("svg")
    for s in ([svgs] if isinstance(svgs, dict) else (svgs or [])):
        src = s.get("source")
        if src is None and s.get("path"):
            src = Path(s["path"]).read_text(encoding="utf-8")
        if src:
            out.append(f'<image x="0" y="0" width="100%" height="100%" '
                       f'href="data:image/svg+xml;base64,{base64.b64encode(src.encode()).decode()}"/>')
    return out


def _box_point(b: dict, q) -> tuple[float, float]:
    """The point of the box ``b`` (``x, y, w, h``) nearest to ``q``."""
    return (min(max(q[0], b["x"]), b["x"] + b["w"]), min(max(q[1], b["y"]), b["y"] + b["h"]))


def _leader_lines(p: dict | None) -> list:
    if not p:
        return []
    return [L["points"] for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or [])]


def _marks_svg(marks: dict | None, by_id: dict) -> list[str]:
    """The violations of ``marks`` (``evaluate(..., marks=True)["marks"]``) as one SVG group, drawn over
    the result: too close, covered, ambiguous, then the conflicts on top (``VIOLATIONS``)."""
    if not marks:
        return []
    o = [f'<g class="violations" fill="none" stroke-width="{MARK_W}" stroke-linecap="round" '
         f'stroke-linejoin="round">']
    for x0, y0, x1, y1 in marks.get("close", []):
        if math.hypot(x1 - x0, y1 - y0) < 1.0:
            o.append(f'<circle cx="{_fmt(x0)}" cy="{_fmt(y0)}" r="1.5" fill="{CLOSE}" stroke="none"/>')
        else:
            o.append(f'<line x1="{_fmt(x0)}" y1="{_fmt(y0)}" x2="{_fmt(x1)}" y2="{_fmt(y1)}" stroke="{CLOSE}"/>')
    for lid in marks.get("tight_leaders", []):
        for pts in _leader_lines(by_id.get(lid)):
            o.append(f'<polyline points="{_pts(pts)}" stroke="{CLOSE}" stroke-dasharray="3 2"/>')
    for c in marks.get("covered", []):
        x, y = c["point"]
        o.append(f'<circle cx="{_fmt(x)}" cy="{_fmt(y)}" r="{_fmt(max(c["r"] + 1.5, 3))}" stroke="{COVERED}" '
                 f'stroke-width="{RING_W}"/>')
    for a in marks.get("ambiguous", []):
        p = by_id.get(a["label"])
        if not p or "box" not in p:
            continue
        b = p["box"]
        (x0, y0), (x1, y1) = _box_point(b, a["point"]), a["point"]
        dash = "" if a["level"] == "misattributed" else ' stroke-dasharray="4 2"'
        o.append(f'<rect x="{_fmt(b["x"])}" y="{_fmt(b["y"])}" width="{_fmt(b["w"])}" height="{_fmt(b["h"])}" '
                 f'stroke="{AMBIGUOUS}"{dash}/>'
                 f'<line x1="{_fmt(x0)}" y1="{_fmt(y0)}" x2="{_fmt(x1)}" y2="{_fmt(y1)}" stroke="{AMBIGUOUS}"{dash}/>'
                 f'<circle cx="{_fmt(x1)}" cy="{_fmt(y1)}" r="2" fill="{AMBIGUOUS}" stroke="none"/>')
    for x0, y0, x1, y1 in marks.get("overlaps", []):
        o.append(f'<rect x="{_fmt(x0)}" y="{_fmt(y0)}" width="{_fmt(x1 - x0)}" height="{_fmt(y1 - y0)}" '
                 f'fill="{CONFLICT}" fill-opacity="0.45" stroke="none"/>')
    for lid in marks.get("labels", []):
        b = (by_id.get(lid) or {}).get("box")
        if b:
            o.append(f'<rect x="{_fmt(b["x"])}" y="{_fmt(b["y"])}" width="{_fmt(b["w"])}" height="{_fmt(b["h"])}" '
                     f'stroke="{CONFLICT}"/>')
    for lid in marks.get("leaders", []):
        for pts in _leader_lines(by_id.get(lid)):
            o.append(f'<polyline points="{_pts(pts)}" stroke="{CONFLICT}"/>')
    for x, y in marks.get("crossings", []):
        o.append(f'<circle cx="{_fmt(x)}" cy="{_fmt(y)}" r="4" stroke="{CONFLICT}"/>')
    o.append("</g>")
    return o


def render_svg(problem: dict, result: dict, font_href: str | None = None, title: str | None = None,
               show_obstacles: bool = True, marks: dict | None = None) -> str:
    prob = load_problem(problem)
    W = prob.width or 800
    H = prob.height or 600
    by_id = {p["id"]: p for p in result.get("placements", [])}
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{_fmt(W)}" height="{_fmt(H)}" '
         f'viewBox="0 0 {_fmt(W)} {_fmt(H)}">']
    ff = "'Noto Sans', 'Noto Sans Bench', sans-serif"
    css = f"text{{font-family:{ff};white-space:pre}}"
    if font_href:
        css = (f"@font-face{{font-family:'Noto Sans Bench';src:url('{font_href}')}}"
               f"text{{font-family:'Noto Sans Bench', sans-serif;white-space:pre}}")
    o.append(f"<style>{css}</style>")
    if title:
        o.append(f"<title>{escape(title)}</title>")
    o.append(f'<rect width="{_fmt(W)}" height="{_fmt(H)}" fill="#ffffff"/>')
    o += _background_items(problem, None)
    if show_obstacles:
        o.append(f'<g class="obstacles" fill="{OBST}" stroke="{OBST}" fill-opacity="0.6">')
        for cls, prims in sorted(prob.vectors.items()):
            for p in prims:
                if p.kind == "polyline":
                    o.append(f'<polyline points="{_pts(p.points)}" fill="none" stroke-width="{_fmt(max(p.width, 0.5))}"/>')
                elif isinstance(p.shape, Circle):
                    o.append(f'<circle cx="{_fmt(p.shape.cx)}" cy="{_fmt(p.shape.cy)}" r="{_fmt(max(p.shape.r, 0.5))}" stroke="none"/>')
                else:
                    o.append(_shape_svg(p.shape, OBST, OBST, 0.35))
        o.append("</g>")
    o.append('<g class="marks">')
    for it in prob.items:
        if it.anchor_type == "area":
            o.append(_shape_svg(it.area, MARK_FILL, MARK_STROKE, 0.12, dash="4 3"))
        else:
            c = mark_color(it)
            o.append(_shape_svg(it.shape, c, _darker(c), 0.75) if c else _shape_svg(it.shape, MARK_FILL, MARK_STROKE))
    o.append("</g>")
    o.append(f'<g class="leaders" fill="none" stroke="{LEADER}" stroke-width="1">')
    for it in prob.items:
        p = by_id.get(it.id)
        if not p or not p.get("placed"):
            continue
        for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or []):
            o.append(f'<polyline points="{_pts(L["points"])}"/>')
            if L.get("underline"):
                o.append(f'<polyline points="{_pts(L["underline"])}"/>')
    o.append("</g>")
    o.append('<g class="labels">')
    for it in prob.items:
        p = by_id.get(it.id)
        if not p or not p.get("placed") or "box" not in p:
            continue
        b = p["box"]
        o.append(f'<rect x="{_fmt(b["x"])}" y="{_fmt(b["y"])}" width="{_fmt(b["w"])}" height="{_fmt(b["h"])}" '
                 f'fill="#ffffff" fill-opacity="{LABEL_FILL_OPACITY}"/>')
        if p.get("text"):
            o += _text_svg(b["x"], b["y"], p["text"])
        for part in p.get("parts") or []:
            pb = part["box"]
            if part.get("text"):
                o += _text_svg(pb["x"], pb["y"], part["text"])
            elif part.get("type") in ("icon", "box"):
                o.append(f'<rect x="{_fmt(pb["x"])}" y="{_fmt(pb["y"])}" width="{_fmt(pb["w"])}" '
                         f'height="{_fmt(pb["h"])}" rx="{_fmt(min(pb["w"], pb["h"]) / 4)}" fill="{LABEL_TEXT}" '
                         f'fill-opacity="0.5"/>')
    o.append("</g>")
    o.append(f'<g class="unplaced" stroke="{UNPLACED}" stroke-width="1.2">')
    for it in prob.items:
        p = by_id.get(it.id)
        if p is not None and not p.get("placed"):
            x, y = it.ref
            o.append(f'<path d="M{_fmt(x - 3)} {_fmt(y - 3)} L{_fmt(x + 3)} {_fmt(y + 3)} '
                     f'M{_fmt(x - 3)} {_fmt(y + 3)} L{_fmt(x + 3)} {_fmt(y - 3)}"/>')
    o.append("</g>")
    o += _marks_svg(marks, by_id)
    o.append("</svg>")
    return "\n".join(o) + "\n"


# ---------------------------------------------------------------------------
# PNG (Pillow)
# ---------------------------------------------------------------------------
def _dashed(dr: ImageDraw.ImageDraw, pts: list, fill, width: int, dash: tuple[float, float]) -> None:
    """A polyline (pixel coordinates) drawn in dashes of ``dash = (on, off)`` pixels."""
    on, off = dash
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        n = math.hypot(x1 - x0, y1 - y0)
        if n <= 0:
            continue
        ux, uy = (x1 - x0) / n, (y1 - y0) / n
        t = 0.0
        while t < n:
            e = min(t + on, n)
            dr.line([(x0 + ux * t, y0 + uy * t), (x0 + ux * e, y0 + uy * e)], fill=fill, width=width)
            t += on + off


def _marks_png(size: tuple[int, int], marks: dict, by_id: dict, s: float) -> Image.Image:
    """The violations of ``marks`` on a transparent layer of ``size`` at scale ``s`` (as ``_marks_svg``)."""
    layer = Image.new("RGBA", size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(layer)
    w = max(1, int(round(MARK_W * s)))

    def ring(x, y, r, color, width=w):
        dr.ellipse([(x - r) * s, (y - r) * s, (x + r) * s, (y + r) * s], outline=_hex(color), width=width)

    def dot(x, y, r, color):
        dr.ellipse([(x - r) * s, (y - r) * s, (x + r) * s, (y + r) * s], fill=_hex(color))

    def line(pts, color, dash=None):
        px = [(x * s, y * s) for x, y in pts]
        if dash:
            _dashed(dr, px, _hex(color), w, (dash[0] * s, dash[1] * s))
        else:
            dr.line(px, fill=_hex(color), width=w, joint="curve")

    for x0, y0, x1, y1 in marks.get("close", []):
        if math.hypot(x1 - x0, y1 - y0) < 1.0:
            dot(x0, y0, 1.5, CLOSE)
        else:
            line([(x0, y0), (x1, y1)], CLOSE)
    for lid in marks.get("tight_leaders", []):
        for pts in _leader_lines(by_id.get(lid)):
            line(pts, CLOSE, (3, 2))
    for c in marks.get("covered", []):
        ring(c["point"][0], c["point"][1], max(c["r"] + 1.5, 3), COVERED, max(1, int(round(RING_W * s))))
    for a in marks.get("ambiguous", []):
        p = by_id.get(a["label"])
        if not p or "box" not in p:
            continue
        b = p["box"]
        dash = None if a["level"] == "misattributed" else (4, 2)
        x0, y0, x1, y1 = b["x"], b["y"], b["x"] + b["w"], b["y"] + b["h"]
        line([(x0, y0), (x1, y0), (x1, y1), (x0, y1), (x0, y0)], AMBIGUOUS, dash)
        line([_box_point(b, a["point"]), a["point"]], AMBIGUOUS, dash)
        dot(a["point"][0], a["point"][1], 2, AMBIGUOUS)
    fills = Image.new("RGBA", size, (0, 0, 0, 0))
    fd = ImageDraw.Draw(fills)
    for x0, y0, x1, y1 in marks.get("overlaps", []):
        fd.rectangle([x0 * s, y0 * s, x1 * s, y1 * s], fill=_hex(CONFLICT, round(255 * 0.45)))
    layer.alpha_composite(fills)
    dr = ImageDraw.Draw(layer)
    for lid in marks.get("labels", []):
        b = (by_id.get(lid) or {}).get("box")
        if b:
            dr.rectangle([b["x"] * s, b["y"] * s, (b["x"] + b["w"]) * s, (b["y"] + b["h"]) * s],
                         outline=_hex(CONFLICT), width=w)
    for lid in marks.get("leaders", []):
        for pts in _leader_lines(by_id.get(lid)):
            line(pts, CONFLICT)
    for x, y in marks.get("crossings", []):
        ring(x, y, 4, CONFLICT)
    return layer


_FONT_CACHE: dict[tuple[int, float], ImageFont.FreeTypeFont] = {}


def _pil_font(weight: int, size: float) -> ImageFont.FreeTypeFont:
    key = (700 if weight >= 550 else 400, round(size, 2))
    if key not in _FONT_CACHE:
        _FONT_CACHE[key] = ImageFont.truetype(textmod.font_file(key[0]), size=key[1])
    return _FONT_CACHE[key]


def _draw_text(dr: ImageDraw.ImageDraw, x0: float, y0: float, t: dict, s: float) -> None:
    size = t.get("font_size", 12)
    weight = int(t.get("font_weight", 400))
    f = textmod.font(weight)
    pf = _pil_font(weight, size * s)
    for line, base, xo in zip(t.get("lines", []), t.get("baseline_offsets", []), _line_starts(t)):
        pos = f.pen_positions(line, size)
        for ch, px in zip(line, pos):
            if ch == " ":
                continue
            dr.text(((x0 + xo + px) * s, (y0 + base) * s), ch, font=pf, fill=_hex(LABEL_TEXT), anchor="ls")


def _shape_png(dr: ImageDraw.ImageDraw, shp, s: float, fill, outline) -> None:
    if isinstance(shp, Circle):
        r = max(shp.r, 0.6) * s
        dr.ellipse([shp.cx * s - r, shp.cy * s - r, shp.cx * s + r, shp.cy * s + r], fill=fill, outline=outline)
        return
    rings = shp.rings()
    for k, ring in enumerate(rings):
        pts = [(x * s, y * s) for x, y in ring]
        if len(pts) >= 3:
            hole = getattr(shp, "has_holes", False) and k > 0
            dr.polygon(pts, fill=None if hole else fill, outline=outline)


def _hex(c: str, a: int = 255):
    c = c.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), a)


def render_png(problem: dict, result: dict, background_png: str | Path | None = None, scale: float = 1.0,
               supersample: int = 2, show_obstacles: bool | str = "auto", marks: dict | None = None) -> Image.Image:
    """``show_obstacles``: True / False, or "auto" = draw vector layers only without a background image;
    ``marks``: the violations to draw over the result (``evaluate(..., marks=True)["marks"]``)."""
    prob = load_problem(problem)
    W = prob.width or 800
    H = prob.height or 600
    s = scale * supersample
    img = Image.new("RGBA", (int(math.ceil(W * s)), int(math.ceil(H * s))), (255, 255, 255, 255))
    obs = problem.get("obstacles") or {}
    rasters = obs.get("raster")
    for r in ([rasters] if isinstance(rasters, dict) else (rasters or [])):
        data = raster_bytes(r)
        if data is None:
            continue
        with Image.open(io.BytesIO(data)) as im:
            rs = float(r.get("scale", 1))
            off = r.get("offset", [0, 0])
            tw, th = int(round(im.size[0] / rs * s)), int(round(im.size[1] / rs * s))
            layer = im.convert("RGBA").resize((max(tw, 1), max(th, 1)), Image.BILINEAR)
            img.alpha_composite(layer, (int(round(off[0] * s)), int(round(off[1] * s))))
    has_bg = bool(rasters)
    if background_png and Path(background_png).exists():
        has_bg = True
        with Image.open(background_png) as im:
            layer = im.convert("RGBA").resize(img.size, Image.BILINEAR)
            img.alpha_composite(layer)
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(over)
    if show_obstacles is True or (show_obstacles == "auto" and not has_bg):
        for cls, prims in sorted(prob.vectors.items()):
            for p in prims:
                if p.kind == "polyline":
                    dr.line([(x * s, y * s) for x, y in p.points], fill=_hex(OBST, 200),
                            width=max(1, int(round(max(p.width, 0.5) * s))))
                else:
                    _shape_png(dr, p.shape, s, _hex(OBST, 150), None)
    for it in prob.items:
        if it.anchor_type == "area":
            _shape_png(dr, it.area, s, _hex(MARK_FILL, 30), _hex(MARK_STROKE, 160))
        else:
            c = mark_color(it)
            _shape_png(dr, it.shape, s, _hex(c or MARK_FILL, 190 if c else 150),
                       _hex(_darker(c) if c else MARK_STROKE))
    img.alpha_composite(over)
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(over)
    by_id = {p["id"]: p for p in result.get("placements", [])}
    for it in prob.items:
        p = by_id.get(it.id)
        if not p or not p.get("placed"):
            continue
        for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or []):
            dr.line([(x * s, y * s) for x, y in L["points"]], fill=_hex(LEADER), width=max(1, int(round(s))))
            if L.get("underline"):
                dr.line([(x * s, y * s) for x, y in L["underline"]], fill=_hex(LEADER), width=max(1, int(round(s))))
    for it in prob.items:
        p = by_id.get(it.id)
        if not p or not p.get("placed") or "box" not in p:
            continue
        b = p["box"]
        dr.rectangle([b["x"] * s, b["y"] * s, (b["x"] + b["w"]) * s, (b["y"] + b["h"]) * s],
                     fill=(255, 255, 255, round(255 * LABEL_FILL_OPACITY)))
        for part in p.get("parts") or []:
            pb = part["box"]
            if not part.get("text") and part.get("type") in ("icon", "box"):
                dr.rounded_rectangle([pb["x"] * s, pb["y"] * s, (pb["x"] + pb["w"]) * s, (pb["y"] + pb["h"]) * s],
                                     radius=min(pb["w"], pb["h"]) / 4 * s, fill=_hex(LABEL_TEXT, 128))
    img.alpha_composite(over)
    dr = ImageDraw.Draw(img)
    for it in prob.items:
        p = by_id.get(it.id)
        if not p:
            continue
        if p.get("placed") and "box" in p:
            b = p["box"]
            if p.get("text"):
                _draw_text(dr, b["x"], b["y"], p["text"], s)
            for part in p.get("parts") or []:
                if part.get("text"):
                    _draw_text(dr, part["box"]["x"], part["box"]["y"], part["text"], s)
        elif not p.get("placed"):
            x, y = it.ref
            k = 3 * s
            dr.line([(x * s - k, y * s - k), (x * s + k, y * s + k)], fill=_hex(UNPLACED), width=max(1, int(1.2 * s)))
            dr.line([(x * s - k, y * s + k), (x * s + k, y * s - k)], fill=_hex(UNPLACED), width=max(1, int(1.2 * s)))
    if marks:
        img.alpha_composite(_marks_png(img.size, marks, by_id, s))
    if supersample > 1:
        img = img.resize((int(math.ceil(W * scale)), int(math.ceil(H * scale))), Image.LANCZOS)
    return img.convert("RGB")


# ---------------------------------------------------------------------------
# standalone SVG (the gallery)
# ---------------------------------------------------------------------------
FONT_FAMILY = "LA Noto Sans"
_SVG_TEXT = re.compile(r"<text\b[^>]*>([^<]*)</text>")
_SVG_HEAD = re.compile(r"^\s*(<\?xml[^>]*\?>\s*)?(<!DOCTYPE[^>]*>\s*)?", re.S)


@functools.lru_cache(maxsize=64)
def _font_face(weight: int, chars: str) -> str:
    """``@font-face`` rule with the glyphs of ``chars`` of the bundled Noto Sans (WOFF, data URL).
    Only the ``kern`` feature is kept: labels place every glyph themselves, background text is kerned."""
    from fontTools import subset
    from fontTools.ttLib import TTFont

    opts = subset.Options()
    opts.flavor = "woff"
    opts.layout_features = ["kern"]
    opts.hinting = False
    opts.desubroutinize = True
    font = TTFont(textmod.font_file(weight))
    sub = subset.Subsetter(opts)
    sub.populate(unicodes=sorted({ord(c) for c in chars} | {0x20}))
    sub.subset(font)
    buf = io.BytesIO()
    font.flavor = "woff"
    font.save(buf)
    url = "data:font/woff;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
    return (f"@font-face{{font-family:'{FONT_FAMILY}';src:url({url}) format('woff');"
            f"font-weight:{700 if weight >= 550 else 400};font-style:normal}}")


def _glyph_text(x0: float, y0: float, t: dict, color: str = LABEL_TEXT) -> list[str]:
    """The lines of a measured text, every character at its pen position (kerning as measured)."""
    out = []
    size = t.get("font_size", 12)
    weight = int(textmod.resolve_weight(t.get("font_weight", 400)))
    f = textmod.font(weight)
    wa = ' font-weight="700"' if weight >= 550 else ""
    for line, base, xo in zip(t.get("lines", []), t.get("baseline_offsets", []), _line_starts(t)):
        if not line:
            continue
        xs = " ".join(_fmt(x0 + xo + px) for px in f.pen_positions(line, size))
        out.append(f'<text x="{xs}" y="{_fmt(y0 + base)}" font-size="{_fmt(size)}"{wa} fill="{color}">'
                   f"{escape(line)}</text>")
    return out


def _texts(result: dict) -> list[dict]:
    out = []
    for p in result.get("placements", []):
        if p.get("placed") and p.get("text"):
            out.append(p["text"])
        for part in p.get("parts") or [] if p.get("placed") else []:
            if part.get("text"):
                out.append(part["text"])
    return out


def _inline_svg(src: str, w: float, h: float) -> str:
    """An SVG document as a nested ``<svg>`` element at the canvas origin, sized to the canvas."""
    body = _SVG_HEAD.sub("", src, count=1)
    m = re.match(r"<svg\b([^>]*)>", body)
    if m is None:
        return ""
    attrs = re.sub(r'\s(x|y|width|height)="[^"]*"', "", m.group(1))
    return f'<svg x="0" y="0" width="{_fmt(w)}" height="{_fmt(h)}"{attrs}>' + body[m.end():]


def standalone_svg(problem: dict, result: dict, background_svg: str | Path | None = None,
                   background_png: str | Path | None = None, title: str | None = None,
                   show_obstacles: bool | str = "auto", marks: dict | None = None) -> str:
    """One self-contained SVG of a result: the problem's background (its SVG sources inlined and its
    raster sources embedded; otherwise ``background_svg``, else ``background_png``), item marks,
    leaders, labels set in an embedded subset of Noto Sans, omitted items as red × and the
    violations of ``marks`` (``evaluate(..., marks=True)["marks"]``).
    ``show_obstacles``: draw the vector obstacle layers in grey — True, False, or "auto" = only when
    there is no background."""
    prob = load_problem(problem)
    W = prob.width or 800
    H = prob.height or 600
    by_id = {p["id"]: p for p in result.get("placements", [])}
    obs = problem.get("obstacles") or {}
    bg: list[str] = []
    rasters = obs.get("raster")
    for r in ([rasters] if isinstance(rasters, dict) else (rasters or [])):
        data = raster_bytes(r)
        if data is None:
            continue
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
            fmt = (im.format or "PNG").lower()
        sc = float(r.get("scale", 1))
        off = r.get("offset", [0, 0])
        mime = "image/jpeg" if fmt in ("jpeg", "jpg") else f"image/{fmt}"
        bg.append(f'<image x="{_fmt(off[0])}" y="{_fmt(off[1])}" width="{_fmt(w / sc)}" height="{_fmt(h / sc)}" '
                  f'preserveAspectRatio="none" href="data:{mime};base64,{base64.b64encode(data).decode()}"/>')
    svg_texts = []
    svgs = obs.get("svg")
    for sv in ([svgs] if isinstance(svgs, dict) else (svgs or [])):
        src = sv.get("source")
        if src is None and sv.get("path"):
            src = Path(sv["path"]).read_text(encoding="utf-8")
        if src:
            bg.append(_inline_svg(src, W, H))
            svg_texts.append(src)
    if not bg and background_svg and Path(background_svg).exists():
        src = Path(background_svg).read_text(encoding="utf-8")
        bg.append(_inline_svg(src, W, H))
        svg_texts.append(src)
    elif not bg and background_png and Path(background_png).exists():
        with Image.open(background_png) as im:
            buf = io.BytesIO()
            im.save(buf, "PNG", optimize=True)
        bg.append(f'<image x="0" y="0" width="{_fmt(W)}" height="{_fmt(H)}" preserveAspectRatio="none" '
                  f'href="data:image/png;base64,{base64.b64encode(buf.getvalue()).decode()}"/>')
    # fonts: the glyphs of the labels and of the background's text, per weight
    chars: dict[int, set[str]] = {}
    for t in _texts(result):
        w = 700 if textmod.resolve_weight(t.get("font_weight", 400)) >= 550 else 400
        chars.setdefault(w, set()).update("".join(t.get("lines", [])))
    for src in svg_texts:
        for m in _SVG_TEXT.finditer(src):
            heavy = re.search(r'font-weight="(bold|[6-9]\d\d)"', m.group(0))
            chars.setdefault(700 if heavy else 400, set()).update(
                m.group(1).replace("&lt;", "<").replace("&gt;", ">").replace("&amp;", "&"))
    faces = "".join(_font_face(w, "".join(sorted(cs))) for w, cs in sorted(chars.items()) if cs)
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{_fmt(W)}" height="{_fmt(H)}" '
         f'viewBox="0 0 {_fmt(W)} {_fmt(H)}">']
    if title:
        o.append(f"<title>{escape(title)}</title>")
    o.append(f"<style>{faces}text{{font-family:'{FONT_FAMILY}',sans-serif;white-space:pre}}</style>")
    o.append(f'<rect width="{_fmt(W)}" height="{_fmt(H)}" fill="#ffffff"/>')
    o += bg
    if show_obstacles is True or (show_obstacles == "auto" and not bg):
        o.append(f'<g class="obstacles" fill="{OBST}" stroke="{OBST}" fill-opacity="0.6">')
        for _cls, prims in sorted(prob.vectors.items()):
            for pr in prims:
                if pr.kind == "polyline":
                    o.append(f'<polyline points="{_pts(pr.points)}" fill="none" '
                             f'stroke-width="{_fmt(max(pr.width, 0.5))}"/>')
                elif isinstance(pr.shape, Circle):
                    o.append(f'<circle cx="{_fmt(pr.shape.cx)}" cy="{_fmt(pr.shape.cy)}" '
                             f'r="{_fmt(max(pr.shape.r, 0.5))}" stroke="none"/>')
                else:
                    o.append(_shape_svg(pr.shape, OBST, OBST, 0.35))
        o.append("</g>")
    o.append('<g class="marks">')
    for it in prob.items:
        if it.anchor_type == "area":
            o.append(_shape_svg(it.area, MARK_FILL, MARK_STROKE, 0.12, dash="4 3"))
        else:
            c = mark_color(it)
            o.append(_shape_svg(it.shape, c, _darker(c), 0.75) if c else _shape_svg(it.shape, MARK_FILL, MARK_STROKE))
    o.append("</g>")
    o.append(f'<g class="leaders" fill="none" stroke="{LEADER}" stroke-width="1" stroke-linejoin="round">')
    for it in prob.items:
        p = by_id.get(it.id)
        if not p or not p.get("placed"):
            continue
        for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or []):
            o.append(f'<polyline points="{_pts(L["points"])}"/>')
            if L.get("underline"):
                o.append(f'<polyline points="{_pts(L["underline"])}"/>')
    o.append("</g>")
    o.append('<g class="labels">')
    for it in prob.items:
        p = by_id.get(it.id)
        if not p or not p.get("placed") or "box" not in p:
            continue
        b = p["box"]
        o.append(f'<rect x="{_fmt(b["x"])}" y="{_fmt(b["y"])}" width="{_fmt(b["w"])}" height="{_fmt(b["h"])}" '
                 f'fill="#ffffff" fill-opacity="{LABEL_FILL_OPACITY}"/>')
        if p.get("text"):
            o += _glyph_text(b["x"], b["y"], p["text"])
        for part in p.get("parts") or []:
            pb = part["box"]
            if part.get("text"):
                o += _glyph_text(pb["x"], pb["y"], part["text"])
            elif part.get("type") in ("icon", "box"):
                o.append(f'<rect x="{_fmt(pb["x"])}" y="{_fmt(pb["y"])}" width="{_fmt(pb["w"])}" '
                         f'height="{_fmt(pb["h"])}" rx="{_fmt(min(pb["w"], pb["h"]) / 4)}" fill="{LABEL_TEXT}" '
                         f'fill-opacity="0.5"/>')
    o.append("</g>")
    o.append(f'<g class="unplaced" stroke="{UNPLACED}" stroke-width="1.2" stroke-linecap="round">')
    for it in prob.items:
        p = by_id.get(it.id)
        if p is not None and not p.get("placed"):
            x, y = it.ref
            o.append(f'<path d="M{_fmt(x - 3)} {_fmt(y - 3)} L{_fmt(x + 3)} {_fmt(y + 3)} '
                     f'M{_fmt(x - 3)} {_fmt(y + 3)} L{_fmt(x + 3)} {_fmt(y - 3)}"/>')
    o.append("</g>")
    o += _marks_svg(marks, by_id)
    o.append("</svg>")
    return "\n".join(o) + "\n"


def default_background_png(problem_path: Path) -> Path | None:
    stem = problem_path.name[:-len(".json")] if problem_path.name.endswith(".json") else problem_path.stem
    p = problem_path.with_name(stem + ".bg.png")
    return p if p.exists() else None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("result")
    ap.add_argument("-o", "--out", help="SVG output path")
    ap.add_argument("--png", help="PNG output path")
    ap.add_argument("--background", help="pre-rendered background PNG (default: <problem>.bg.png if present)")
    ap.add_argument("--scale", type=float, default=1.0, help="PNG scale factor")
    ap.add_argument("--font-href", help="URL of NotoSans-Regular.ttf for SVG @font-face")
    ap.add_argument("--no-obstacles", action="store_true", help="do not draw vector obstacle layers")
    ap.add_argument("--standalone", action="store_true",
                    help="-o writes a self-contained SVG (background inlined, font subset embedded)")
    ap.add_argument("--violations", action="store_true", help="mark the violations the evaluator counts")
    ap.add_argument("--truth", help="the scenario's truth.json (obstacle classes), for --violations")
    a = ap.parse_args(argv)
    problem, result = read_json(a.problem), read_json(a.result)
    marks = None
    if a.violations:
        from bench.eval import evaluate

        truth = read_json(a.truth) if a.truth else None
        marks = evaluate(problem, result, truth, removal_test=False, marks=True)["marks"]
    if not a.out and not a.png:
        ap.error("give -o OUT.svg and/or --png OUT.png")
    if a.out and a.standalone:
        pp = Path(a.problem)
        stem = pp.name[:-len(".json")] if pp.name.endswith(".json") else pp.stem
        Path(a.out).write_text(standalone_svg(problem, result, pp.with_name(stem + ".bg.svg"),
                                              a.background or default_background_png(pp),
                                              show_obstacles=False if a.no_obstacles else "auto", marks=marks),
                               encoding="utf-8")
    elif a.out:
        Path(a.out).write_text(render_svg(problem, result, a.font_href, show_obstacles=not a.no_obstacles,
                                          marks=marks), encoding="utf-8")
    if a.png:
        bg = a.background or default_background_png(Path(a.problem))
        render_png(problem, result, bg, a.scale, show_obstacles=False if a.no_obstacles else "auto",
                   marks=marks).save(a.png, optimize=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
