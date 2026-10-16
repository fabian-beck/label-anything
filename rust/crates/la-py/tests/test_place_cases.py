"""The ``conformance/place`` cases through the Python binding (a port of the Rust runner
``rust/crates/label-anything/tests/conformance.rs``, with the same independent re-checks:
label overlaps, leader crossings, canvas bounds)."""

from __future__ import annotations

import math
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from conftest import CONFORMANCE, load_json

import label_anything as la

CASES = sorted((CONFORMANCE / "place").glob("*.json"))

#: spec/defaults.md: placement.offset and defaults.mark
DEFAULT_OFFSET = 2.0
DEFAULT_MARK = {"shape": "circle", "r": 2.0}

Seg = Tuple[Tuple[float, float], Tuple[float, float]]


def px(v: Any, em: float) -> float:
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    for unit, mul in (("px", 1.0), ("pt", 4.0 / 3.0), ("em", em)):
        if s.endswith(unit):
            return float(s[: -len(unit)]) * mul
    return float(s)


def segments(p: Dict[str, Any]) -> List[Seg]:
    out: List[Seg] = []
    leaders = ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders", []))
    for ld in leaders:
        pts = [(float(q[0]), float(q[1])) for q in ld["points"]]
        out.extend(zip(pts, pts[1:]))
    return out


def crosses(a: Tuple[float, float], b: Tuple[float, float], c: Tuple[float, float], d: Tuple[float, float]) -> bool:
    def o(p: Tuple[float, float], q: Tuple[float, float], r: Tuple[float, float]) -> float:
        return (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])

    d1, d2, d3, d4 = o(c, d, a), o(c, d, b), o(a, b, c), o(a, b, d)
    e = 1e-9
    return ((d1 > e and d2 < -e) or (d1 < -e and d2 > e)) and ((d3 > e and d4 < -e) or (d3 < -e and d4 > e))


def check(problem: Dict[str, Any], exp: Dict[str, Any]) -> List[str]:
    f: List[str] = []
    res = la.place_problem(problem)
    st = res.stats
    raw = res.raw["placements"]
    by_id = {p["id"]: p for p in raw}
    placed = [p for p in raw if p.get("placed")]
    for key in ("hard_violations", "leader_crossings", "priority_inversions", "placed"):
        if key in exp and st[key] != exp[key]:
            f.append(f"{key}: expected {exp[key]}, got {st[key]}")
    if "placed_min" in exp and len(placed) < exp["placed_min"]:
        f.append(f"placed_min: {len(placed)} < {exp['placed_min']}")
    if "placed_max" in exp and len(placed) > exp["placed_max"]:
        f.append(f"placed_max: {len(placed)} > {exp['placed_max']}")
    for key, want in (("placed_ids", True), ("unplaced_ids", False)):
        for i in exp.get(key, []):
            if i not in by_id:
                f.append(f"{key}: no placement for {i}")
            elif bool(by_id[i].get("placed")) != want:
                f.append(f"{key}: {i} has placed = {not want}")
    for key, field in (("reasons", "reason"), ("anchor_side", "anchor_side"), ("model", "model")):
        for i, want in exp.get(key, {}).items():
            got = by_id.get(i, {}).get(field)
            if got != want:
                f.append(f"{key}.{i}: expected {want}, got {got}")
    if "omission_order" in exp and st["omission_order"] != exp["omission_order"]:
        f.append(f"omission_order: expected {exp['omission_order']}, got {st['omission_order']}")
    for i, want in exp.get("has_leader", {}).items():
        got = bool(segments(by_id[i])) if i in by_id else False
        if got != want:
            f.append(f"has_leader.{i}: expected {want}, got {got}")
    for i, want in exp.get("text_lines", {}).items():
        got = by_id.get(i, {}).get("text", {}).get("lines")
        if got != want:
            f.append(f"text_lines.{i}: expected {want}, got {got}")
    for i, want in exp.get("box", {}).items():
        tol = want.get("tol", 0.01)
        got = by_id.get(i, {}).get("box") or {}
        for k in "xywh":
            if not abs(got.get(k, math.nan) - want[k]) <= tol:
                f.append(f"box.{i}.{k}: expected {want[k]} ± {tol}, got {got.get(k)}")
    # independent re-check: no two placed labels overlap (labels hard, the default)
    boxes = [(p["id"], la.BBox(**p["box"])) for p in placed if p.get("box")]
    if problem.get("avoid", {}).get("label", {}).get("labels", "hard") == "hard":
        for k, (ia, a) in enumerate(boxes):
            for ib, b in boxes[k + 1 :]:
                if a.intersects(b, 1e-6):
                    f.append(f"labels {ia} and {ib} overlap")
    # independent re-check: no two leaders cross (crossings hard, the default)
    if problem.get("avoid", {}).get("leader", {}).get("leaders", "hard") == "hard":
        segs = [(p["id"], segments(p)) for p in placed]
        for k, (ia, sa) in enumerate(segs):
            for ib, sb in segs[k + 1 :]:
                if any(crosses(a, b, c, d) for a, b in sa for c, d in sb):
                    f.append(f"leaders of {ia} and {ib} cross")
    em = float(problem.get("defaults", {}).get("font", {}).get("size", 12.0))
    if exp.get("inside_canvas") and "canvas" in problem:
        c = problem["canvas"]
        pad = px(c.get("padding", 0.0), em)
        for i, b in boxes:
            if b.x < pad - 1e-6 or b.y < pad - 1e-6 or b.x1 > c["width"] - pad + 1e-6 or b.y1 > c["height"] - pad + 1e-6:
                f.append(f"inside_canvas: {i} at {b}")
    if exp.get("prefix"):
        ranked = sorted(
            (p["priority"]["rank"], bool(p.get("placed")))
            for p in raw
            if p.get("reason") not in ("grouped", "keep_with") and p.get("priority")
        )
        cut = next((k for k, (_, ok) in enumerate(ranked) if not ok), None)
        if cut is not None and any(ok for _, ok in ranked[cut:]):
            f.append("prefix: a placed item follows an omitted one in priority order")
    if "touch_gap_max" in exp:
        gap_max = exp["touch_gap_max"]
        offset = px(problem.get("placement", {}).get("offset", DEFAULT_OFFSET), em)
        for it in problem["items"]:
            p = by_id.get(it.get("id", ""))
            if not p or p.get("model") != "adjacent" or not p.get("box"):
                continue
            mark = it["anchor"].get("mark") or problem.get("defaults", {}).get("mark") or DEFAULT_MARK
            if mark.get("shape") != "circle":
                continue
            b = la.BBox(**p["box"])
            ax, ay = it["anchor"]["x"], it["anchor"]["y"]
            dx = max(b.x - ax, ax - b.x1, 0.0)
            dy = max(b.y - ay, ay - b.y1, 0.0)
            d = math.hypot(dx, dy) - float(mark.get("r", 0.0)) - offset
            if d > gap_max + 1e-9 or d < -1e-6:
                f.append(f"touch_gap_max: {it['id']} gap {d}")
    if exp.get("deterministic") and la.place_problem(problem).raw["placements"] != raw:
        f.append("deterministic: two runs differ")
    return f


def test_cases_present() -> None:
    assert len(CASES) >= 20, f"place cases not found under {CONFORMANCE}"


@pytest.mark.parametrize("path", CASES, ids=lambda p: p.stem)
def test_place_case(path: Path) -> None:
    case = load_json(path)
    assert case["kind"] == "place"
    problem: Optional[Dict[str, Any]] = case.get("problem")
    if problem is None:
        problem = load_json(path.parent / case["problem_file"])
    failures = check(problem, case["expect"])
    assert not failures, "; ".join(failures)
