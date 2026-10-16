"""Result construction shared by the baseline solvers."""
from __future__ import annotations

from ..common.geom import Box
from ..common.model import Item, LabelSpec


def text_info(lab: LabelSpec, used: str = "original") -> dict | None:
    lay = lab.layout
    if lay is None:
        return None
    return {"lines": list(lay.lines), "used": lay.used if lay.used != "original" else used,
            "truncated": bool(lay.truncated),
            "baseline_offsets": [lab.padding + b for b in lay.baselines],
            "line_widths": list(lay.line_widths), "x_offset": lab.padding, "font_size": lay.font_size,
            "font_family": "default", "font_weight": lay.font_weight, "scale": 1.0}


def parts_info(lab: LabelSpec, box: Box) -> list[dict] | None:
    if lab.kind != "composite":
        return None
    out = []
    for p in lab.parts:
        e = {"type": p.kind if p.kind in ("text", "icon", "box") else "box",
             "box": {"x": box.x0 + p.x, "y": box.y0 + p.y, "w": p.w, "h": p.h}}
        if p.layout is not None:
            e["text"] = {"lines": list(p.layout.lines), "used": "original",
                         "baseline_offsets": [p.padding + b for b in p.layout.baselines],
                         "line_widths": list(p.layout.line_widths), "x_offset": p.padding,
                         "font_size": p.layout.font_size, "font_family": "default",
                         "font_weight": p.layout.font_weight, "scale": 1.0}
        out.append(e)
    return out


def placement(it: Item, box: Box | None, side: str | None = None, model: str | None = None,
              reason: str | None = None) -> dict:
    if box is None:
        return {"id": it.id, "placed": False, "reason": reason or "no_feasible_candidate"}
    p = {"id": it.id, "placed": True, "box": box.as_dict(), "anchor_side": side, "model": model, "leader": None}
    t = text_info(it.label)
    if t is not None:
        p["text"] = t
    parts = parts_info(it.label, box)
    if parts:
        p["parts"] = parts
    return p


def result(placements: list[dict], runtime_ms: float, implementation: str, **extra) -> dict:
    stats = {"placed": sum(1 for p in placements if p["placed"]), "total": len(placements),
             "hard_violations": 0, "leader_crossings": 0, "runtime_ms": runtime_ms, "seed": 0,
             "omission_order": [p["id"] for p in placements if not p["placed"]], "priority_inversions": 0,
             "implementation": implementation}
    stats.update(extra)
    return {"version": "1", "placements": placements, "stats": stats}
