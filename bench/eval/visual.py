"""Visual-quality metrics: clutter a reader perceives although no hard constraint is violated.

* **Leader length** in em and as a fraction of the canvas diagonal: leaders longer than
  ``FAR`` × the diagonal cross a large part of the picture.
* **Near crossings:** two leaders that do not cross but come closer than ``NEAR_PX``
  (stroke edges less than about 3 px apart) read as crossing or touching. Two leaders
  are always close where both start, when their items are close; that approach does not
  count (the leaders diverge from neighbouring marks). Every other approach does: an end
  or bend of one leader near the other leader, or a leader passing another leader's
  anchor end.
* **Parallel leaders:** leaders of neighbouring items (anchor ends within 1 em) whose
  directions differ by less than ``PARALLEL_DEG``.
* **Leaders over marks and data:** a leader passing within ``TOUCH_PX`` of another item's
  mark (beyond half its stroke) touches it and seems to point at it; the same test
  against the vector primitives of every other class gives the leader touches per class.
* **Labels over data:** the vector primitives of soft classes under placed labels: points
  (circles) and areas (rects, polygons) counted once per primitive, polyline length in
  em.

The metrics count, they do not judge: whether a class is data (points, lines, nodes) or
context (grid, areas) is up to the reader of the numbers.
"""
from __future__ import annotations

import math

from ..common import geom, spec
from ..common.geom import Box, GridIndex, Point

NEAR_PX = 4.0         # leaders closer than this look like they cross
TOUCH_PX = 1.0        # a leader passing this close to a mark (beyond half its stroke) touches it
LONG_EM = 10.0        # the default leaders.max_length
FAR = 0.25            # fraction of the canvas diagonal
PARALLEL_DEG = 10.0   # the default leaders.min_angle_between
START_SKIP_PX = 3.0   # the start of a leader may touch lines that end at its own mark
RESERVED = ("items", "labels", "leaders", "canvas_edge")
TOL = 0.5             # contacts within the evaluator's tolerance do not count


def _bbox(a: Point, b: Point, grow: float = 0.0) -> Box:
    return Box(min(a[0], b[0]) - grow, min(a[1], b[1]) - grow, max(a[0], b[0]) + grow, max(a[1], b[1]) + grow)


def _quantile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    pos = q * (len(s) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)


def leader_segments(L) -> list[tuple[Point, Point]]:
    """Segments of a leader ``(points, extra segments)``: the polyline and its underline."""
    pts, extra = L
    return list(zip(pts, pts[1:])) + list(extra)


def leader_approach(A, B, starts: float) -> float | None:
    """Closest approach of two leaders that counts as a near crossing (spec §7, the engine's
    clearance test): None when they intersect (a crossing). Leaders ``(points, extra segments)``
    start at ``points[0]``; non-intersecting leaders are closest at a vertex of one of them, and
    the start of one leader does not count when the other leader starts within ``starts`` of it
    (leaders of neighbouring marks start close together)."""
    SA, SB = leader_segments(A), leader_segments(B)
    for a, b in SA:
        for c, d in SB:
            if geom.segments_intersect(a, b, c, d):
                return None
    best = math.inf
    for L, S, other_start in ((A, SB, B[0][0]), (B, SA, A[0][0])):
        pts, extra = L
        for k, p in enumerate(list(pts) + [q for seg in extra for q in seg]):
            d = min(geom.point_seg_dist(p, c, e) for c, e in S)
            if k == 0 and math.dist(p, other_start) <= starts:
                continue
            best = min(best, d)
    return best


def leaders_parallel(A, B, near: float, max_deg: float) -> bool:
    """Leaders starting closer than ``near`` whose first segments differ by less than ``max_deg``."""
    a, b = A[0], B[0]
    if len(a) < 2 or len(b) < 2 or math.dist(a[0], b[0]) >= near:
        return False
    t1, t2 = _direction(a), _direction(b)
    return t1 is not None and t2 is not None and _angle_between(t1, t2) < max_deg


def label_leaders(p) -> list:
    """The leaders of a placed label as ``(points, extra segments)``; the underline belongs to
    the first leader."""
    out = []
    for li, pl in enumerate(p.leaders):
        extra = [tuple(u[:2]) for u in p.underlines if len(u) >= 2] if li == 0 else []
        out.append((pl, extra))
    return out


def exempt_mark(own, other) -> bool:
    """Marks a leader of ``own`` may pass (spec §7): its own, those of its group, and marks
    that cover its anchor (no leader avoids them)."""
    if other.id == own.id:
        return True
    g = own.raw.get("group")
    if g is not None and other.raw.get("group") == g:
        return True
    return other.shape is not None and other.shape.contains(own.ref)


def _direction(pl: list[Point]) -> float | None:
    dx, dy = pl[1][0] - pl[0][0], pl[1][1] - pl[0][1]
    if abs(dx) < 1e-12 and abs(dy) < 1e-12:
        return None
    return math.degrees(math.atan2(dy, dx))


def _angle_between(a: float, b: float) -> float:
    d = abs(a - b) % 360.0
    return min(d, 360.0 - d)


def evaluate_visual(prob, placed, classes: dict, a_label: dict, a_leader: dict, max_list: int = 25) -> dict:
    opts = prob.opts
    half = float(opts.get("leaders", {}).get("width", 1.0)) / 2
    touch = half + TOUCH_PX
    diag = math.hypot(prob.width, prob.height) if prob.bounded else None

    # ------------------------------------------------------------ leader length
    leaders = []   # (placed index, (polyline, underline segments), em, model)
    for k, p in enumerate(placed):
        for L in label_leaders(p):
            leaders.append((k, L, p.item.label.em, p.model))
    lens_em, lens_px = [], []
    far, far_boundary, long_n = [], 0, 0
    for k, (pl, _x), em, model in leaders:
        L = geom.polyline_length(pl)
        lens_px.append(L)
        lens_em.append(L / em)
        if L / em > LONG_EM:
            long_n += 1
        if diag and L > FAR * diag:
            far.append(placed[k].id)
            far_boundary += model == "boundary"
    length = {"n": len(leaders), "p50_em": _quantile(lens_em, 0.5), "p90_em": _quantile(lens_em, 0.9),
              "max_em": max(lens_em, default=None), "max_px": max(lens_px, default=None),
              "max_diag": (max(lens_px) / diag) if (diag and lens_px) else None,
              "long": long_n, "far": len(far), "far_boundary": far_boundary, "far_examples": far[:max_list]}

    # ------------------------------------------------------------ leader vs leader
    seg_index = GridIndex(32.0)
    for li, (_k, L, _em, _m) in enumerate(leaders):
        for a, b in leader_segments(L):
            seg_index.insert(li, _bbox(a, b))
    near_pairs: dict[tuple[int, int], float] = {}
    parallel = []
    for li, (k, L, em, model) in enumerate(leaders):
        cand = set()
        for a, b in leader_segments(L):
            cand.update(seg_index.query(_bbox(a, b, max(NEAR_PX, em))))
        for lj in sorted(cand):
            if lj <= li:
                continue
            k2, L2, em2, model2 = leaders[lj]
            if k2 == k:
                continue
            d = leader_approach(L, L2, NEAR_PX)
            if d is not None and d < NEAR_PX:
                key = (min(k, k2), max(k, k2))
                near_pairs[key] = min(d, near_pairs.get(key, math.inf))
            if model == "distant" and model2 == "distant" and leaders_parallel(L, L2, max(em, em2), PARALLEL_DEG):
                parallel.append((placed[k].id, placed[k2].id))
    near_sorted = sorted(near_pairs.items(), key=lambda kv: (kv[1], kv[0]))
    near = {"count": len(near_pairs),
            "min_px": min(near_pairs.values(), default=None),
            "examples": [[placed[a].id, placed[b].id, round(d, 2)] for (a, b), d in near_sorted[:max_list]],
            "parallel": len(parallel), "parallel_examples": [list(p) for p in parallel[:max_list]]}

    # ------------------------------------------------------------ leaders vs marks and classes
    item_index = GridIndex(32.0)
    for it in prob.items:
        if it.shape is not None:
            item_index.insert(it.index, it.shape.bbox())
    mark_pairs = set()
    class_touch: dict[str, dict[str, int]] = {}
    leaders_touching_class: dict[str, int] = {}
    vec_classes = {c: oc for c, oc in classes.items() if c not in RESERVED and oc.prims
                   and spec.avoid_value(a_leader, c) != "ignore"}
    for k, (pl, _x), _em, _m in leaders:
        own = placed[k].item
        hit_prims: dict[str, set[int]] = {}
        for si, (a, b) in enumerate(zip(pl, pl[1:])):
            for j in item_index.query(_bbox(a, b, touch)):
                other = prob.items[j]
                if not exempt_mark(own, other) and other.shape.intersects_segment(a, b, touch):
                    mark_pairs.add((k, j))
            if si == 0:
                # lines and edges ending at the own mark pass the leader's start: skip its first px
                L = math.dist(a, b)
                if L <= START_SKIP_PX:
                    continue
                t = START_SKIP_PX / L
                a = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            for c, oc in vec_classes.items():
                for pi in oc.index().query(_bbox(a, b, touch)):
                    if oc.prims[pi].intersects_segment(a, b, touch):
                        hit_prims.setdefault(c, set()).add(pi)
        for c, s in hit_prims.items():
            ct = class_touch.setdefault(c, {"points": 0, "lines": 0, "areas": 0})
            for pi in s:
                ct[_kind(vec_classes[c].prims[pi])] += 1
            leaders_touching_class[c] = leaders_touching_class.get(c, 0) + 1
    marks = {"touches": len(mark_pairs),
             "leaders_touching": len({k for k, _j in mark_pairs}),
             "examples": [[placed[k].id, prob.items[j].id] for k, j in sorted(mark_pairs)[:max_list]],
             "classes": {c: {**class_touch.get(c, {"points": 0, "lines": 0, "areas": 0}),
                             "leaders": leaders_touching_class.get(c, 0), "hard": spec.is_hard(a_leader, c)}
                         for c in sorted(vec_classes)}}

    # ------------------------------------------------------------ labels over data
    under: dict[str, dict] = {}
    for c, oc in sorted(classes.items()):
        if c in RESERVED or not oc.prims:
            continue
        pol = spec.avoid_value(a_label, c)
        if pol == "ignore" or spec.is_hard(a_label, c):
            continue
        hit: set[int] = set()
        lines_len = 0.0
        for p in placed:
            b = p.box.shrink(TOL)
            for pi in oc.index().query(b):
                prim = oc.prims[pi]
                if prim.kind == "polyline":
                    if prim.intersects_box(b):
                        hit.add(pi)
                        em = p.item.label.em
                        lines_len += sum(_clip_len(q, r, b) for q, r in zip(prim.points, prim.points[1:])) / em
                elif prim.intersects_box(b):
                    hit.add(pi)
        n_by_kind = {"points": 0, "lines": 0, "areas": 0}
        for pi in hit:
            n_by_kind[_kind(oc.prims[pi])] += 1
        total_by_kind = {"points": 0, "lines": 0, "areas": 0}
        for prim in oc.prims:
            total_by_kind[_kind(prim)] += 1
        under[c] = {"weight": pol, **{f"{kd}_hidden": n_by_kind[kd] for kd in n_by_kind if total_by_kind[kd]},
                    **{f"{kd}_total": total_by_kind[kd] for kd in total_by_kind if total_by_kind[kd]},
                    "lines_em": lines_len if total_by_kind["lines"] else None}

    return {"leader_length": length, "near_crossings": near, "leader_marks": marks, "labels_over": under,
            "thresholds": {"near_px": NEAR_PX, "touch_px": TOUCH_PX, "long_em": LONG_EM, "far": FAR,
                           "parallel_deg": PARALLEL_DEG}}


def _kind(prim) -> str:
    if prim.kind == "polyline":
        return "lines"
    if prim.kind == "circle":
        return "points"
    return "areas"


def _clip_len(a: Point, c: Point, b: Box) -> float:
    from .classes import clip_len
    return clip_len(a, c, b)


def summary_fields(v: dict) -> dict:
    """Headline visual metrics for report tables."""
    under = v["labels_over"]
    return {
        "leader_len_p90_em": v["leader_length"]["p90_em"],
        "leader_len_max_em": v["leader_length"]["max_em"],
        "leaders_far": v["leader_length"]["far"],
        "leader_near_crossings": v["near_crossings"]["count"],
        "leader_parallel": v["near_crossings"]["parallel"],
        "leader_mark_touches": v["leader_marks"]["touches"],
        "leader_point_touches": sum(c["points"] for c in v["leader_marks"]["classes"].values()),
        "leader_line_touches": sum(c["lines"] for c in v["leader_marks"]["classes"].values()),
        "label_points_hidden": sum(c.get("points_hidden", 0) for c in under.values()),
        "label_lines_em": sum(c["lines_em"] or 0.0 for c in under.values()),
    }
