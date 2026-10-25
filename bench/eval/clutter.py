"""Clutter: how much visual detail the labels and leaders add to the picture.

Edge density, the share of a picture's pixels that lie on an edge, measures how cluttered a
picture looks: it predicts judgments of visual complexity (Mack & Oliva 2004) and the effect
of clutter on visual search about as well as the more elaborate feature-congestion and
subband-entropy measures (Rosenholtz, Li & Nakano 2007; Henderson, Chanceaux & Smith 2009).
The labels' part of it is computed here from the geometry, not from a rendering
(ADR project/benchmark-measures):

* **text**: the length of the outlines of the glyphs of every placed text (the bundled Noto
  Sans; a glyph the font lacks counts as its ``.notdef`` box), at the reported font size;
* **leaders**: twice the length of every leader and underline, the two edges of its stroke;
* **icons and boxes**: the perimeter of their boxes, which renderers fill.

``edge_density`` is their sum per canvas pixel: the share of the pixels of a rendering at
1 px per canvas pixel that lie on a label's edge. On the 469 results of eight variants of the
engine's options over the benchmark it agrees with the Canny edge density of the rendered
labels (Pearson r = 0.991 pooled, 0.993 for changes within a problem), which counts a leader
as about 2.5 times its length against text outlines. The number of labels (r = 0.60) and
the share of the canvas their boxes cover (r = 0.96) agree less: a long name, a wrapped
one or a leader adds more than a short label beside its mark. Local measures, such as the
90th percentile of the edge density in windows of 8 em, agree less still (r = 0.84).

The measure counts what the labels add, not what they hide: data under labels is measured
by ``points`` and ``labels_over`` (``association.py``, ``visual.py``).
"""
from __future__ import annotations

import functools
import math

from ..common import text as textmod

# a glyph without an entry in the cmap is drawn as .notdef: count it as that glyph
NOTDEF = 0


@functools.lru_cache(maxsize=4)
def _outlines(weight: int) -> tuple[dict[int, float], float]:
    """Outline length of the glyph of every mapped code point, in em, and that of .notdef."""
    from fontTools.pens.perimeterPen import PerimeterPen
    from fontTools.ttLib import TTFont

    f = TTFont(textmod.font_file(weight))
    glyphs = f.getGlyphSet()
    upem = f["head"].unitsPerEm
    by_name: dict[str, float] = {}

    def length(name: str) -> float:
        if name not in by_name:
            pen = PerimeterPen(glyphs, tolerance=0.005)
            glyphs[name].draw(pen)
            by_name[name] = pen.value / upem
        return by_name[name]

    cmap = {cp: length(name) for cp, name in f.getBestCmap().items()}
    return cmap, length(f.getGlyphOrder()[NOTDEF])


def text_edges(t: dict) -> float:
    """Outline length of a placed text (``placements[].text`` or a part's ``text``), px."""
    size = float(t.get("font_size", 12))
    weight = 700 if textmod.resolve_weight(t.get("font_weight", 400)) >= 550 else 400
    cmap, notdef = _outlines(weight)
    em = 0.0
    for line in t.get("lines", []):
        for ch in line:
            if not ch.isspace():
                em += cmap.get(ord(ch), notdef)
    return em * size


def _polyline(pts) -> float:
    return sum(math.dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def _box_perimeter(b: dict) -> float:
    return 2.0 * (b["w"] + b["h"])


def label_edges(p: dict) -> tuple[float, float]:
    """(text, icon and box edges; leader edges) of one placed label, px."""
    own = 0.0
    if p.get("text"):
        own += text_edges(p["text"])
    parts = p.get("parts") or []
    for part in parts:
        if part.get("text"):
            own += text_edges(part["text"])
        elif part.get("box"):
            own += _box_perimeter(part["box"])
    if not p.get("text") and not parts and p.get("box"):
        own += _box_perimeter(p["box"])
    lead = 0.0
    for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or []):
        for key in ("points", "underline"):
            pts = L.get(key) or []
            if len(pts) >= 2:
                lead += 2.0 * _polyline(pts)
    return own, lead


def evaluate_clutter(prob, placed: list) -> dict:
    """Edge density of the placed labels and leaders (``placed``: the evaluator's ``Placed``)."""
    if prob.bounded:
        area = prob.width * prob.height
    else:
        # an unbounded problem: the extent of the marks and labels
        boxes = [p.box for p in placed] + [it.own_shape.bbox() for it in prob.items if it.own_shape is not None]
        if boxes:
            x0, y0 = min(b.x0 for b in boxes), min(b.y0 for b in boxes)
            x1, y1 = max(b.x1 for b in boxes), max(b.y1 for b in boxes)
            area = (x1 - x0) * (y1 - y0)
        else:
            area = 0.0
    own_total = lead_total = box_area = 0.0
    per_label = []
    for p in placed:
        own, lead = label_edges(p.raw)
        own_total += own
        lead_total += lead
        box_area += p.box.area
        per_label.append((own + lead) / p.item.label.em)
    total = own_total + lead_total
    n = len(placed)
    rate = (lambda v: v / area) if area > 0 else (lambda v: None)
    return {
        "edge_density": rate(total),
        "text": rate(own_total),
        "leaders": rate(lead_total),
        "leader_share": lead_total / total if total > 0 else None,
        "per_label_em": sum(per_label) / n if n else None,
        "edges_px": total,
        "box_area": rate(box_area),
    }


def summary_fields(c: dict) -> dict:
    """Headline clutter metrics for report tables."""
    return {"clutter": c["edge_density"], "clutter_leader_share": c["leader_share"],
            "clutter_per_label_em": c["per_label_em"]}
