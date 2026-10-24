"""Whose label is it, and what does it hide: label–point association and the data around labels.

What the stubs, own-mark-nearest and spacing work showed (ADR 0050, 0051, 0054):

* **Strictly nearer is not enough.** A reader takes a label for the label of the point
  nearest to it, and one about as near to another point reads as either's: North Korea's
  label, 1.0 px from its bubble and 1.4 px from Cameroon's, or Norway's, centred under
  Singapore's bubble with only its corner at its own (1.0 against 2.2 px). The ``ambiguity``
  metric of ``metrics.py`` counts only labels another shape is strictly nearer to. ``clarity``
  measures the *margin* by which a label's own point is nearer than any other, in em of the
  label's font, and counts labels below 0 (misattributed), 0.2 em (unclear: the engine's
  label margin) and 0.5 em (weak).
* **Every data point competes, labelled or not.** An unlabelled dot of a scatterplot next to
  a label reads as its point as much as a labelled one: the competitors are the marks of
  point items and the circles of the classes labels do not ignore.
* **Coincident points are one spot.** A label of one of two points at the same place names
  the spot: points closer together than a threshold need only the distance between them
  (as the engine's rule, spec §4.4), and a background circle drawn exactly at an item's
  point is that item's mark.
* **Leaders and stubs say whose a label is,** so the margin is measured for labels without
  a leader (``metrics.py`` measures leadered labels from the leader's first point). A point
  that comes nearer to a leadered label than the margin still reads as its point:
  ``leadered_unclear`` counts those.
* **Covering a point hides it,** whatever the problem's avoidance settings: ``points``
  counts the data points (as above) that a label other than their own overlaps, and those
  it hides entirely (``hidden``: the point lies inside the box, which renderers draw
  opaque or with a halo). A hidden point cannot be taken for the label's point, so the
  clarity measure leaves it out; a point partly under a label's edge competes like one
  beside it (it is as good as touching the label).
* **Labels too close to each other read as one:** ``spacing`` measures the gap from each
  label to the nearest other label, in em of the larger font of the two.
"""
from __future__ import annotations

import math

from ..common import spec
from ..common.geom import Box, GridIndex

# margins of the clarity measure, em of the label's font: below 0 another point is nearer
CLEAR_EM = {"misattributed": 0.0, "unclear": 0.2, "weak": 0.5}
# label gaps of the spacing measure, em of the larger font: below 0.2 em labels kept the old
# label margin only, below 0.4 em less than the engine's default spacing (ADR 0054)
CLOSE_EM = {"tight": 0.2, "close": 0.4}
REACH_EM = 2.0           # margins and gaps beyond this count as clear (quantiles are capped)
COINCIDENT_PX = 0.5      # points closer together than this are one spot
EPS_PX = 1e-3            # rounding: labels placed exactly at a threshold (stacked columns) meet it
RESERVED = ("items", "labels", "leaders", "canvas_edge")


def _quantile(vals: list[float], q: float) -> float | None:
    if not vals:
        return None
    s = sorted(vals)
    return s[min(len(s) - 1, int(q * (len(s) - 1) + 0.5))]


def data_points(prob, classes: dict, a_label: dict) -> list[tuple]:
    """The data points of a problem: ``(shape, owner)`` for the mark of every point item
    (``owner`` = its index) and every circle of a class labels do not ignore (``owner`` =
    None), except circles drawn exactly at an item's point (that item's own mark)."""
    pts = []
    refs = GridIndex(32.0)
    for it in prob.items:
        if it.anchor_type == "point" and it.shape is not None:
            pts.append((it.shape, it.index))
            refs.insert(it.index, Box(it.ref[0], it.ref[1], it.ref[0], it.ref[1]))
    for c, oc in sorted(classes.items()):
        if c in RESERVED or spec.avoid_value(a_label, c) == "ignore":
            continue
        for prim in oc.prims:
            if prim.kind != "circle":
                continue
            cx, cy = prim.shape.ref
            near = refs.query(Box(cx, cy, cx, cy).grow(COINCIDENT_PX))
            if any(math.dist(prob.items[j].ref, (cx, cy)) < COINCIDENT_PX for j in near):
                continue
            pts.append((prim.shape, None))
    return pts


def _index(points: list[tuple]) -> GridIndex:
    ix = GridIndex(32.0)
    for k, (shape, _owner) in enumerate(points):
        ix.insert(k, shape.bbox())
    return ix


def _others(prob, it, owner) -> bool:
    """A point that competes with item ``it``: not its own, not of its group."""
    if owner is None:
        return True
    if owner == it.index:
        return False
    g = it.raw.get("group")
    return g is None or prob.items[owner].raw.get("group") != g


def clarity(prob, placed: list, points: list[tuple], point_index: GridIndex, max_list: int = 25) -> dict:
    """The margin by which each label without a leader is nearer to its own point than to any
    other data point: ``m = d_other − d_own`` (signed distances from the label box), counted
    below each threshold of ``CLEAR_EM`` (``m < min(τ·em, distance between the two points)``),
    split by the kind of the nearer point (an item's mark or a background circle). Points the
    label hides entirely do not compete (``points_covered`` counts them). Rates are of all
    placed labels; internal labels are not measured. Leadered labels with another point
    nearer than the ``unclear`` margin count as ``leadered_unclear``."""
    counts = {k: 0 for k in CLEAR_EM}
    by_item = {k: 0 for k in CLEAR_EM}
    by_background = {k: 0 for k in CLEAR_EM}
    examples: dict[str, list] = {k: [] for k in CLEAR_EM}
    margins = []
    plain = leadered = leadered_unclear = 0
    leadered_examples = []
    for p in placed:
        if p.internal:
            continue
        it = p.item
        em = it.label.em
        if p.has_leader:
            # the leader says whose the label is, unless another point comes about as near as a
            # plain label's own point would be
            leadered += 1
            tau = CLEAR_EM["unclear"] * em
            for k in point_index.query(p.box.grow(tau)):
                shape, owner = points[k]
                if (_others(prob, it, owner) and math.dist(shape.ref, it.ref) >= COINCIDENT_PX
                        and not p.box.contains_box(shape.bbox()) and shape.sdist_box(p.box) < tau - EPS_PX):
                    leadered_unclear += 1
                    if len(leadered_examples) < max_list:
                        leadered_examples.append(p.id)
                    break
            continue
        plain += 1
        d_own = it.own_shape.sdist_box(p.box)
        reach = REACH_EM * em
        best = reach
        flags: dict[str, set[str]] = {}
        for k in point_index.query(p.box.grow(max(d_own, 0.0) + reach)):
            shape, owner = points[k]
            if not _others(prob, it, owner) or p.box.contains_box(shape.bbox()):
                continue  # its own, its group's, or hidden under the label
            sep = math.dist(shape.ref, it.ref)
            if sep < COINCIDENT_PX:
                continue
            m = shape.sdist_box(p.box) - d_own
            best = min(best, m)
            for name, tau in CLEAR_EM.items():
                if m < min(tau * em, sep) - EPS_PX:
                    flags.setdefault(name, set()).add("background" if owner is None else "item")
        margins.append(best / em)
        for name, kinds in flags.items():
            counts[name] += 1
            if "item" in kinds:
                by_item[name] += 1
            else:
                by_background[name] += 1
            if len(examples[name]) < max_list:
                examples[name].append(p.id)
    n = len(placed)
    return {"plain": plain,
            **{name: counts[name] for name in CLEAR_EM},
            **{f"{name}_rate": (counts[name] / n) if n else None for name in CLEAR_EM},
            "by_item": by_item, "by_background": by_background,
            "margin_p10_em": _quantile(margins, 0.1), "margin_p50_em": _quantile(margins, 0.5),
            "leadered": leadered, "leadered_unclear": leadered_unclear,
            "leadered_unclear_rate": (leadered_unclear / n) if n else None,
            "thresholds_em": dict(CLEAR_EM), "reach_em": REACH_EM,
            "examples": {**examples, "leadered_unclear": leadered_examples}}


def points_covered(prob, placed: list, points: list[tuple], box_index: GridIndex, tol: float,
                   max_list: int = 25) -> dict:
    """Data points (``data_points``) that a placed label other than their own overlaps (the
    label box shrunk by ``tol``) or hides entirely (``hidden``: inside the box), and the
    labels that cover any: whatever the avoidance settings, a covered point is hidden from
    the reader."""
    covered = covered_bg = hidden = 0
    total_bg = sum(1 for _s, owner in points if owner is None)
    labels: set[int] = set()
    examples = []
    for shape, owner in points:
        hit = inside = False
        bb = shape.bbox()
        for j in box_index.query(bb):
            p = placed[j]
            if not _others(prob, p.item, owner):
                continue
            if shape.intersects_box(p.box.shrink(tol)):
                hit = True
                inside = inside or p.box.contains_box(bb)
                labels.add(j)
                if len(examples) < max_list:
                    examples.append([p.id, prob.items[owner].id if owner is not None else None])
        if hit:
            covered += 1
            covered_bg += owner is None
            hidden += inside
    n_pts, n = len(points), len(placed)
    return {"total": n_pts, "covered": covered, "rate": (covered / n_pts) if n_pts else None, "hidden": hidden,
            "items_total": n_pts - total_bg, "items_covered": covered - covered_bg,
            "background_total": total_bg, "background_covered": covered_bg,
            "labels_covering": len(labels), "labels_covering_rate": (len(labels) / n) if n else None,
            "examples": examples}


def _box_gap(a: Box, b: Box) -> float:
    return math.hypot(max(0.0, a.x0 - b.x1, b.x0 - a.x1), max(0.0, a.y0 - b.y1, b.y0 - a.y1))


def label_spacing(placed: list, box_index: GridIndex) -> dict:
    """The gap from each placed label to the nearest other one, in em of the larger font of the
    two (overlapping labels: 0): pairs and labels below each threshold of ``CLOSE_EM``."""
    pairs = {name: 0 for name in CLOSE_EM}
    close_labels = 0
    nearest = []
    for k, p in enumerate(placed):
        em = p.item.label.em
        best = REACH_EM
        close = False
        for j in box_index.query(p.box.grow(REACH_EM * em)):
            if j == k:
                continue
            q = placed[j]
            e = max(em, q.item.label.em)
            d = _box_gap(p.box, q.box)
            best = min(best, d / e)
            close = close or d < CLOSE_EM["close"] * e - EPS_PX
            if j > k:
                for name, tau in CLOSE_EM.items():
                    if d < tau * e - EPS_PX:
                        pairs[name] += 1
        nearest.append(best)
        close_labels += close
    n = len(placed)
    return {**{f"pairs_{name}": pairs[name] for name in CLOSE_EM},
            "labels_close": close_labels, "labels_close_rate": (close_labels / n) if n else None,
            "nearest_p10_em": _quantile(nearest, 0.1), "nearest_p50_em": _quantile(nearest, 0.5),
            "thresholds_em": dict(CLOSE_EM)}


def evaluate_association(prob, placed: list, classes: dict, a_label: dict, box_index: GridIndex, tol: float,
                         max_list: int = 25) -> dict:
    points = data_points(prob, classes, a_label)
    ix = _index(points)
    return {"clarity": clarity(prob, placed, points, ix, max_list),
            "points": points_covered(prob, placed, points, box_index, tol, max_list),
            "spacing": label_spacing(placed, box_index)}


def summary_fields(a: dict) -> dict:
    """Headline association metrics for report tables."""
    c, pt, sp = a["clarity"], a["points"], a["spacing"]
    return {
        "clarity_misattributed_rate": c["misattributed_rate"],
        "clarity_unclear_rate": c["unclear_rate"],
        "clarity_weak_rate": c["weak_rate"],
        "clarity_unclear_background": c["by_background"]["unclear"],
        "clarity_margin_p10_em": c["margin_p10_em"],
        "leadered_unclear_rate": c["leadered_unclear_rate"],
        "points_covered": pt["covered"],
        "points_covered_rate": pt["rate"],
        "points_inside_labels": pt["hidden"],
        "labels_covering_points_rate": pt["labels_covering_rate"],
        "labels_close_rate": sp["labels_close_rate"],
        "label_gap_p10_em": sp["nearest_p10_em"],
    }
