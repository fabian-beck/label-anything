"""truth.json: the exact geometry of every obstacle class of a problem, in canvas px.

Format (version 1)::

    {"version": 1, "canvas": [W, H],
     "classes": {<class>: {"circles": [[x, y, r]], "rects": [[x, y, w, h]],
                           "polylines": [{"points": [[x, y], ...], "width": w}],
                           "polygons": [{"rings": [[[x, y], ...], ...], "fill_rule": "evenodd"}]}},
     "rasters": [{"index": i, "mode": ..., "class": ..., "scale": s, "offset": [x, y]}],
     "includes_problem_vectors": true}

Vector classes come from two places: the background drawing (SVG backgrounds,
emitted by ``Scene.truth``) and the problem's ``obstacles.vector`` layers (mapped
to canvas px with ``transform`` / ``y_axis``; positioned shapes become polygons).
Raster classes cannot be listed as geometry: ``rasters`` documents which problem
raster source produces which class, and the evaluator derives the per-pixel mask
with the definitions of spec §4.6. Item marks (class ``items``) are defined by
the problem's anchors (spec §3.2) and are not repeated here.
"""
from __future__ import annotations

from .geom import Circle, RoundedRect
from .model import load_problem


def _entry(classes: dict, cls: str) -> dict:
    return classes.setdefault(cls, {"circles": [], "rects": [], "polylines": [], "polygons": []})


def complete_truth(problem: dict, scene_truth: dict | None = None) -> dict:
    prob = load_problem(problem)
    out = {"version": 1, "canvas": [prob.width, prob.height] if prob.bounded else None, "classes": {}}
    classes = out["classes"]
    for cls, e in ((scene_truth or {}).get("classes") or {}).items():
        t = _entry(classes, cls)
        for k in ("circles", "rects", "polylines", "polygons"):
            t[k].extend(e.get(k, []))
    for cls, prims in sorted(prob.vectors.items()):
        t = _entry(classes, cls)
        for p in prims:
            if p.kind == "polyline":
                t["polylines"].append({"points": [list(q) for q in p.points], "width": p.width})
            elif isinstance(p.shape, Circle):
                t["circles"].append([p.shape.cx, p.shape.cy, p.shape.r])
            elif p.kind == "rect" and isinstance(p.shape, RoundedRect) and not p.shape.cr and not p.shape.rotation:
                s = p.shape
                t["rects"].append([s.cx - s.w / 2, s.cy - s.h / 2, s.w, s.h])
            else:
                rings = [[list(q) for q in r] for r in p.shape.rings()]
                t["polygons"].append({"rings": rings, "fill_rule": getattr(p.shape, "fill_rule", "nonzero")})
    for e in classes.values():
        for k in [k for k, v in e.items() if not v]:
            del e[k]
    out["classes"] = {k: v for k, v in classes.items() if v}
    obs = problem.get("obstacles") or {}
    rasters = obs.get("raster")
    rlist = rasters if isinstance(rasters, list) else ([rasters] if rasters else [])
    out["rasters"] = [{"index": i, "mode": r.get("mode", "ink"), "class": r.get("class", "ink"),
                       "scale": r.get("scale", 1), "offset": r.get("offset", [0, 0]),
                       "derived_from": f"problem.obstacles.raster[{i}] (spec §4.6, per pixel)"}
                      for i, r in enumerate(rlist)]
    out["includes_problem_vectors"] = True
    return out
