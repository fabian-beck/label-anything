"""Builders for small hand-made problems and results.

Labels use host-measured sizes (``width``/``height``, padding 0) so that the
expected values do not depend on text measurement.
"""
from __future__ import annotations

import math

S2 = 1.0 / math.sqrt(2.0)


def item(iid, x, y, w=30, h=10, r=2, **kw):
    it = {"id": iid, "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": r}},
          "label": {"type": "text", "text": iid, "width": w, "height": h, "padding": 0}}
    it.update(kw)
    return it


def problem(items, width=200, height=100, padding=4, **kw):
    p = {"version": "1", "canvas": {"width": width, "height": height, "padding": padding}, "items": items,
         "preset": "none"}
    p.update(kw)
    return p


def placed(iid, x, y, w=30, h=10, side="top-right", model="adjacent", **kw):
    p = {"id": iid, "placed": True, "box": {"x": x, "y": y, "w": w, "h": h}, "anchor_side": side, "model": model}
    p.update(kw)
    return p


def omitted(iid, reason="omitted_by_priority"):
    return {"id": iid, "placed": False, "reason": reason}


def result(placements, **stats):
    st = {"placed": sum(1 for p in placements if p.get("placed")), "total": len(placements), "hard_violations": 0,
          "leader_crossings": 0, "runtime_ms": 1.0, "seed": 0, "omission_order": [], "priority_inversions": 0}
    st.update(stats)
    return {"version": "1", "placements": placements, "stats": st}


def top_right_box(x, y, r=2.0, offset=1.0, w=30, h=10):
    """Box of the top-right adjacent position around a circle (spec §6.1)."""
    sx = x + (r + offset) * S2
    sy = y - (r + offset) * S2
    return sx, sy - h
