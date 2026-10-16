"""Priority bookkeeping for the evaluator (spec §9).

Ranks and keys come from the result's ``placements[].priority`` when every
placement reports it (the engine's own computation). Otherwise a *reference*
priority is computed from the problem: explicit ``item.priority`` / ``tier`` /
``required``, ``priority.terms`` (``attr``, ``expr`` and the built-in terms
listed in ``BUILTIN_APPROX``), ``priority.tiers`` rules, ``priority.coverage``
reservations and the tie rule — documented as an approximation for built-in
terms whose exact definition lives in the engine.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

from ..common import spec
from ..common.model import Item, Problem
from . import expr as ex

BUILTIN_APPROX = {
    "outlierness": "mean distance to the k nearest other anchors (px)",
    "isolation": "distance to the nearest other anchor (px)",
    "crowding": "negative number of anchors within 4 em",
    "label_size": "label box area (px²) of the normal variant",
    "mark_size": "mark area (px²)",
    "centrality": "negative distance to priority.focus (default: canvas center)",
    "degree": "attrs.degree when present",
    "input_order": "negative input index",
}


@dataclass
class PriorityInfo:
    rank: int
    tier: int
    score: float
    required: bool
    reserved: bool


def gain(rank: int) -> float:
    return 1.0 / math.log2(rank + 2)


def from_result(placements: list[dict]) -> dict[str, PriorityInfo] | None:
    out = {}
    for p in placements:
        pr = p.get("priority")
        if not pr or "rank" not in pr:
            return None
        out[p["id"]] = PriorityInfo(int(pr["rank"]), int(pr.get("tier", 0)), float(pr.get("score", 0.0)),
                                    bool(pr.get("required", False)), bool(pr.get("reserved", False)))
    return out


def _knn_mean(items: list[Item], k: int) -> list[float]:
    import numpy as np

    pts = np.array([it.ref for it in items], dtype=np.float64)
    n = len(pts)
    if n <= 1:
        return [0.0] * n
    k = min(k, n - 1)
    out = []
    for i in range(n):
        d = np.sqrt(((pts - pts[i]) ** 2).sum(axis=1))
        d[i] = np.inf
        out.append(float(np.sort(d)[:k].mean()))
    return out


def _builtin_values(name: str, prob: Problem, term: dict) -> list[float | None]:
    items = prob.items
    if name == "outlierness":
        return _knn_mean(items, int(term.get("k", spec.element_default("priority.term.k"))))
    if name == "isolation":
        return _knn_mean(items, 1)
    if name == "crowding":
        out = []
        for it in items:
            r = 4 * it.label.em
            out.append(-float(sum(1 for o in items if o is not it and math.dist(o.ref, it.ref) <= r)))
        return out
    if name == "label_size":
        return [it.label.w * it.label.h for it in items]
    if name == "mark_size":
        return [it.own_shape.area() for it in items]
    if name == "centrality":
        focus = prob.raw.get("priority", {}).get("focus")
        if focus:
            f = prob.tx(*focus)
        elif prob.width is not None:
            f = (prob.width / 2, prob.height / 2)
        else:
            f = (0.0, 0.0)
        return [-math.dist(it.ref, f) for it in items]
    if name == "degree":
        out = []
        for it in items:
            v = it.attrs.get("degree")
            out.append(float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
        return out
    if name == "input_order":
        return [-float(it.index) for it in items]
    return [None] * len(items)


def _transform(v: float | None, t: str) -> float | None:
    if v is None:
        return None
    if t == "log1p":
        return math.log1p(v) if v > -1 else None
    if t == "sqrt":
        return math.sqrt(v) if v >= 0 else None
    if t == "neg":
        return -v
    if t == "abs":
        return abs(v)
    return v


def _normalize(vals: list[float | None], how: str) -> list[float]:
    present = [(v, i) for i, v in enumerate(vals) if v is not None and math.isfinite(v)]
    out = [0.0] * len(vals)
    if not present:
        return out
    if how == "none":
        for v, i in present:
            out[i] = v
        return out
    if how == "minmax":
        lo = min(v for v, _ in present)
        hi = max(v for v, _ in present)
        for v, i in present:
            out[i] = 0.0 if hi == lo else (v - lo) / (hi - lo)
        return out
    # rank: average rank of equal values scaled to [0,1], 1 = largest
    srt = sorted(present)
    n = len(srt)
    j = 0
    while j < n:
        k = j
        while k + 1 < n and srt[k + 1][0] == srt[j][0]:
            k += 1
        avg = (j + k) / 2
        for m in range(j, k + 1):
            out[srt[m][1]] = 0.0 if n == 1 else avg / (n - 1)
        j = k + 1
    return out


def reference(prob: Problem) -> dict[str, PriorityInfo]:
    opts = prob.opts.get("priority", {})
    items = prob.items
    n = len(items)
    terms = opts.get("terms", []) or []
    scores = [0.0] * n
    term_vals = []
    for t in terms:
        if "attr" in t:
            raw = []
            for it in items:
                v = it.attrs.get(t["attr"])
                raw.append(float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None)
        elif "expr" in t:
            node = ex.parse(t["expr"])
            raw = []
            for it in items:
                v = ex.evaluate(node, ex.item_context(it.raw, it.index, it.ref))
                if isinstance(v, bool):
                    raw.append(1.0 if v else 0.0)
                elif isinstance(v, float):
                    raw.append(v)
                else:
                    raw.append(None)
        else:
            raw = _builtin_values(t["builtin"], prob, t)
        tr = t.get("transform", "none")
        vals = [_transform(v, tr) for v in raw]
        norm = _normalize(vals, t.get("normalize", "rank"))
        w = float(t.get("weight", 1.0))
        term_vals.append(norm)
        for i in range(n):
            scores[i] += w * norm[i]
    for i, it in enumerate(items):
        if it.priority is not None:
            scores[i] = float(it.priority)
    tiers = []
    rules = [(ex.parse(r["where"]), int(r["tier"])) for r in (opts.get("tiers", []) or [])]
    for it in items:
        if it.tier is not None:
            tiers.append(int(it.tier))
            continue
        tv = 0
        ctx = ex.item_context(it.raw, it.index, it.ref)
        for node, tier in rules:
            if ex.truthy(ex.evaluate(node, ctx)):
                tv = tier
                break
        tiers.append(tv)
    ties = opts.get("ties", "input_order")

    def tie_key(i):
        it = items[i]
        if ties == "id":
            return (it.id, i)
        if ties == "anchor_x":
            return (it.ref[0], i)
        return (i,)

    def order(reserved):
        return sorted(range(n), key=lambda i: (-int(items[i].required), -tiers[i], -int(reserved[i]), -scores[i],
                                               tie_key(i)))

    reserved = [False] * n
    cov = opts.get("coverage")
    if cov:
        node = ex.parse(cov["by"])
        m = int(cov.get("min_per_group", 1))
        groups: dict[str, int] = {}
        for i in order(reserved):
            it = items[i]
            g = ex.canonical(ex.evaluate(node, ex.item_context(it.raw, it.index, it.ref)))
            c = groups.get(g, 0)
            if c < m:
                reserved[i] = True
            groups[g] = c + 1
    out = {}
    for r, i in enumerate(order(reserved)):
        it = items[i]
        out[it.id] = PriorityInfo(r, tiers[i], scores[i], it.required, reserved[i])
    return out


def keys(infos: dict[str, PriorityInfo], band: float) -> dict[str, tuple]:
    """key(i) = (required, tier, reserved, band(score)) — larger is higher (spec §9.1)."""
    scores = sorted({v.score for v in infos.values()}, reverse=True)
    band_of: dict[float, int] = {}
    bid = 0
    start = None
    for s in scores:
        if start is None:
            start = s
        elif (band > 0 and s < start - band) or (band <= 0 and s != start):
            bid += 1
            start = s
        band_of[s] = bid
    return {k: (int(v.required), v.tier, int(v.reserved), -band_of[v.score]) for k, v in infos.items()}


def ndcg_at_k(placed_ranks: list[int], all_ranks: list[int]) -> float:
    k = len(placed_ranks)
    if k == 0:
        return 0.0
    pr = sorted(placed_ranks)
    ar = sorted(all_ranks)[:k]
    dcg = sum(gain(r) / math.log2(j + 2) for j, r in enumerate(pr))
    idcg = sum(gain(r) / math.log2(j + 2) for j, r in enumerate(ar))
    return dcg / idcg if idcg > 0 else 0.0


def coverage_groups(prob: Problem) -> tuple[dict[str, list[str]], int] | None:
    cov = prob.opts.get("priority", {}).get("coverage")
    if not cov:
        return None
    node = ex.parse(cov["by"])
    groups: dict[str, list[str]] = {}
    for it in prob.items:
        g = ex.canonical(ex.evaluate(node, ex.item_context(it.raw, it.index, it.ref)))
        groups.setdefault(g, []).append(it.id)
    return groups, int(cov.get("min_per_group", 1))
