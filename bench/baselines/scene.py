"""Tool-independent view of a problem for the baseline adapters.

``build_scene(problem, problem_path)`` resolves a problem once (effective options,
true marks, label boxes measured per spec §5, reference priority order) and lists
what a third-party tool can be told about it, in canvas px with y down:

* the labels in priority order, each with its anchor point, its mark and the
  exact label box size (w × h, padding included) every tool must reserve,
* every item's mark (labels must not cover other items' marks),
* the obstacle classes the problem does not ``ignore`` for labels, as circles,
  polylines (with stroke width), rects and polygons, plus raster class masks,
* notes on emulations and unsupported features, which the adapters copy into the
  result's ``warnings`` and the report.

Obstacle sources: the problem's ``obstacles.vector`` layers (exact); for SVG
backgrounds the scenario's ``truth.json`` geometry, i.e. what the host drew
(an emulation: the tools cannot read SVG); raster sources through the per-pixel
mode definitions of spec §4.6 (``bench/common/raster.py``), thresholded at 0.5.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

from ..common import raster as rmod
from ..common import spec
from ..common.geom import Box, Circle, Point, Polygon, RoundedRect, Shape
from ..common.jsonio import read_json
from ..common.model import Item, Problem, load_problem, position_order
from ..eval import classes as clsmod
from ..eval import priority as pr

RESERVED = ("items", "labels", "leaders", "canvas_edge")
PLACEHOLDER = "■"  # text handed to text-only tools for icon / box labels


@dataclass
class Note:
    """An emulation (the tool gets an approximation) or an unsupported feature (ignored)."""

    kind: str          # "emulation" | "unsupported"
    feature: str       # short key, e.g. "raster:ink", "svg", "area-anchors"
    message: str
    pointer: str = ""

    def as_dict(self) -> dict:
        return {"kind": self.kind, "feature": self.feature, "message": self.message}


@dataclass
class LabelItem:
    item: Item
    rank: int
    x: float               # anchor point (point anchors: mark reference; area anchors: pole)
    y: float
    shape: Shape           # the mark the label belongs to (area anchors: the dot at the pole)
    w: float               # label box, padding included (spec §5)
    h: float
    text: str              # text handed to the tool (composites: their text parts)
    font_size: float       # px
    font_weight: int
    offset: float          # placement.offset, px

    @property
    def id(self) -> str:
        return self.item.id

    @property
    def mark_box(self) -> Box:
        return self.shape.bbox()

    @property
    def mark_radius(self) -> float:
        """Radius of a circle mark; half the larger bbox side otherwise."""
        if isinstance(self.shape, Circle):
            return self.shape.r
        b = self.shape.bbox()
        return 0.5 * max(b.w, b.h)


@dataclass
class RasterMask:
    """Occupancy mask of one raster class (raster px), mapped to canvas px by scale/offset."""

    cls: str
    mask: np.ndarray       # bool, rows × cols of the raster
    scale: float           # raster px per canvas px
    offset: Point          # canvas position of the raster's top-left corner
    mode: str

    @property
    def count(self) -> int:
        return int(self.mask.sum())

    def cells(self, step: float) -> list[tuple[float, float, float]]:
        """Occupied cells (x0, y0, step) of a canvas-aligned grid of ``step`` px (any raster pixel
        centre inside a cell occupies it), sorted row-major."""
        ys, xs = np.nonzero(self.mask)
        if len(xs) == 0:
            return []
        cx = self.offset[0] + (xs + 0.5) / self.scale
        cy = self.offset[1] + (ys + 0.5) / self.scale
        gx = np.floor(cx / step).astype(np.int64)
        gy = np.floor(cy / step).astype(np.int64)
        keys = np.unique(gy * 1_000_003 + gx)
        gy, gx = np.divmod(keys, 1_000_003)
        return [(float(x) * step, float(y) * step, step) for x, y in zip(gx.tolist(), gy.tolist(), strict=True)]

    def runs(self) -> list[tuple[float, float, float, float]]:
        """Exact cover of the mask by horizontal pixel runs: canvas rects (x, y, w, h)."""
        m = np.asarray(self.mask, dtype=np.int8)
        pad = np.zeros((m.shape[0], 1), dtype=np.int8)
        d = np.diff(np.concatenate([pad, m, pad], axis=1), axis=1)
        out = []
        s = 1.0 / self.scale
        for row in range(m.shape[0]):
            starts = np.nonzero(d[row] == 1)[0]
            if len(starts) == 0:
                continue
            ends = np.nonzero(d[row] == -1)[0]
            y = self.offset[1] + row * s
            for a, b in zip(starts.tolist(), ends.tolist(), strict=True):
                out.append((self.offset[0] + a * s, y, (b - a) * s, s))
        return out


@dataclass
class Obstacles:
    circles: list[tuple[float, float, float, str]] = field(default_factory=list)       # x, y, r, class
    polylines: list[tuple[list[Point], float, str]] = field(default_factory=list)      # points, width, class
    rects: list[tuple[float, float, float, float, str]] = field(default_factory=list)  # x, y, w, h, class
    polygons: list[tuple[list[list[Point]], str]] = field(default_factory=list)        # rings, class
    masks: list[RasterMask] = field(default_factory=list)

    def classes(self) -> list[str]:
        cs = {c[-1] for c in self.circles} | {p[-1] for p in self.polylines} | {r[-1] for r in self.rects}
        cs |= {p[-1] for p in self.polygons} | {m.cls for m in self.masks}
        return sorted(cs)

    def counts(self) -> dict[str, int]:
        return {"circles": len(self.circles), "polylines": len(self.polylines), "rects": len(self.rects),
                "polygons": len(self.polygons), "raster_px": sum(m.count for m in self.masks)}


@dataclass
class Scene:
    problem: Problem
    width: float
    height: float
    area: Box                          # label area (canvas minus padding, or the region)
    labels: list[LabelItem]            # in priority order (rank ascending)
    omitted: list[tuple[Item, str]]    # items not handed to the tool, with the result reason
    marks: list[tuple[str, Shape]]     # every item's mark (item id, shape)
    obstacles: Obstacles
    positions: list[str]               # problem-level adjacent position order
    infos: dict                        # reference priority (bench.eval.priority.PriorityInfo per id)
    notes: list[Note] = field(default_factory=list)

    def note(self, kind: str, feature: str, message: str, pointer: str = "") -> None:
        if not any(n.feature == feature and n.kind == kind for n in self.notes):
            self.notes.append(Note(kind, feature, message, pointer))


def default_truth_path(problem_path: str | Path | None) -> Path | None:
    if problem_path is None:
        return None
    p = Path(problem_path)
    if not p.name.endswith(".json"):
        return None
    t = p.with_name(p.name[:-len(".json")] + ".truth.json")
    return t if t.exists() else None


def _as_list(v) -> list:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _shape_rings(s: Shape) -> list[list[Point]]:
    return [list(r) for r in s.rings()]


def _add_primitive(obs: Obstacles, cls: str, p) -> None:
    if p.kind == "polyline":
        if len(p.points) >= 2:
            obs.polylines.append(([tuple(q) for q in p.points], float(p.width), cls))
        return
    shp = p.shape
    if isinstance(shp, Circle):
        obs.circles.append((shp.cx, shp.cy, shp.r, cls))
    elif isinstance(shp, RoundedRect) and abs(getattr(shp, "rotation", 0.0)) < 1e-9 and shp.cr <= 1e-9:
        obs.rects.append((shp.cx - shp.w / 2, shp.cy - shp.h / 2, shp.w, shp.h, cls))
    else:
        obs.polygons.append((_shape_rings(shp), cls))


SOFT_MODES = ("hard", "ignore")


def build_scene(problem: dict, problem_path: str | Path | None = None, truth: dict | None = None,
                soft: str = "hard") -> Scene:
    """``soft``: how classes the problem gives a cost (neither hard nor ignored) reach the tools, which have
    no soft costs: ``hard`` avoids them like hard classes, ``ignore`` leaves them out (labels may cover
    them, as the engine may at a cost)."""
    if soft not in SOFT_MODES:
        raise ValueError(f"soft must be one of {SOFT_MODES}, not {soft!r}")
    prob = load_problem(problem)
    opts = prob.opts
    a_label = opts.get("avoid", {}).get("label", {})
    notes: list[Note] = []

    # ------------------------------------------------------------ canvas and label area
    if prob.bounded:
        W, H = float(prob.width), float(prob.height)
    else:
        xs = [it.ref[0] for it in prob.items] or [0.0]
        ys = [it.ref[1] for it in prob.items] or [0.0]
        W, H = max(xs) + 100.0, max(ys) + 100.0
        notes.append(Note("emulation", "unbounded-canvas",
                          "no canvas: the tool's canvas is [0, max anchor + 100 px]"))
    area = prob.label_area() or Box(0.0, 0.0, W, H)

    # ------------------------------------------------------------ labels in priority order
    infos = pr.reference(prob)
    order = sorted(prob.items, key=lambda it: infos[it.id].rank)
    budget = opts.get("priority", {}).get("budget", {}).get("max_labels")
    omitted: list[tuple[Item, str]] = []
    if budget is not None and len(order) > int(budget):
        omitted = [(it, "omitted_by_priority") for it in order[int(budget):]]
        order = order[:int(budget)]
        notes.append(Note("emulation", "budget", f"label budget {budget}: only the first {budget} items of the "
                                                 "priority order are handed to the tool"))
    labels: list[LabelItem] = []
    kinds = set()
    for it in order:
        lab = it.label
        kinds.add(lab.kind)
        if it.anchor_type == "area":
            shape = it.dot
            x, y = it.ref
        else:
            shape = it.shape
            x, y = it.ref
        txt = lab.text if lab.kind in ("text", "composite") else ""
        if not txt.strip():
            txt = PLACEHOLDER
        labels.append(LabelItem(it, infos[it.id].rank, float(x), float(y), shape, float(lab.w), float(lab.h),
                                txt, float(lab.font_size), int(lab.font_weight), float(it.offset)))
    marks = [(it.id, it.shape if it.shape is not None else it.dot) for it in prob.items]

    if any(it.anchor_type == "area" for it in prob.items):
        notes.append(Note("emulation", "area-anchors", "area anchors are labeled as points at their pole of "
                                                       "inaccessibility (the dot mark); no internal labels"))
    if "composite" in kinds:
        notes.append(Note("emulation", "composite", "composite labels (icon + text) reserve their full box; the "
                                                    "tool only knows the text part"))
    if kinds & {"icon", "box"}:
        notes.append(Note("emulation", "icon-labels", "icon / box labels are handed over as a placeholder text "
                                                      "with the label's box size"))

    # ------------------------------------------------------------ problem features the tools cannot express
    models = set()
    for it in prob.items:
        models.update(it.models or [])
    if "boundary" in models:
        notes.append(Note("unsupported", "boundary", "boundary (margin) labels are not supported; labels are "
                                                     "placed around their anchors"))
    if "internal" in models and any(it.anchor_type == "area" or it.internal in ("prefer", "always")
                                    for it in prob.items):
        notes.append(Note("unsupported", "internal", "internal labels are not supported"))
    lopts = opts.get("leaders", {}) or {}
    style = lopts.get("style", "straight")
    if style != "straight" and ({"distant", "boundary"} & models):
        angles = f" with angles {lopts.get('angles')}" if style in ("angles", "elbow") and lopts.get("angles") else ""
        notes.append(Note("unsupported", "leader-style",
                          f"leader style {style!r}{angles} is not supported (straight connectors at most)"))
    if any(lab.item.label.has_wrap or (lab.item.label.raw or {}).get("alternatives") for lab in labels):
        notes.append(Note("unsupported", "text-variants", "wrapping alternatives / shorter alternatives are "
                                                          "not used; the normal variant is placed"))
    if (opts.get("priority", {}) or {}).get("coverage"):
        notes.append(Note("unsupported", "coverage", "priority.coverage reservations are not supported "
                                                     "(items are only ordered by priority)"))
    if problem.get("warm_start"):
        notes.append(Note("unsupported", "warm-start", "warm_start is ignored (every frame is solved from "
                                                       "scratch)"))

    # ------------------------------------------------------------ obstacle classes
    obs = Obstacles()

    left_out: set[str] = set()

    def wanted(cls: str) -> bool:
        v = spec.avoid_value(a_label, cls)
        if cls in RESERVED or v == "ignore":
            return False
        if soft == "ignore" and v != "hard":
            left_out.add(cls)
            return False
        return True

    raw_obs = problem.get("obstacles") or {}
    svgs = _as_list(raw_obs.get("svg"))
    used_truth = False
    if svgs:
        if truth is None:
            tp = default_truth_path(problem_path)
            truth = read_json(tp) if tp is not None else None
        if truth is not None:
            used_truth = True
            for cls, entry in sorted((truth.get("classes") or {}).items()):
                if not wanted(cls):
                    continue
                for p in clsmod.primitives_from_truth(entry):
                    _add_primitive(obs, cls, p)
            notes.append(Note("emulation", "svg", "SVG background: its classified geometry (the scenario's "
                                                  "truth.json, i.e. what the host drew) is handed over instead "
                                                  "of the SVG", "/obstacles/svg"))
        else:
            notes.append(Note("unsupported", "svg", "SVG background ignored (no truth.json geometry next to the "
                                                    "problem)", "/obstacles/svg"))
    if not (used_truth and truth.get("includes_problem_vectors")):
        for cls, prims in sorted(prob.vectors.items()):
            if not wanted(cls):
                continue
            for p in prims:
                _add_primitive(obs, cls, p)
    for k, src in enumerate(_as_list(raw_obs.get("raster"))):
        maps = rmod.source_maps(src)
        mode = src.get("mode", spec.element_default("obstacles.raster.mode"))
        scale = float(src.get("scale", 1))
        off = src.get("offset", [0, 0])
        for cls, vals in sorted(maps.items()):
            if not wanted(cls):
                continue
            mask = np.asarray(vals) >= 0.5
            obs.masks.append(RasterMask(cls, mask, scale, (float(off[0]), float(off[1])), mode))
            msg = f"raster class {cls!r} (mode {mode}): its pixel mask (spec §4.6"
            msg += ", value ≥ 0.5)" if mode in ("cost", "saliency") else ")"
            notes.append(Note("emulation", f"raster:{cls}", msg + " is handed over as occupied cells / pixel runs",
                              f"/obstacles/raster/{k}"))
    soft_classes = sorted({c for c in obs.classes() if spec.avoid_value(a_label, c) not in ("hard", "ignore")}
                          | left_out)
    if soft_classes and soft == "hard":
        notes.append(Note("emulation", "soft-classes", "soft obstacle classes (" + ", ".join(soft_classes) + ") "
                                                       "are treated as hard obstacles (no soft costs in these "
                                                       "methods)"))
    elif soft_classes:
        notes.append(Note("emulation", "soft-classes", "soft obstacle classes (" + ", ".join(soft_classes) + ") "
                                                       "are ignored: labels may cover them (no soft costs in "
                                                       "these methods)"))

    positions = [p for p in position_order(opts.get("placement", {}).get("position_order", "perceptual"))]
    if any(it.raw.get("placement", {}).get("position_order") for it in prob.items):
        notes.append(Note("unsupported", "item-position-order", "per-item position orders are not supported; "
                                                                "the problem-level order is used"))
    sc = Scene(prob, W, H, area, labels, omitted, marks, obs, positions, infos, notes)
    return sc


def without_obstacles(scene: Scene) -> Scene:
    """The scene for a tool that is told no obstacle classes: the notes on how they would reach it go."""
    scene.notes = [n for n in scene.notes if n.feature not in ("soft-classes", "svg") and
                   not n.feature.startswith("raster:")]
    return scene


# ---------------------------------------------------------------------------
# Geometry helpers shared by the adapters
# ---------------------------------------------------------------------------
def side_of(box: Box, x: float, y: float, eps: float = 1e-6) -> str:
    """8-way position of ``box`` relative to the anchor (canvas y down); boxes covering the anchor get the
    direction of their centre."""
    h = "right" if box.x0 >= x - eps else ("left" if box.x1 <= x + eps else "")
    v = "top" if box.y1 <= y + eps else ("bottom" if box.y0 >= y - eps else "")
    if h and v:
        return f"{v}-{h}"
    if h or v:
        return h or v
    ang = math.degrees(math.atan2(-(box.cy - y), box.cx - x)) % 360.0
    names = ["right", "top-right", "top", "top-left", "left", "bottom-left", "bottom", "bottom-right"]
    return names[int(((ang + 22.5) % 360.0) // 45.0)]


def nearest_on_box(box: Box, p: Point) -> Point:
    return (min(max(p[0], box.x0), box.x1), min(max(p[1], box.y0), box.y1))


def ray_exit(box: Box, inside: Point, outside: Point) -> Point:
    """Point where the segment from ``inside`` (in the box) to ``outside`` leaves the box."""
    dx, dy = outside[0] - inside[0], outside[1] - inside[1]
    t = 1.0
    for d, lo, hi, s in ((dx, box.x0, box.x1, inside[0]), (dy, box.y0, box.y1, inside[1])):
        if d > 1e-12:
            t = min(t, (hi - s) / d)
        elif d < -1e-12:
            t = min(t, (lo - s) / d)
    t = max(0.0, t)
    return (inside[0] + t * dx, inside[1] + t * dy)


def segment_entry(box: Box, a: Point, b: Point) -> Point | None:
    """First point of the segment a→b that lies in ``box`` (Liang–Barsky); None if it misses the box."""
    t0, t1 = 0.0, 1.0
    dx, dy = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] - box.x0), (dx, box.x1 - a[0]), (-dy, a[1] - box.y0), (dy, box.y1 - a[1])):
        if abs(p) < 1e-12:
            if q < 0:
                return None
        else:
            r = q / p
            if p < 0:
                t0 = max(t0, r)
            else:
                t1 = min(t1, r)
    if t1 < t0:
        return None
    return (a[0] + t0 * dx, a[1] + t0 * dy)


def clip_start(shape: Shape, a: Point, b: Point) -> Point | None:
    """First point of the segment a→b on the boundary of ``shape`` (a inside), or ``a`` when a is outside;
    None when b is inside the shape (no visible connector)."""
    if shape.sdist(b) <= 0.0:
        return None
    if shape.sdist(a) > 0.0:
        return a
    lo, hi = 0.0, 1.0
    for _ in range(48):
        mid = 0.5 * (lo + hi)
        p = (a[0] + mid * (b[0] - a[0]), a[1] + mid * (b[1] - a[1]))
        if shape.sdist(p) > 0.0:
            hi = mid
        else:
            lo = mid
    return (a[0] + hi * (b[0] - a[0]), a[1] + hi * (b[1] - a[1]))


def sample_polyline(points: list[Point], step: float) -> list[Point]:
    """Points every ``step`` px along a polyline (both ends included)."""
    out: list[Point] = []
    for (x0, y0), (x1, y1) in zip(points, points[1:], strict=False):
        n = max(1, int(math.ceil(math.hypot(x1 - x0, y1 - y0) / step)))
        for k in range(n):
            out.append((x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n))
    if points:
        out.append(tuple(points[-1]))
    return out


def polygon_points(rings: list[list[Point]], step: float) -> list[Point]:
    """Boundary samples every ``step`` px plus interior grid points of a polygon (step spacing)."""
    out: list[Point] = []
    for r in rings:
        if len(r) >= 2:
            out += sample_polyline(list(r) + [r[0]], step)
    try:
        poly = Polygon(rings)
    except ValueError:
        return out
    b = poly.bbox()
    nx = int(b.w // step)
    ny = int(b.h // step)
    if nx * ny <= 250_000:
        for j in range(1, ny + 1):
            for i in range(1, nx + 1):
                p = (b.x0 + i * step, b.y0 + j * step)
                if poly.contains(p):
                    out.append(p)
    return out


def choose_cell(masks: list[RasterMask], budget: int = 25_000, start: float = 4.0) -> float:
    """Smallest cell size ≥ ``start`` (doubling) for which the masks give at most ``budget`` cells."""
    step = start
    while step < 64.0 and sum(len(m.cells(step)) for m in masks) > budget:
        step *= 2.0
    return step
