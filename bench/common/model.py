"""Resolved view of a problem (spec §2–§5) for the evaluator, renderer and baselines.

``load_problem`` applies the effective options (defaults ← preset ← problem),
maps input coordinates to canvas pixels (``transform`` then ``y_axis``), builds
every item's true mark shape (spec §3.2), the normal-variant label box (§5) and
the vector obstacle primitives per class (§4).
"""
from __future__ import annotations

import base64
import io
import math
from dataclasses import dataclass, field
from typing import Any, Callable

import numpy as np

from . import geom, spec, text
from .geom import Box, Circle, Ellipse, Point, Polygon, RoundedRect, Shape

# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------


@dataclass
class LabelPart:
    kind: str
    x: float  # offset of the part box from the label box top-left
    y: float
    w: float
    h: float
    layout: text.TextLayout | None = None
    padding: float = 0.0


@dataclass
class LabelSpec:
    kind: str
    w: float
    h: float
    padding: float
    em: float
    font_size: float
    font_weight: int
    layout: text.TextLayout | None = None
    parts: list[LabelPart] = field(default_factory=list)
    has_wrap: bool = False
    text: str = ""
    raw: dict = field(default_factory=dict)


def _font_of(label_font: dict | None, defaults_font: dict) -> dict:
    f = dict(defaults_font or {})
    if label_font:
        f.update(label_font)
    return f


def resolve_label(label: dict, opts: dict, base_font: dict | None = None, part: bool = False) -> LabelSpec:
    d = opts.get("defaults", {})
    dfont = base_font if base_font is not None else d.get("font", {})
    kind = label.get("type", "text")
    f = _font_of(label.get("font"), dfont)
    size = float(f.get("size", 12))
    weight = text.resolve_weight(f.get("weight", 400))
    lh = float(f.get("line_height", 1.2))
    em = size
    if kind == "text":
        pad = spec.length(label.get("padding", d.get("padding", "0.15em")), em)
        wrap = label["wrap"] if "wrap" in label else d.get("wrap")
        trunc = label.get("truncate", d.get("truncate", "none"))
        if "width" in label and "height" in label:
            lines = label.get("lines") or [label.get("text", "")]
            lay = text.layout_lines(lines, size, weight, lh, ink=False)  # the host measured it
            lay.width = float(label["width"])
            lay.height = float(label["height"])
        else:
            # a text label's box fits its ink, a composite's text part spans ascent and descent
            lay = text.normal_variant(label.get("text", ""), size, weight, lh, wrap, trunc, em, ink=not part)
            lay.align = label.get("align", d.get("align", "center"))
        return LabelSpec("text", lay.width + 2 * pad, lay.height + 2 * pad, pad, em, size, weight, layout=lay,
                         has_wrap=bool(wrap) or "lines" in label, text=label.get("text", ""), raw=label)
    if kind in ("icon", "box"):
        pad = spec.length(label.get("padding", 0), em)
        w, h = float(label["width"]), float(label["height"])
        return LabelSpec(kind, w + 2 * pad, h + 2 * pad, pad, em, size, weight, raw=label)
    if kind == "composite":
        pad = spec.length(label.get("padding", d.get("padding", "0.15em")), em)
        gap = spec.length(label.get("gap", 0), em)
        direction = label.get("direction", "row")
        align = label.get("align", "center")
        parts = []
        for p in label["parts"]:
            pp = dict(p)
            pp.setdefault("padding", 0)
            ps = resolve_label(pp, opts, base_font=f, part=True)
            parts.append(ps)
        main = sum((p.w if direction == "row" else p.h) for p in parts) + gap * (len(parts) - 1)
        cross = max((p.h if direction == "row" else p.w) for p in parts)
        out_parts = []
        pos = pad
        for ps in parts:
            pc = ps.h if direction == "row" else ps.w
            off = {"start": 0.0, "center": (cross - pc) / 2, "end": cross - pc}[align]
            if direction == "row":
                out_parts.append(LabelPart(ps.kind, pos, pad + off, ps.w, ps.h, ps.layout, ps.padding))
                pos += ps.w + gap
            else:
                out_parts.append(LabelPart(ps.kind, pad + off, pos, ps.w, ps.h, ps.layout, ps.padding))
                pos += ps.h + gap
        w = (main if direction == "row" else cross) + 2 * pad
        h = (cross if direction == "row" else main) + 2 * pad
        txt = " ".join(p.raw.get("text", "") for p in parts if p.kind == "text")
        return LabelSpec("composite", w, h, pad, em, size, weight, parts=out_parts, text=txt, raw=label)
    raise ValueError(f"unknown label type {kind!r}")


# ---------------------------------------------------------------------------
# Items
# ---------------------------------------------------------------------------


@dataclass
class Item:
    index: int
    id: str
    anchor_type: str
    ref: Point
    shape: Shape | None          # mark (None for area anchors)
    area: Polygon | None         # area polygon (area anchors)
    dot: Shape | None            # fallback mark at the pole (area anchors)
    label: LabelSpec
    attrs: dict
    priority: float | None
    tier: int | None
    required: bool
    offset: float
    internal: str
    models: list
    position_order: Any
    raw: dict
    font_class: int | None = None  # priority.font_classes entry (spec §9.4)

    @property
    def own_shape(self) -> Shape:
        """Shape used for adjacency/ambiguity: the mark, or for area anchors the area polygon."""
        if self.shape is not None:
            return self.shape
        assert self.area is not None
        return self.area


@dataclass
class Primitive:
    """A vector obstacle primitive in canvas px."""

    kind: str                    # circle | polyline | polygon | rect | shape
    shape: Shape | None = None   # circle / polygon / rect / shape
    points: list[Point] | None = None  # polyline
    width: float = 0.0           # polyline stroke width

    def bbox(self) -> Box:
        if self.kind == "polyline":
            xs = [p[0] for p in self.points]
            ys = [p[1] for p in self.points]
            r = self.width / 2
            return Box(min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r)
        return self.shape.bbox()

    def _segs(self, x0: float, y0: float, x1: float, y1: float, grow: float):
        """Segments of the polyline whose bounding boxes (grown by ``grow``) meet the rectangle."""
        if getattr(self, "_np", None) is None:
            P = np.asarray(self.points, dtype=np.float64)
            self._np = (P[:-1], P[1:], np.minimum(P[:-1], P[1:]), np.maximum(P[:-1], P[1:]))
        A, B, lo, hi = self._np
        m = ((lo[:, 0] - grow <= x1) & (hi[:, 0] + grow >= x0) & (lo[:, 1] - grow <= y1)
             & (hi[:, 1] + grow >= y0))
        for i in np.nonzero(m)[0]:
            yield (A[i, 0], A[i, 1]), (B[i, 0], B[i, 1])

    def intersects_box(self, b: Box) -> bool:
        if self.kind == "polyline":
            r = self.width / 2
            for p, q in self._segs(b.x0, b.y0, b.x1, b.y1, r):
                if r > 0:
                    if geom.seg_box_dist(p, q, b) < r:
                        return True
                elif geom.seg_box_intersects(p, q, b):
                    return True
            return False
        return self.shape.intersects_box(b)

    def intersects_segment(self, a: Point, c: Point, radius: float = 0.0) -> bool:
        if self.kind == "polyline":
            r = self.width / 2 + radius
            for p, q in self._segs(min(a[0], c[0]), min(a[1], c[1]), max(a[0], c[0]), max(a[1], c[1]), r):
                if geom.seg_seg_dist(a, c, p, q) < max(r, 1e-9):
                    return True
            return False
        return self.shape.intersects_segment(a, c, radius)


@dataclass
class Problem:
    raw: dict
    opts: dict
    width: float | None
    height: float | None
    padding: float
    region: Box | None
    allow_outside: bool
    items: list[Item]
    vectors: dict[str, list[Primitive]]
    tx: Callable[[float, float], Point]
    warnings: list[str] = field(default_factory=list)

    @property
    def bounded(self) -> bool:
        return self.width is not None

    def canvas_box(self) -> Box | None:
        if self.width is None:
            return None
        return Box(0.0, 0.0, self.width, self.height)

    def label_area(self) -> Box | None:
        """The rectangle labels must stay inside (spec §2.3), or None when unconstrained."""
        if self.width is None or self.allow_outside:
            return None
        r = self.region if self.region is not None else self.canvas_box()
        return r.shrink(self.padding) if self.padding > 0 else r

    def item_by_id(self) -> dict[str, Item]:
        return {it.id: it for it in self.items}


def _transform_fn(problem: dict, height: float | None) -> Callable[[float, float], Point]:
    t = problem.get("transform")
    up = problem.get("y_axis", "down") == "up"
    if up and height is None:
        raise ValueError("y_axis 'up' requires a canvas")

    def tx(x: float, y: float) -> Point:
        if t:
            a, b, c, d, e, f = t
            x, y = a * x + c * y + e, b * x + d * y + f
        if up:
            y = height - y
        return (float(x), float(y))

    return tx


def _canvas_size(problem: dict) -> tuple[float | None, float | None]:
    c = problem.get("canvas")
    if c and "width" in c:
        return float(c["width"]), float(c["height"])
    obs = problem.get("obstacles") or {}
    rasters = obs.get("raster")
    if rasters:
        r = rasters[0] if isinstance(rasters, list) else rasters
        w, h = raster_size(r)
        s = float(r.get("scale", 1))
        return w / s, h / s
    svgs = obs.get("svg")
    if svgs:
        s = svgs[0] if isinstance(svgs, list) else svgs
        if "source" in s:
            import re
            m = re.search(r"<svg[^>]*\bwidth=\"([0-9.]+)[^\"]*\"[^>]*\bheight=\"([0-9.]+)", s["source"])
            if m:
                return float(m.group(1)), float(m.group(2))
            m = re.search(r"viewBox=\"[-0-9. ]*?([0-9.]+)\s+([0-9.]+)\"", s["source"])
            if m:
                return float(m.group(1)), float(m.group(2))
    return None, None


def raster_bytes(r: dict) -> bytes | None:
    src = r.get("source")
    if src is None:
        return None
    if src.startswith("data:"):
        return base64.b64decode(src.split(",", 1)[1])
    try:
        return base64.b64decode(src, validate=True)
    except Exception:  # noqa: BLE001 - a file path
        with open(src, "rb") as f:
            return f.read()


def raster_size(r: dict) -> tuple[int, int]:
    if "rgba" in r:
        return int(r["rgba"]["width"]), int(r["rgba"]["height"])
    from PIL import Image

    with Image.open(io.BytesIO(raster_bytes(r))) as im:
        return im.size


def make_mark(mark: dict, ref: Point, tx: Callable[[float, float], Point], default_r: float = 2.0) -> Shape:
    shp = mark.get("shape", "circle")
    x, y = ref
    if shp == "circle":
        return Circle(x, y, float(mark.get("r", default_r)))
    if shp == "ellipse":
        return Ellipse(x, y, float(mark["rx"]), float(mark["ry"]), float(mark.get("rotation", 0)))
    if shp == "rect":
        return RoundedRect(x, y, float(mark["w"]), float(mark["h"]), float(mark.get("corner_radius", 0)),
                           float(mark.get("rotation", 0)))
    if shp == "polygon":
        rel = bool(mark.get("relative", False))

        def m(p):
            return (x + p[0], y + p[1]) if rel else tx(p[0], p[1])

        rings = [[m(p) for p in mark["points"]]] + [[m(p) for p in h] for h in mark.get("holes", [])]
        return Polygon(rings, ref=ref)
    if shp == "path":
        rel = bool(mark.get("relative", False))
        subs = geom.flatten_path(mark["d"], 0.25)
        rings = [[(x + p[0], y + p[1]) if rel else tx(p[0], p[1]) for p in sp] for sp in subs]
        return Polygon(rings, ref=ref, holes=False)
    if shp == "icon":
        w, h = float(mark["w"]), float(mark["h"])
        tip = mark.get("tip", [w / 2, h])
        x0, y0 = x - tip[0], y - tip[1]
        if mark.get("silhouette"):
            ring = [(x0 + p[0], y0 + p[1]) for p in mark["silhouette"]]
            return Polygon([ring], ref=ref)
        return RoundedRect(x0 + w / 2, y0 + h / 2, w, h, 0.0, 0.0, ref=ref)
    if shp == "from_svg":
        return Circle(x, y, 0.0)
    raise ValueError(f"unknown mark shape {shp!r}")


def _layers(problem: dict, opts: dict, tx) -> dict[str, list[Primitive]]:
    out: dict[str, list[Primitive]] = {}
    obs = problem.get("obstacles") or {}
    dr = float(spec.element_default("obstacles.vector.r"))
    dw = float(spec.element_default("obstacles.vector.width"))
    dfr = spec.element_default("obstacles.vector.fill_rule")
    for layer in obs.get("vector", []) or []:
        cls = layer["class"]
        prims = out.setdefault(cls, [])
        r = float(layer.get("r", dr))
        for p in layer.get("points", []) or []:
            c = tx(p[0], p[1])
            prims.append(Primitive("circle", Circle(c[0], c[1], r)))
        for x, y, rr in layer.get("circles", []) or []:
            c = tx(x, y)
            prims.append(Primitive("circle", Circle(c[0], c[1], rr)))
        w = float(layer.get("width", dw))
        for pl in layer.get("polylines", []) or []:
            prims.append(Primitive("polyline", points=[tx(p[0], p[1]) for p in pl], width=w))
        fr = layer.get("fill_rule", dfr)
        for pg in layer.get("polygons", []) or []:
            prims.append(Primitive("polygon", Polygon([[tx(p[0], p[1]) for p in pg]], fill_rule=fr)))
        for x, y, ww, hh in layer.get("rects", []) or []:
            c = tx(x, y)
            prims.append(Primitive("rect", RoundedRect(c[0] + ww / 2, c[1] + hh / 2, ww, hh)))
        for s in layer.get("shapes", []) or []:
            ref = tx(s["x"], s["y"])
            prims.append(Primitive("shape", make_mark(s, ref, tx, dr)))
    return out


def load_problem(problem: dict, ranks: dict[str, int] | None = None) -> Problem:
    """``ranks``: the priority ranks of a result (the engine's), for ``priority.font_classes``;
    default: the reference priority (bench.eval.priority)."""
    opts = spec.effective_options(problem)
    width, height = _canvas_size(problem)
    tx = _transform_fn(problem, height)
    copts = opts.get("canvas", {})
    em0 = float(opts.get("defaults", {}).get("font", {}).get("size", 12))
    padding = spec.length(copts.get("padding", 4), em0)
    region = copts.get("region")
    region_box = Box.xywh(*region) if region else None
    allow_outside = bool(copts.get("allow_outside", False))
    dmark = opts.get("defaults", {}).get("mark", {"shape": "circle", "r": 2})
    pl = opts.get("placement", {})
    items = []
    warnings = []
    for i, it in enumerate(problem["items"]):
        a = it["anchor"]
        label = resolve_label(it["label"], opts)
        ip = it.get("placement", {}) or {}
        em = label.em
        offset = spec.length(ip.get("offset", pl.get("offset", 2)), em)
        common = dict(label=label, attrs=it.get("attrs", {}) or {}, priority=it.get("priority"),
                      tier=it.get("tier"), required=bool(it.get("required", False)), offset=offset,
                      internal=ip.get("internal", pl.get("internal", "auto")),
                      models=ip.get("models", pl.get("models", [])),
                      position_order=ip.get("position_order", pl.get("position_order", "perceptual")), raw=it)
        iid = it.get("id", str(i))
        if a["type"] == "point":
            ref = tx(a["x"], a["y"])
            mark = a.get("mark", dmark)
            if mark.get("shape") == "from_svg":
                warnings.append(f"item {iid}: from_svg marks are approximated by their anchor point")
            shape = make_mark(mark, ref, tx, float(dmark.get("r", 2)) if dmark.get("shape") == "circle" else 2.0)
            items.append(Item(i, iid, "point", ref, shape, None, None, **common))
        else:
            rings = [[tx(p[0], p[1]) for p in a["polygon"]]] + [[tx(p[0], p[1]) for p in h]
                                                                for h in a.get("holes", [])]
            area = Polygon(rings)
            pole = geom.polylabel(area, 0.5)
            area.ref = pole
            dot = make_mark(a.get("dot", {"shape": "circle", "r": 2}), pole, tx)
            items.append(Item(i, iid, "area", pole, None, area, dot, **common))
    vectors = _layers(problem, opts, tx)
    prob = Problem(problem, opts, width, height, padding, region_box, allow_outside, items, vectors, tx, warnings)
    classes = (opts.get("priority", {}) or {}).get("font_classes") or []
    if classes:
        apply_font_classes(prob, classes, ranks)
    return prob


def class_ends(classes: list[dict], n: int) -> list[int]:
    """Where each font class ends in the total order (cumulative, spec §9.4)."""
    ends, last = [], 0
    for c in classes:
        first = c.get("first")
        if first is None:
            end = n
        elif isinstance(first, str):
            end = min(max(math.ceil(float(first[:-1]) / 100 * n - 1e-9), 0), n)
        else:
            end = min(int(first), n)
        last = max(last, end)
        ends.append(last)
    return ends


def scaled_label(label: dict, opts: dict, scale: float, weight: Any) -> dict:
    """The label JSON with its text scaled like a font class does: font sizes, host-measured
    text sizes and wrap widths given in px scale; lengths in em follow the font size."""
    d = opts.get("defaults", {})
    lab = dict(label)
    font = _font_of(label.get("font"), d.get("font", {}))
    size = float(font.get("size", 12))
    nf = dict(label.get("font") or {})
    nf["size"] = size * scale
    if weight is not None:
        nf["weight"] = weight
    lab["font"] = nf

    def text_part(t: dict, em: float) -> dict:
        t = dict(t)
        if "width" in t and "height" in t:
            t["width"] = float(t["width"]) * scale
            t["height"] = float(t["height"]) * scale
        w = t["wrap"] if "wrap" in t else d.get("wrap")
        mw = w.get("max_width") if isinstance(w, dict) else None
        if mw is not None and not str(mw).strip().endswith("em"):
            t["wrap"] = {**w, "max_width": spec.length(mw, em) * scale}
        return t

    kind = lab.get("type", "text")
    if kind == "text":
        lab = text_part(lab, size)
    elif kind == "composite":
        parts = []
        for p in lab["parts"]:
            if p.get("type") == "text":
                pf = dict(p.get("font") or {})
                psize = float(pf.get("size", size))
                if "size" in pf:
                    pf["size"] = psize * scale
                if weight is not None:
                    pf["weight"] = weight
                p = text_part({**p, "font": pf} if pf else dict(p), psize)
            parts.append(p)
        lab["parts"] = parts
    return lab


def apply_font_classes(prob: Problem, classes: list[dict], ranks: dict[str, int] | None = None) -> None:
    """``priority.font_classes`` (spec §9.4): rescale each item's label by the class of its rank."""
    if ranks is None:
        from ..eval import priority as pr
        ranks = {k: v.rank for k, v in pr.reference(prob).items()}
    ends = class_ends(classes, len(prob.items))
    pl = prob.opts.get("placement", {})
    for it in prob.items:
        r = ranks.get(it.id)
        k = next((k for k, e in enumerate(ends) if r is not None and r < e), None)
        it.font_class = k
        if k is None:
            continue
        scale = float(classes[k].get("scale", 1.0))
        weight = classes[k].get("weight")
        if scale == 1.0 and weight is None:
            continue
        it.label = resolve_label(scaled_label(it.raw["label"], prob.opts, scale, weight), prob.opts)
        ip = it.raw.get("placement", {}) or {}
        it.offset = spec.length(ip.get("offset", pl.get("offset", 2)), it.label.em)


# ---------------------------------------------------------------------------
# Adjacent candidate positions (spec §6.1)
# ---------------------------------------------------------------------------
DIRECTIONS: dict[str, Point] = {
    "top": (0.0, -1.0), "right": (1.0, 0.0), "bottom": (0.0, 1.0), "left": (-1.0, 0.0),
    "top-right": (1.0, -1.0), "bottom-right": (1.0, 1.0), "top-left": (-1.0, -1.0), "bottom-left": (-1.0, 1.0),
}
PERCEPTUAL = ["top", "right", "bottom", "left", "top-right", "bottom-right", "top-left", "bottom-left"]
CARTOGRAPHIC = ["top-right", "top-left", "bottom-right", "bottom-left", "right", "left", "top", "bottom"]


def position_order(po: Any) -> list[str]:
    if po == "cartographic":
        return list(CARTOGRAPHIC)
    if isinstance(po, list):
        return list(po)
    return list(PERCEPTUAL)


def _sign(v: float) -> float:
    return 0.0 if abs(v) < 1e-12 else math.copysign(1.0, v)


def adjacent_box(shape: Shape, offset: float, w: float, h: float, pos: str) -> Box:
    """Label box of the fixed adjacent position ``pos`` around ``shape ⊕ offset``."""
    d = DIRECTIONS[pos]
    s = shape.support_inflated(d, offset)
    cx = s[0] + _sign(d[0]) * w / 2
    cy = s[1] + _sign(d[1]) * h / 2
    return Box(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
