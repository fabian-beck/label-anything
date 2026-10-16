"""More hand-computed cases: own-mark policies, leaders, areas, canvas options, CLI, baselines."""
from __future__ import annotations

import json
import math
import subprocess
import sys

import jsonschema
import pytest

from bench.common import paths, spec
from bench.eval import evaluate
from bench.eval.tests.helpers import item, omitted, placed, problem, result
from bench.solvers import greedy, naive


def test_own_mark_partial_policy():
    # circle r=10 at (50,50); a 30x10 label covering the circle's right half-strip
    prob = problem([item("A", 50, 50, r=10)], avoid={"label": {"own_mark": "partial:0.5"}})
    m = evaluate(prob, result([placed("A", 50, 45, side="right")]))     # covers x in [50,60], |y-50|<=5
    covered = (5 * math.sqrt(100 - 25) + 100 * math.asin(0.5)) / (math.pi * 100)  # area fraction of strip
    assert covered < 0.5
    assert m["hard"]["own_mark"] == 0
    m = evaluate(prob, result([placed("A", 35, 38, w=30, h=24, side="right")]))  # most of the disc
    assert m["hard"]["own_mark"] == 1
    prob["avoid"]["label"]["own_mark"] = "ignore"
    assert evaluate(prob, result([placed("A", 35, 38, w=30, h=24)]))["hard"]["own_mark"] == 0


def test_leader_entering_its_own_label():
    prob = problem([item("A", 20, 50)])
    ok = {"points": [[22, 50], [60, 50]], "style": "straight", "port": [60, 50]}
    bad = {"points": [[22, 50], [80, 50]], "style": "straight", "port": [80, 50]}   # crosses into the box
    m = evaluate(prob, result([placed("A", 60, 45, side="distant", model="distant", leader=ok)]))
    assert m["hard"]["leader_own_label"] == 0
    m = evaluate(prob, result([placed("A", 60, 45, side="distant", model="distant", leader=bad)]))
    assert m["hard"]["leader_own_label"] == 1
    # the ambiguity of leadered labels is measured from the leader's first point
    assert m["ambiguity"]["rate"] == 0.0


def test_leader_through_other_item_when_hard():
    prob = problem([item("A", 20, 50), item("B", 50, 50, r=4)], avoid={"leader": {"items": "hard"}})
    L = {"points": [[22, 50], [90, 50]], "style": "straight", "port": [90, 50]}
    m = evaluate(prob, result([placed("A", 90, 45, side="distant", model="distant", leader=L), omitted("B")]))
    assert m["hard"]["leader_item"] == 1
    prob["avoid"] = {}
    m = evaluate(prob, result([placed("A", 90, 45, side="distant", model="distant", leader=L), omitted("B")]))
    assert m["hard"]["leader_item"] == 0          # items are soft (2.0) for leaders by default


def test_area_anchor_internal_label():
    sq = [[20, 20], [120, 20], [120, 80], [20, 80]]
    it = {"id": "R", "anchor": {"type": "area", "polygon": sq},
          "label": {"type": "text", "text": "R", "width": 30, "height": 10, "padding": 0}}
    prob = problem([it], width=200, height=100)
    m = evaluate(prob, result([placed("R", 55, 45, side="internal", model="internal")]))
    assert m["hard"]["total"] == 0
    assert m["shape"]["internal_eligible"] == 1 and m["shape"]["internal_rate"] == 1.0
    m = evaluate(prob, result([placed("R", 110, 45, side="internal", model="internal")]))
    assert m["hard"]["internal_outside"] == 1
    # omitted area item with room inside: the removal test finds the pole position
    m = evaluate(prob, result([omitted("R")]))
    assert m["priority"]["inversions"] == 1


def test_allow_outside_and_padding():
    prob = problem([item("A", 190, 50)])
    res = result([placed("A", 192, 40)])
    assert evaluate(prob, res)["hard"]["canvas_edge"] == 1
    prob["canvas"]["allow_outside"] = True
    assert evaluate(prob, res)["hard"]["canvas_edge"] == 0


def test_generated_truth_is_equivalent_to_the_problem_layers():
    from bench.common.truth import complete_truth

    prob = problem([item("A", 5, 5), item("B", 15, 5)], width=300, height=200,
                   transform=[10, 0, 0, 10, 0, 0], y_axis="up",
                   obstacles={"vector": [
                       {"class": "pts", "points": [[6, 4], [14, 6]], "r": 3},
                       {"class": "walls", "polylines": [[[0, 9], [20, 9]]], "width": 2},
                       {"class": "blocks", "shapes": [{"shape": "rect", "w": 20, "h": 10, "x": 10, "y": 15}]}]},
                   avoid={"label": {"walls": "hard", "pts": 0.5, "blocks": "hard"}})
    res = naive.solve(prob)
    truth = complete_truth(prob)
    assert truth["includes_problem_vectors"] and set(truth["classes"]) == {"pts", "walls", "blocks"}
    assert truth["classes"]["pts"]["circles"][0] == [60.0, 160.0, 3.0]          # transformed + y flipped
    a, b = evaluate(prob, res), evaluate(prob, res, truth)
    assert a["hard"] == b["hard"] and a["coverage"] == b["coverage"]


def test_cli_roundtrip(tmp_path):
    prob = problem([item("A", 50, 50)])
    res = naive.solve(prob)
    pp, rp = tmp_path / "p.json", tmp_path / "r.json"
    pp.write_text(json.dumps(prob))
    rp.write_text(json.dumps(res))
    out = subprocess.run([sys.executable, "-m", "bench.eval", str(pp), str(rp), "--summary"],
                         capture_output=True, text=True, cwd=str(paths.REPO), check=True)
    s = json.loads(out.stdout)
    assert s["placed"] == 1 and s["hard_violations"] == 0


@pytest.mark.parametrize("solver", [naive.solve, greedy.solve])
def test_baseline_results_validate_against_the_schema(solver):
    prob = problem([
        item("A", 50, 50),
        {"id": "T", "anchor": {"type": "point", "x": 120, "y": 50},
         "label": {"type": "text", "text": "com.example.LongName", "wrap": {"max_width": "6em", "max_lines": 3}}},
        {"id": "C", "anchor": {"type": "point", "x": 160, "y": 70, "mark": {"shape": "rect", "w": 10, "h": 6}},
         "label": {"type": "composite", "gap": 2, "padding": 1,
                   "parts": [{"type": "icon", "width": 8, "height": 8, "padding": 0},
                             {"type": "text", "text": "Café", "padding": 0}]}},
        {"id": "Z", "anchor": {"type": "area", "polygon": [[10, 10], [60, 10], [60, 40], [10, 40]]},
         "label": {"type": "text", "text": "Zone"}},
    ], height=120)
    res = solver(prob)
    v = jsonschema.Draft202012Validator(spec.schema("result"))
    assert not list(v.iter_errors(res))
    m = evaluate(prob, res)
    assert m["result_check"]["schema_errors"] == []
    t = next(p for p in res["placements"] if p["id"] == "T")
    if t["placed"]:
        assert len(t["text"]["lines"]) >= 2          # wrapped at the package dots
