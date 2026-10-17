"""Implementation-independent evaluation of one result (design brief §8.2).

``evaluate(problem, result, truth)`` re-derives everything from the JSON
problem/result pair (and the scenario's ``truth.json``): it never trusts the
result's own ``stats`` except for reporting them next to the re-verified values.
Hard tests use exact geometry with a tolerance of ``TOL`` = 0.5 px: a label box
violates something only if the box *shrunk by 0.5 px* still intersects it.
Metric definitions are documented in bench/README.md.
"""
from __future__ import annotations

import functools
import math
import statistics
from dataclasses import dataclass, field

from ..common import geom, spec
from ..common.geom import Box, GridIndex, Point
from ..common.model import (DIRECTIONS, PERCEPTUAL, Item, Problem, adjacent_box, load_problem,
                            position_order)
from . import classes as clsmod
from . import priority as pr
from . import visual as vis

TOL = 0.5
SIDES = tuple(DIRECTIONS)
PERCEPT_RANK = {s: i for i, s in enumerate(PERCEPTUAL)}
RESERVED = ("items", "labels", "leaders", "canvas_edge")


@dataclass
class Placed:
    id: str
    item: Item
    box: Box
    side: str | None
    model: str | None
    leaders: list[list[Point]] = field(default_factory=list)   # leader polylines (incl. fan leaders)
    underlines: list[list[Point]] = field(default_factory=list)
    ports: list[Point] = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    @property
    def internal(self) -> bool:
        return self.model == "internal" or self.side == "internal"

    @property
    def has_leader(self) -> bool:
        return bool(self.leaders)


@functools.lru_cache(maxsize=None)
def _result_validator():
    import jsonschema

    return jsonschema.Draft202012Validator(spec.schema("result"))


def _segments(pl: list[Point]):
    for i in range(len(pl) - 1):
        yield pl[i], pl[i + 1]


def _mean(v: list[float]) -> float | None:
    return float(statistics.fmean(v)) if v else None


def _parse_placed(prob: Problem, result: dict, checks: dict) -> tuple[list[Placed], dict[str, dict]]:
    by_id = {}
    for p in result.get("placements", []):
        if p.get("id") in by_id:
            checks["duplicate_ids"].append(p.get("id"))
        by_id[p.get("id")] = p
    items = prob.item_by_id()
    for pid in by_id:
        if pid not in items:
            checks["unknown_ids"].append(pid)
    placed = []
    for it in prob.items:
        p = by_id.get(it.id)
        if p is None:
            checks["missing_ids"].append(it.id)
            continue
        if not p.get("placed"):
            continue
        if "box" not in p:
            checks["placed_without_box"].append(it.id)
            continue
        leaders, unders, ports = [], [], []
        for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or []):
            pts = [tuple(q) for q in L.get("points", [])]
            if len(pts) >= 2:
                leaders.append(pts)
            if L.get("underline"):
                unders.append([tuple(q) for q in L["underline"]])
            if L.get("port"):
                ports.append(tuple(L["port"]))
        placed.append(Placed(it.id, it, Box.from_dict(p["box"]), p.get("anchor_side"), p.get("model"),
                             leaders, unders, ports, p))
    return placed, by_id


def evaluate(problem: dict, result: dict, truth: dict | None = None, *, tol: float = TOL,
             removal_test: bool = True, max_list: int = 25) -> dict:
    engine = pr.from_result(result.get("placements", []))
    prob = load_problem(problem, ranks={k: v.rank for k, v in engine.items()} if engine else None)
    opts = prob.opts
    a_label = opts.get("avoid", {}).get("label", {})
    a_leader = opts.get("avoid", {}).get("leader", {})
    checks = {"schema_errors": [], "duplicate_ids": [], "unknown_ids": [], "missing_ids": [],
              "placed_without_box": []}
    for e in sorted(_result_validator().iter_errors(result), key=lambda e: list(e.absolute_path))[:max_list]:
        checks["schema_errors"].append(f"/{'/'.join(map(str, e.absolute_path))}: {e.message[:200]}")
    placed, by_id = _parse_placed(prob, result, checks)
    n = len(prob.items)
    pidx = {p.id: k for k, p in enumerate(placed)}
    placed_ids = set(pidx)

    # ---------------------------------------------------------------- priority / ranks
    infos = pr.from_result(result.get("placements", []))
    rank_source = "result"
    if infos is None or set(infos) != {it.id for it in prob.items}:
        infos = pr.reference(prob)
        rank_source = "reference"
    ranks = {k: v.rank for k, v in infos.items()}
    gsum = sum(pr.gain(r) for r in ranks.values())
    placed_weighted = (sum(pr.gain(ranks[i]) for i in placed_ids) / gsum) if gsum > 0 else 0.0
    required = [it.id for it in prob.items if it.required]
    req_missing = [i for i in required if i not in placed_ids]

    # ---------------------------------------------------------------- indexes
    classes = clsmod.build_classes(prob, truth)
    box_index = GridIndex(32.0)
    for k, p in enumerate(placed):
        box_index.insert(k, p.box)
    item_index = GridIndex(32.0)       # marks of point items (class "items")
    shape_index = GridIndex(32.0)      # every item's own shape (ambiguity)
    for it in prob.items:
        if it.shape is not None:
            item_index.insert(it.index, it.shape.bbox())
        shape_index.insert(it.index, it.own_shape.bbox())

    hard = {"label_label": 0, "label_item": 0, "own_mark": 0, "internal_outside": 0, "canvas_edge": 0,
            "leader_leader": 0, "leader_near": 0, "leader_angle": 0, "leader_label": 0, "leader_own_label": 0,
            "leader_item": 0, "leader_canvas": 0}
    examples: dict[str, list] = {}

    def note(kind, what):
        lst = examples.setdefault(kind, [])
        if len(lst) < max_list:
            lst.append(what)

    labels_hard = spec.is_hard(a_label, "labels")
    items_hard = spec.is_hard(a_label, "items")
    edge_hard = spec.is_hard(a_label, "canvas_edge")
    own_policy = a_label.get("own_mark", "hard")
    hard_classes = sorted(c for c in classes if c not in RESERVED and spec.is_hard(a_label, c))
    leader_hard_classes = sorted(c for c in classes if c not in RESERVED and spec.is_hard(a_leader, c))
    area = prob.label_area()
    canvas = prob.canvas_box()

    # -- label vs label
    overlap_pairs = []
    for k, p in enumerate(placed):
        for j in box_index.query(p.box):
            if j <= k:
                continue
            ox, oy = p.box.overlap_extent(placed[j].box)
            if ox > tol and oy > tol:
                overlap_pairs.append((p.id, placed[j].id))
    if labels_hard:
        hard["label_label"] = len(overlap_pairs)
        for a, b in overlap_pairs[:max_list]:
            note("label_label", [a, b])

    # -- label vs items, own mark, internal containment, classes, canvas edge
    for p in placed:
        sb = p.box.shrink(tol)
        if items_hard:
            for j in item_index.query(sb):
                other = prob.items[j]
                if other.id == p.id:
                    continue
                if other.shape.intersects_box(sb):
                    hard["label_item"] += 1
                    note("label_item", [p.id, other.id])
        own = p.item.shape if p.item.shape is not None else p.item.dot
        if p.internal:
            shp = p.item.own_shape
            if not shp.contains_box(sb):
                hard["internal_outside"] += 1
                note("internal_outside", p.id)
        elif own is not None and own_policy != "ignore":
            if own_policy == "hard":
                if own.intersects_box(sb):
                    hard["own_mark"] += 1
                    note("own_mark", p.id)
            elif isinstance(own_policy, str) and own_policy.startswith("partial:"):
                f = float(own_policy.split(":", 1)[1])
                a = own.area()
                if a > 0 and own.clip_area(p.box) / a > f + 0.01:
                    hard["own_mark"] += 1
                    note("own_mark", p.id)
        for c in hard_classes:
            if classes[c].box_hits(sb):
                key = f"class:{c}"
                hard[key] = hard.get(key, 0) + 1
                note(key, p.id)
        if area is not None and edge_hard and not area.contains_box(p.box, tol):
            hard["canvas_edge"] += 1
            note("canvas_edge", p.id)

    # -- leaders
    seg_index = GridIndex(32.0)
    segs: list[tuple[int, Point, Point]] = []
    for k, p in enumerate(placed):
        for pl in p.leaders + p.underlines:
            for a, b in _segments(pl):
                sid = len(segs)
                segs.append((k, a, b))
                seg_index.insert(sid, Box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))
    crossing_pairs = set()
    for sid, (k, a, b) in enumerate(segs):
        q = Box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
        for tid in seg_index.query(q):
            if tid <= sid:
                continue
            k2, c, d = segs[tid]
            if k2 == k:
                continue
            if geom.segments_cross(a, b, c, d, tol):
                crossing_pairs.add((min(k, k2), max(k, k2)))
    leader_crossings = len(crossing_pairs)
    lopts = opts.get("leaders", {})

    def clearance(it):
        return spec.length(lopts.get("clearance", 3), it.label.em)

    if spec.is_hard(a_leader, "leaders"):
        hard["leader_leader"] = leader_crossings
        for a, b in sorted(crossing_pairs)[:max_list]:
            note("leader_leader", [placed[a].id, placed[b].id])
        # leaders closer than the clearance (except where both start), and distant leaders
        # starting within 1 em in nearly the same direction (spec §7)
        min_angle = float(lopts.get("min_angle_between", 10))
        with_leaders = [k for k, p in enumerate(placed) if p.leaders]
        reach = max((max(clearance(placed[k].item), placed[k].item.label.em) for k in with_leaders), default=0.0)
        lb_index = GridIndex(32.0)
        lbox = {}
        for k in with_leaders:
            pts = [q for pl in placed[k].leaders + placed[k].underlines for q in pl]
            lbox[k] = Box(min(q[0] for q in pts), min(q[1] for q in pts), max(q[0] for q in pts), max(q[1] for q in pts))
            lb_index.insert(k, lbox[k])
        near_pairs, angle_pairs = set(), set()
        for k in with_leaders:
            pk = placed[k]
            for k2 in sorted(set(lb_index.query(lbox[k].grow(reach)))):
                if k2 <= k or (k, k2) in crossing_pairs:
                    continue
                pk2 = placed[k2]
                clr = max(clearance(pk.item), clearance(pk2.item))
                near = max(pk.item.label.em, pk2.item.label.em)
                for A in vis.label_leaders(pk):
                    for B in vis.label_leaders(pk2):
                        d = vis.leader_approach(A, B, clr)
                        if d is not None and d < clr - tol:
                            near_pairs.add((k, k2))
                        if (min_angle > 0 and pk.model == "distant" and pk2.model == "distant"
                                and vis.leaders_parallel(A, B, near, min_angle - 0.05)):
                            angle_pairs.add((k, k2))
        hard["leader_near"] = len(near_pairs)
        hard["leader_angle"] = len(angle_pairs)
        for a, b in sorted(near_pairs)[:max_list]:
            note("leader_near", [placed[a].id, placed[b].id])
        for a, b in sorted(angle_pairs)[:max_list]:
            note("leader_angle", [placed[a].id, placed[b].id])
    leader_label_pairs = set()
    leader_item_pairs = set()
    leader_class_hits: dict[str, int] = {}
    lengths_em, bends = [], []
    leader_items_hard = spec.is_hard(a_leader, "items")
    baseline_port = opts.get("leaders", {}).get("port") == "baseline"
    for k, p in enumerate(placed):
        if not p.leaders:
            continue
        own_sb = p.box.shrink(tol)
        for pl in p.underlines:  # the underline is part of the leader (spec §7): other labels only
            for a, b in _segments(pl):
                q = Box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
                for j in box_index.query(q):
                    if j != k and geom.seg_box_intersects(a, b, placed[j].box.shrink(tol)):
                        leader_label_pairs.add((k, j))
        for li, pl in enumerate(p.leaders):
            lengths_em.append(geom.polyline_length(pl) / p.item.label.em)
            bends.append(max(0, len(pl) - 2))
            # with port "baseline" the leader ends at the underline below the first line, which can lie
            # inside the box: its last segment is exempt; every other leader must stay out of its label
            port_inside = baseline_port
            if canvas is not None and not all(canvas.grow(tol).contains_point(e) for e in pl):
                hard["leader_canvas"] += 1
                note("leader_canvas", p.id)
            seglist = list(_segments(pl))
            for si, (a, b) in enumerate(seglist):
                q = Box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1]))
                for j in box_index.query(q):
                    if j == k:
                        continue
                    if geom.seg_box_intersects(a, b, placed[j].box.shrink(tol)):
                        leader_label_pairs.add((k, j))
                if not (port_inside and si == len(seglist) - 1) and geom.seg_box_intersects(a, b, own_sb):
                    hard["leader_own_label"] += 1
                    note("leader_own_label", p.id)
                if leader_items_hard:
                    # leaders keep the clearance from other marks (spec §7); a fan leader must only
                    # not cross a mark closer than the clearance to its start (crowded marks)
                    r = clearance(p.item) - tol
                    start = pl[0]
                    for j in (item_index.query(q.grow(r)) if r > 0 else ()):
                        other = prob.items[j]
                        if (j, k) in leader_item_pairs or vis.exempt_mark(p.item, other):
                            continue
                        rr = r
                        if p.model == "fan":
                            if other.own_shape.contains(start):
                                continue
                            if other.own_shape.sdist(start) < clearance(p.item):
                                rr = 0.0
                        if other.shape.intersects_segment(a, b, rr):
                            leader_item_pairs.add((j, k))
                            note("leader_item", [p.id, other.id])
                for c in leader_hard_classes:
                    if classes[c].segment_hits(a, b):
                        leader_class_hits[c] = leader_class_hits.get(c, 0) + 1
                        note(f"leader_class:{c}", p.id)
    if spec.is_hard(a_leader, "labels"):
        hard["leader_label"] = len(leader_label_pairs)
        for a, b in sorted(leader_label_pairs)[:max_list]:
            note("leader_label", [placed[a].id, placed[b].id])
    if leader_items_hard:
        hard["leader_item"] = len(leader_item_pairs)
    for c, v in leader_class_hits.items():
        hard[f"leader_class:{c}"] = v
    hard_total = int(sum(v for v in hard.values()))

    # ---------------------------------------------------------------- soft coverage
    coverage: dict[str, dict] = {}
    for c, oc in sorted(classes.items()):
        if spec.avoid_value(a_label, c) == "ignore":
            coverage[c] = {"mean": None, "max": None, "touching": None, "hard": False, "weight": "ignore"}
            continue
        vals = [oc.covered(p.box) / p.box.area for p in placed if p.box.area > 0]
        coverage[c] = {"mean": _mean(vals), "max": max(vals) if vals else None,
                       "touching": (sum(1 for v in vals if v > 1e-3) / len(vals)) if vals else None,
                       "hard": spec.is_hard(a_label, c),
                       "weight": spec.avoid_value(a_label, c)}
    vals_items, vals_labels = [], []
    for k, p in enumerate(placed):
        if p.box.area <= 0:
            continue
        s = 0.0
        for j in item_index.query(p.box):
            other = prob.items[j]
            if other.id != p.id:
                s += other.shape.clip_area(p.box)
        vals_items.append(min(1.0, s / p.box.area))
        s = 0.0
        for j in box_index.query(p.box):
            if j != k:
                s += p.box.intersection_area(placed[j].box)
        vals_labels.append(min(1.0, s / p.box.area))
    for name, vals in (("items", vals_items), ("labels", vals_labels)):
        coverage[name] = {"mean": _mean(vals), "max": max(vals) if vals else None,
                          "touching": (sum(1 for v in vals if v > 1e-3) / len(vals)) if vals else None,
                          "hard": spec.is_hard(a_label, name), "weight": spec.avoid_value(a_label, name)}

    # ---------------------------------------------------------------- ambiguity
    ambiguous = []
    for p in placed:
        own = p.item.own_shape
        if p.has_leader:
            q = p.leaders[0][0]
            d_own = own.sdist(q)
            probe = Box(q[0], q[1], q[0], q[1]).grow(max(d_own, 0.0) + 1e-6)
            nearest_other = min((prob.items[j].own_shape.sdist(q) for j in shape_index.query(probe)
                                 if prob.items[j].id != p.id), default=math.inf)
        else:
            d_own = own.sdist_box(p.box)
            probe = p.box.grow(max(d_own, 0.0) + 1e-6)
            nearest_other = min((prob.items[j].own_shape.sdist_box(p.box) for j in shape_index.query(probe)
                                 if prob.items[j].id != p.id), default=math.inf)
        if nearest_other < d_own - 1e-6:
            ambiguous.append(p.id)

    # ---------------------------------------------------------------- shape fidelity
    gaps = []
    eligible = internal_ok = 0
    inner_pad_opt = opts.get("placement", {}).get("inner_padding", "0.2em")
    for p in placed:
        own = p.item.own_shape if p.item.shape is not None or p.internal else p.item.dot
        if not p.internal and not p.has_leader and p.model in ("adjacent", "slider", None) and own is not None:
            gaps.append(own.sdist_box(p.box) - p.item.offset)
        shp = p.item.own_shape
        pad = spec.length(inner_pad_opt, p.item.label.em)
        if shp.fits_box(p.box.w, p.box.h, pad):
            eligible += 1
            if p.internal:
                internal_ok += 1

    # ---------------------------------------------------------------- position preference
    pos_ranks = []
    hist = {s: 0 for s in PERCEPTUAL}
    for p in placed:
        if p.side in PERCEPT_RANK and not p.has_leader:
            pos_ranks.append(PERCEPT_RANK[p.side])
            hist[p.side] += 1

    # ---------------------------------------------------------------- priority fidelity
    order = sorted(prob.items, key=lambda it: ranks[it.id])
    prefix = 0
    for it in order:
        if it.id in placed_ids:
            prefix += 1
        else:
            break
    ndcg = pr.ndcg_at_k([ranks[i] for i in placed_ids], list(ranks.values()))
    inversions = None
    inversion_ids: list[str] = []
    if removal_test:
        inversion_ids, untestable_ids = _removal_test(prob, placed, infos, classes, hard_classes, tol)
        inversions = len(inversion_ids)
    else:
        untestable_ids = []
    cov_metrics = None
    cg = pr.coverage_groups(prob)
    if cg:
        groups, m = cg
        sat = []
        for g, ids in sorted(groups.items()):
            need = min(m, len(ids))
            got = sum(1 for i in ids if i in placed_ids)
            sat.append((g, got >= need, got, need))
        cov_metrics = {"groups": len(sat), "satisfied": sum(1 for s in sat if s[1]),
                       "satisfaction": sum(1 for s in sat if s[1]) / len(sat) if sat else None,
                       "unsatisfied": [s[0] for s in sat if not s[1]][:max_list], "min_per_group": m}

    # ---------------------------------------------------------------- text degradation
    deg = {"wrapped": 0, "alternative": 0, "truncated": 0, "shrunk": 0}
    n_text = 0
    for p in placed:
        infos_t = []
        if p.raw.get("text"):
            infos_t.append((p.raw["text"], p.item.label))
        for part in p.raw.get("parts") or []:
            if part.get("text"):
                infos_t.append((part["text"], None))
        if not infos_t:
            continue
        n_text += 1
        flags = set()
        for t, lab in infos_t:
            used = t.get("used", "original")
            lines = t.get("lines", [])
            has_wrap = lab.has_wrap if lab is not None else False
            if len(lines) > 1 and not has_wrap:
                flags.add("wrapped")
            if used.startswith("alternative"):
                flags.add("alternative")
            if used == "truncated" or t.get("truncated"):
                flags.add("truncated")
            nominal = lab.font_size if lab is not None else None
            if t.get("scale", 1.0) < 0.999 or (nominal is not None and t.get("font_size", nominal) < nominal - 1e-6):
                flags.add("shrunk")
        for f in flags:
            deg[f] += 1
    text_deg = {k: (v / n_text if n_text else None) for k, v in deg.items()}
    text_deg["n_text"] = n_text

    stats = result.get("stats", {}) or {}
    n_placed = len(placed)
    out = {
        "problem": {"n_items": n, "canvas": [prob.width, prob.height] if prob.bounded else None,
                    "preset": opts.get("preset"), "omission": opts.get("priority", {}).get("omission", "strict"),
                    "classes": sorted(classes), "hard_classes": hard_classes, "warnings": prob.warnings},
        "placement": {"placed": n_placed, "total": n, "placed_rate": n_placed / n if n else None,
                      "placed_weighted": placed_weighted, "required_total": len(required),
                      "required_placed": not req_missing, "required_missing": req_missing[:max_list],
                      "models": _hist(p.model or "none" for p in placed)},
        "hard": {"total": hard_total, **hard, "examples": examples},
        "leaders": {"count": sum(len(p.leaders) for p in placed),
                    "labels_with_leader": sum(1 for p in placed if p.leaders),
                    "rate": (sum(1 for p in placed if p.leaders) / n_placed) if n_placed else None,
                    "crossings": leader_crossings, "label_intersections": len(leader_label_pairs),
                    "length_mean_em": _mean(lengths_em), "length_max_em": max(lengths_em) if lengths_em else None,
                    "bends_mean": _mean(bends), "bends_max": max(bends) if bends else None},
        "coverage": coverage,
        "ambiguity": {"rate": (len(ambiguous) / n_placed) if n_placed else None, "count": len(ambiguous),
                      "examples": ambiguous[:max_list]},
        "shape": {"adjacent_n": len(gaps), "adjacent_gap_mean": _mean(gaps),
                  "adjacent_gap_abs_mean": _mean([abs(g) for g in gaps]),
                  "adjacent_gap_max_abs": max((abs(g) for g in gaps), default=None),
                  "adjacent_touch_rate": (sum(1 for g in gaps if abs(g) <= tol) / len(gaps)) if gaps else None,
                  "own_mark_violations": hard["own_mark"], "internal_outside": hard["internal_outside"],
                  "internal_eligible": eligible,
                  "internal_rate": (internal_ok / eligible) if eligible else None},
        "position": {"n": len(pos_ranks), "rank_mean": _mean(pos_ranks), "hist": hist},
        "priority": {"rank_source": rank_source, "prefix_length": prefix, "prefix_rate": prefix / n if n else None,
                     "ndcg_at_k": ndcg, "k": n_placed, "inversions": inversions,
                     "inversion_examples": inversion_ids[:max_list],
                     "removal_untestable": len(untestable_ids),
                     "reported_inversions": stats.get("priority_inversions"), "coverage": cov_metrics,
                     "placed_weighted": placed_weighted},
        "text": text_deg,
        "runtime": {"runtime_ms": stats.get("runtime_ms"), "iterations": stats.get("iterations"),
                    "time_guard_hit": stats.get("time_guard_hit"), "candidates": stats.get("candidates"),
                    "implementation": stats.get("implementation"), "phases_ms": stats.get("phases_ms")},
        "reported": {k: stats.get(k) for k in ("placed", "total", "hard_violations", "leader_crossings",
                                                "priority_inversions", "placed_weighted")},
        "result_check": {k: v[:max_list] for k, v in checks.items()},
        "visual": vis.evaluate_visual(prob, placed, classes, a_label, a_leader, max_list),
    }
    out["summary"] = summary(out)
    return out


def _hist(vals) -> dict:
    h: dict[str, int] = {}
    for v in vals:
        h[v] = h.get(v, 0) + 1
    return dict(sorted(h.items()))


def summary(m: dict) -> dict:
    """Flat headline metrics for report tables."""
    cov = m["coverage"]
    soft = [v["mean"] for k, v in cov.items() if v["mean"] is not None and not v["hard"] and k != "labels"]
    return {
        "placed": m["placement"]["placed"], "total": m["placement"]["total"],
        "placed_rate": m["placement"]["placed_rate"], "placed_weighted": m["placement"]["placed_weighted"],
        "hard_violations": m["hard"]["total"], "leader_crossings": m["leaders"]["crossings"],
        "leader_rate": m["leaders"]["rate"], "ambiguity_rate": m["ambiguity"]["rate"],
        "adjacent_gap_abs_mean": m["shape"]["adjacent_gap_abs_mean"], "internal_rate": m["shape"]["internal_rate"],
        "position_rank_mean": m["position"]["rank_mean"], "priority_inversions": m["priority"]["inversions"],
        "prefix_rate": m["priority"]["prefix_rate"], "ndcg_at_k": m["priority"]["ndcg_at_k"],
        "coverage_satisfaction": (m["priority"]["coverage"] or {}).get("satisfaction"),
        "soft_coverage_mean": _mean(soft), "runtime_ms": m["runtime"]["runtime_ms"],
        "schema_errors": len(m["result_check"]["schema_errors"]),
        **(vis.summary_fields(m["visual"]) if "visual" in m else {}),
    }


def _candidate_positions(it: Item) -> list[tuple[str, Box]]:
    """Candidates of the removal test that the item may actually use: the fixed adjacent positions of
    its position order (when the ``adjacent`` model is enabled; an explicit list restricts them, spec
    §6.1) and, for area anchors, the pole of inaccessibility (unless ``internal: never``)."""
    w, h = it.label.w, it.label.h
    out = []
    if it.anchor_type == "area":
        if it.internal != "never":
            c = it.area.inner_center()
            out.append(("internal", Box(c[0] - w / 2, c[1] - h / 2, c[0] + w / 2, c[1] + h / 2)))
        shape = it.dot
    else:
        shape = it.shape
    if "adjacent" in (it.models or ["adjacent"]):
        for s in position_order(it.position_order):
            if s in DIRECTIONS:
                out.append((s, adjacent_box(shape, it.offset, w, h, s)))
    return out


def _removal_test(prob: Problem, placed: list[Placed], infos: dict, classes: dict, hard_classes: list[str],
                  tol: float) -> list[str]:
    """Omitted items that have a feasible adjacent position given only the placed items of
    higher or equal key (spec §9.2 removal test, 8 adjacent positions + area pole).

    Conservative: a position counts as feasible only if the label box *grown* by ``tol``
    is free, so contacts within the tolerance never produce an inversion.
    """
    opts = prob.opts
    band = float(opts.get("priority", {}).get("band", 0) or 0)
    keys = pr.keys(infos, band)
    a_label = opts.get("avoid", {}).get("label", {})
    a_leader = opts.get("avoid", {}).get("leader", {})
    labels_hard = spec.is_hard(a_label, "labels")
    items_hard = spec.is_hard(a_label, "items")
    leader_labels_hard = spec.is_hard(a_leader, "labels")
    edge_hard = spec.is_hard(a_label, "canvas_edge")
    area = prob.label_area()
    placed_ids = {p.id for p in placed}
    item_index = GridIndex(32.0)
    for it in prob.items:
        if it.shape is not None:
            item_index.insert(it.index, it.shape.bbox())
    order = sorted(placed, key=lambda p: keys[p.id], reverse=True)
    box_index = GridIndex(32.0)
    seg_list: list[tuple[int, Point, Point]] = []
    seg_index = GridIndex(32.0)
    for k, p in enumerate(order):
        box_index.insert(k, p.box)
        for pl in p.leaders + p.underlines:
            for a, b in _segments(pl):
                seg_index.insert(len(seg_list), Box(min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))
                seg_list.append((k, a, b))
    out = []
    untestable = []
    for it in prob.items:
        if it.id in placed_ids:
            continue
        kh = keys[it.id]
        cands = _candidate_positions(it)
        if not cands:
            untestable.append(it.id)
        for _side, b in cands:
            g = b.grow(tol)
            if area is not None and edge_hard and not area.contains_box(b):
                continue
            ok = True
            if labels_hard:
                for k in box_index.query(g):
                    if keys[order[k].id] >= kh and order[k].box.overlaps(g):
                        ok = False
                        break
            if ok and leader_labels_hard:
                for s in seg_index.query(g):
                    k, a, c = seg_list[s]
                    if keys[order[k].id] >= kh and geom.seg_box_intersects(a, c, g):
                        ok = False
                        break
            if ok and items_hard:
                for j in item_index.query(g):
                    other = prob.items[j]
                    if other.id != it.id and other.shape.intersects_box(g):
                        ok = False
                        break
            if ok:
                for c in hard_classes:
                    if classes[c].box_hits(g):
                        ok = False
                        break
            if ok:
                out.append(it.id)
                break
    return out, untestable


def evaluate_files(problem_path: str, result_path: str, truth_path: str | None = None, **kw) -> dict:
    from ..common.jsonio import read_json

    truth = read_json(truth_path) if truth_path else None
    return evaluate(read_json(problem_path), read_json(result_path), truth, **kw)
