"""Turn a tool's output (label boxes and connector lines in canvas px) into a result.v1 document.

Every adapter reports the problem's own label box (spec §5 measurement, padding
included) at the position the tool chose, so the evaluator and the renderer
treat all solvers alike. A connector line becomes a ``leader`` only when the
tool drew one *and* the label box is farther than ``offset + 0.5`` px from the
mark's bounding box along x or y (max-norm): the tools' adjacent positions,
diagonal ones offset along both axes included, get a short stub at most, which
is not a leader. Emulations and unsupported features are listed in
``warnings`` (codes ``baseline_emulation`` / ``baseline_unsupported``).
"""
from __future__ import annotations

from ..common.geom import Box, Point
from ..solvers.common import parts_info, text_info
from .scene import LabelItem, Scene, clip_start, side_of

TOL = 0.5


def leader_for(lab: LabelItem, box: Box, port: Point | None) -> dict | None:
    """Straight leader from the mark's boundary to ``port`` on the box, or None for adjacent labels."""
    if port is None:
        return None
    mb = lab.mark_box
    dx = max(mb.x0 - box.x1, box.x0 - mb.x1, 0.0)
    dy = max(mb.y0 - box.y1, box.y0 - mb.y1, 0.0)
    if max(dx, dy) <= lab.offset + TOL:
        return None
    start = clip_start(lab.shape, (lab.x, lab.y), port)
    if start is None or (abs(start[0] - port[0]) < 1e-9 and abs(start[1] - port[1]) < 1e-9):
        return None
    return {"points": [[start[0], start[1]], [port[0], port[1]]], "style": "straight", "port": [port[0], port[1]]}


def is_internal(lab: LabelItem, box: Box) -> bool:
    """The box lies inside the item's own shape (shrunk by the tolerance, as the evaluator tests internal
    labels) and the problem allows internal labels for the item: an internal label, not one covering its
    own mark."""
    it = lab.item
    if it.internal == "never" or "internal" not in (it.models or []):
        return False
    return it.own_shape.contains_box(box.shrink(TOL))


def build_result(scene: Scene, boxes: dict[str, Box], ports: dict[str, Point | None], runtime_ms: float,
                 implementation: str, tool_notes: list | None = None) -> dict:
    """``boxes``: placed labels (canvas px); ``ports``: end point of the tool's connector on the box (or None)."""
    by_id = {lab.id: lab for lab in scene.labels}
    omitted = {it.id: reason for it, reason in scene.omitted}
    placements = []
    for it in scene.problem.items:
        inf = scene.infos[it.id]
        prio = {"tier": inf.tier, "score": inf.score, "rank": inf.rank, "required": inf.required,
                "reserved": inf.reserved}
        lab = by_id.get(it.id)
        box = boxes.get(it.id) if lab is not None else None
        if box is None:
            placements.append({"id": it.id, "placed": False,
                               "reason": omitted.get(it.id, "no_feasible_candidate"), "priority": prio})
            continue
        leader = leader_for(lab, box, ports.get(it.id))
        if leader:
            side, model = "distant", "distant"
        elif is_internal(lab, box):
            side, model = "internal", "internal"
        else:
            side, model = side_of(box, lab.x, lab.y), "slider"
        p = {"id": it.id, "placed": True, "box": box.as_dict(), "anchor_side": side, "model": model,
             "leader": leader, "priority": prio}
        t = text_info(it.label)
        if t is not None:
            p["text"] = t
        parts = parts_info(it.label, box)
        if parts:
            p["parts"] = parts
        placements.append(p)
    omitted_order = sorted((p for p in placements if not p["placed"]), key=lambda p: p["priority"]["rank"])
    stats = {"placed": sum(1 for p in placements if p["placed"]), "total": len(placements), "hard_violations": 0,
             "leader_crossings": 0, "runtime_ms": max(0.0, float(runtime_ms)), "seed": 0,
             "omission_order": [p["id"] for p in omitted_order], "priority_inversions": 0,
             "implementation": implementation}
    warnings = []
    for n in list(scene.notes) + list(tool_notes or []):
        warnings.append({"code": f"baseline_{n.kind}", "pointer": n.pointer, "message": f"{n.feature}: {n.message}"})
    return {"version": "1", "placements": placements, "stats": stats, "warnings": warnings}


def baseline_info(result: dict) -> dict:
    """Tool, version and emulation notes of a baseline result (for results.json and the report)."""
    impl = (result.get("stats") or {}).get("implementation", "")
    emul, unsup = [], []
    for w in result.get("warnings") or []:
        if w.get("code") == "baseline_emulation":
            emul.append(w.get("message", ""))
        elif w.get("code") == "baseline_unsupported":
            unsup.append(w.get("message", ""))
    return {"implementation": impl, "emulations": emul, "unsupported": unsup}
