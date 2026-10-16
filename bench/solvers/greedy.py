"""Greedy baseline: priority order × the 8 fixed adjacent positions, first free one wins.

Items are processed in the evaluator's reference priority order (spec §9.1 key
and tie rule). For each item the 8 adjacent positions (spec §6.1 support-function
placement around the true shape ⊕ offset) are tried in the item's position
order; a position is taken if the label box stays inside the label area and
does not overlap (beyond 0.5 px) placed labels, other items' marks, or hard
classes. Area anchors first try an internal box at their pole. No leaders, no
degradation ladder, no local search — a classic baseline (Christensen et al.'s
"greedy" in the label placement literature).

    python -m bench.solvers.greedy problem.json -o result.json
"""
from __future__ import annotations

import argparse
import time

from ..common import spec
from ..common.geom import Box, GridIndex
from ..common.jsonio import read_json, write_json
from ..common.model import adjacent_box, load_problem, position_order
from ..eval import classes as clsmod
from ..eval import priority as pr
from .common import placement, result

IMPLEMENTATION = "bench-greedy/0.1"
TOL = 0.5


def solve(problem: dict) -> dict:
    t0 = time.perf_counter()
    prob = load_problem(problem)
    opts = prob.opts
    a_label = opts.get("avoid", {}).get("label", {})
    classes = clsmod.build_classes(prob, None)
    hard = [c for c in sorted(classes) if c not in ("items", "labels", "leaders", "canvas_edge")
            and spec.is_hard(a_label, c)]
    items_hard = spec.is_hard(a_label, "items")
    area = prob.label_area()
    infos = pr.reference(prob)
    order = sorted(prob.items, key=lambda it: infos[it.id].rank)
    mark_index = GridIndex(32.0)
    for it in prob.items:
        if it.shape is not None:
            mark_index.insert(it.index, it.shape.bbox())
    placed_index = GridIndex(32.0)
    placed_boxes: list[Box] = []
    out = {}
    budget = opts.get("priority", {}).get("budget", {}).get("max_labels")

    def free(it, b: Box) -> bool:
        if area is not None and not area.contains_box(b, TOL):
            return False
        sb = b.shrink(TOL)
        for k in placed_index.query(sb):
            ox, oy = placed_boxes[k].overlap_extent(b)
            if ox > TOL and oy > TOL:
                return False
        if items_hard:
            for j in mark_index.query(sb):
                other = prob.items[j]
                if other.id != it.id and other.shape.intersects_box(sb):
                    return False
        return not any(classes[c].box_hits(sb) for c in hard)

    for it in order:
        if budget is not None and len(placed_boxes) >= budget:
            out[it.id] = placement(it, None, reason="omitted_by_priority")
            continue
        w, h = it.label.w, it.label.h
        cands = []
        if it.anchor_type == "area":
            c = it.area.inner_center()
            cands.append(("internal", "internal", Box(c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2)))
            shape = it.dot
        else:
            shape = it.shape
        for side in position_order(it.position_order):
            cands.append((side, "adjacent", adjacent_box(shape, it.offset, w, h, side)))
        chosen = None
        for side, model, b in cands:
            if model == "internal" and not it.area.contains_box(b.grow(TOL)):
                continue
            if free(it, b):
                chosen = (side, model, b)
                break
        if chosen is None:
            out[it.id] = placement(it, None, reason="no_feasible_candidate")
            continue
        side, model, b = chosen
        placed_index.insert(len(placed_boxes), b)
        placed_boxes.append(b)
        out[it.id] = placement(it, b, side, model)
    placements = [out[it.id] for it in prob.items]
    for it, p in zip(prob.items, placements):
        inf = infos[it.id]
        p["priority"] = {"tier": inf.tier, "score": inf.score, "rank": inf.rank, "required": inf.required,
                         "reserved": inf.reserved}
    omitted = sorted((it for it in prob.items if not out[it.id]["placed"]), key=lambda it: infos[it.id].rank)
    res = result(placements, (time.perf_counter() - t0) * 1000.0, IMPLEMENTATION)
    res["stats"]["omission_order"] = [it.id for it in omitted]
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem)), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
