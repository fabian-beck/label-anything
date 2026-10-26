"""Performance-target problems, report analyses (diff, parity, runtime plots), release gates and the runner."""
from __future__ import annotations

import copy
import json
import re
import sys
import xml.etree.ElementTree as ET

import pytest

from bench import gates, report, report_html, run
from bench.common import paths
from bench.common.jsonio import read_json, write_json
from bench.eval.tests.helpers import item, problem
from bench.perf import TARGETS, implementation
from bench.perf.generate import SplitMix64, problems, scatter_problem
from bench.perf.runner import metric_value


# ---------------------------------------------------------------------------
# perf
# ---------------------------------------------------------------------------
def test_splitmix64_reference_values():
    r = SplitMix64(0)
    # reference outputs of SplitMix64 seeded with 0 (Vigna's splitmix64.c)
    assert [r.next() for _ in range(3)] == [0xE220A8397B1DCDAF, 0x6E789E6AA1B965F4, 0x06C45D188009454F]
    u = SplitMix64(7).uniform()
    assert 0.0 <= u < 1.0


def test_perf_problems_are_deterministic_and_as_specified():
    p = scatter_problem(200, 10_000, 800, 600, seed=1)
    assert p == scatter_problem(200, 10_000, 800, 600, seed=1)
    assert p["solver"] == {"strategy": "greedy"} and p["preset"] == "scatter"
    assert len(p["items"]) == 200 and p["items"][7]["id"] == "i7" and p["items"][7]["label"]["text"] == "Label 7"
    (layer,) = p["obstacles"]["vector"]
    assert layer["class"] == "points" and layer["r"] == 1.5 and len(layer["points"]) == 10_000
    xs = [it["anchor"]["x"] for it in p["items"]] + [q[0] for q in layer["points"]]
    ys = [it["anchor"]["y"] for it in p["items"]] + [q[1] for q in layer["points"]]
    assert min(xs) >= 10 and max(xs) <= 790 and min(ys) >= 10 and max(ys) <= 590
    probs = problems()
    assert set(probs) == set(TARGETS)
    ras = probs["raster-2048"]["obstacles"]["raster"]
    assert ras["rgba"]["width"] == 2048 and ras["mode"] == "ink"
    assert probs["scatter-2000"]["canvas"] == {"width": 1920, "height": 1080}
    assert len(probs["scatter-2000"]["obstacles"]["vector"][0]["points"]) == 100_000


def test_perf_problems_validate_against_the_schema():
    import jsonschema

    from bench.common import spec

    v = jsonschema.Draft202012Validator(spec.schema("problem"))
    for name, p in problems().items():
        if name == "raster-2048":
            p = copy.deepcopy(p)
            p["obstacles"]["raster"]["rgba"]["data"] = "AAAA"   # keep the check fast
        assert not list(v.iter_errors(p)), name


def test_implementation_names_and_metric_paths():
    assert [implementation(n) for n in ("rust", "ts", "wasm", "rust-local", "la-ts", "TS_node")] == \
           ["rust", "ts", "wasm", "rust", "ts", "ts"]
    assert implementation("trust") is None and implementation("textalloc") is None
    res = {"stats": {"runtime_ms": 12.5, "phases_ms": {"prepare": 3.0}}}
    assert metric_value(res, "runtime_ms") == 12.5 and metric_value(res, "phases_ms.prepare") == 3.0
    assert metric_value(res, "phases_ms.verify") is None


def test_perf_solvers_run_single_threaded(monkeypatch):
    from bench.perf.runner import solver_env

    monkeypatch.setenv("RAYON_NUM_THREADS", "8")
    assert solver_env(1)["RAYON_NUM_THREADS"] == "1" and solver_env(3)["RAYON_NUM_THREADS"] == "3"
    assert "RAYON_NUM_THREADS" not in solver_env(0)


# ---------------------------------------------------------------------------
# report analyses
# ---------------------------------------------------------------------------
def entry(solver, config="c1", n=10, digest="d", runtime=5.0, **summary):
    s = {"placed": 9, "total": 10, "placed_rate": 0.9, "hard_violations": 0, "leader_crossings": 0,
         "ambiguity_rate": 0.1, "priority_inversions": 0, "ndcg_at_k": 0.95, "soft_coverage_mean": 0.01}
    s.update(summary)
    return {"solver": solver, "scenario": "01-x", "config": config, "n_items": n, "summary": s, "digest": digest,
            "runtime": {"median": runtime * 3, "p95": runtime * 3, "runs": [runtime * 3]},
            "runtime_reported": {"median": runtime, "p95": runtime}, "deterministic": True}


def rep(*results, solvers=None, **kw):
    r = {"generated_at": "now", "suite": "quick", "runs": 1,
         "solvers": solvers or sorted({e["solver"] for e in results}), "results": list(results), "sequences": []}
    r.update(kw)
    return r


def test_compare_flags_regressions_by_direction_and_threshold():
    prev = rep(entry("rust"), entry("rust", "c2"))
    cur = rep(entry("rust", placed_rate=0.873), entry("rust", "c2", placed_rate=0.89, hard_violations=1,
                                                      soft_coverage_mean=0.005))
    d = report.compare(prev, cur, 0.02)
    st = {(r["config"], r["metric"]): r["status"] for r in d["rows"]}
    assert st[("c1", "placed_rate")] == "regression"          # -3 %
    assert st[("c2", "placed_rate")] == "changed"             # -1.1 %: below the threshold
    assert st[("c2", "hard_violations")] == "regression"      # from 0: always beyond the threshold
    assert st[("c2", "soft_coverage_mean")] == "improvement"  # lower is better
    assert d["regressions"] == 2 and d["improvements"] == 1
    assert report.compare(prev, prev)["rows"] == []
    # results.json keeps 6 decimals: a value read back must equal the unrounded one it was written from
    stored = rep(entry("rust", soft_coverage_mean=0.01027, ambiguity_rate=0.0))
    live = rep(entry("rust", soft_coverage_mean=0.0102700013, ambiguity_rate=4e-10))
    assert report.compare(stored, live)["rows"] == []


def test_parity_deltas_between_rust_and_ts():
    cur = rep(entry("rust"), entry("ts", ndcg_at_k=0.96, digest="other"), entry("greedy"),
              solvers=["rust", "ts", "greedy"])
    par = report.parity(cur)
    (pair,) = par["pairs"]
    assert par["reference"] == "rust" and pair["solver"] == "ts" and pair["compared"] == 1
    row = pair["rows"][0]
    assert row["identical"] is False and row["deltas"]["ndcg_at_k"] == pytest.approx(0.01)
    assert row["deltas"]["placed_rate"] == 0.0
    assert report.parity(rep(entry("rust")))["pairs"] == []


def test_sequence_table_notes_a_planned_baseline():
    metrics = {"frames": 3, "displacement_mean_px": 1.0, "displacement_median_px": 1.0, "flip_rate": 0.0,
               "nesting_rate": None, "nesting_fraction_mean": None, "added_total": 0, "removed_total": 0}
    seqs = [{"solver": "adjusttext", "scenario": "11-x", "sequence": "s", "metrics": metrics, "frames": [],
             "options": {"step": 32.0, "iter_lim": 18}},
            {"solver": "textalloc", "scenario": "11-x", "sequence": "s", "metrics": metrics, "frames": []},
            {"solver": "ggrepel", "scenario": "11-x", "sequence": "s", "skipped": "frame 0: too large"}]
    cur = rep(sequences=seqs, solvers=["adjusttext", "textalloc", "ggrepel"])
    html = report_html.sequence_table(cur, report_html.Pick(cur["solvers"]))
    assert html.count("class='em'") == 1
    assert "18 iterations per frame (comparison budget of this sequence); lines sampled every 32 px" in html
    assert "n/a: frame 0: too large" in html


def test_heat_colours_each_value_against_the_column_median():
    # higher is better: each side of the median (80 %) scaled to its farthest value
    hs, mid = report.heat([0.80, 0.90, 0.68, 0.40, 0.81, None], "{:.1%}", +1)
    assert mid == pytest.approx(0.80) and hs[5] is None
    assert hs[:5] == [(0, False), (2, True), (-1, False), (-2, False), (0, False)]
    # differences below the floor (5 percentage points) stay near the median
    assert report.heat([0.800, 0.805, 0.810], "{:.1%}", +1)[0] == [(0, False)] * 3
    # counts compare by ratio, lower is better: the zeros are the best, 3 is the median
    hs, mid = report.heat([0, 0, 3, 40, 1000], "{:d}", -1, log=True)
    assert mid == 3 and hs == [(2, True), (2, True), (0, False), (-1, False), (-2, False)]
    # values compare as shown: 99.96 % and 100 % are both the best
    assert report.heat([0.9996, 1.0, 0.5, 0.6, 0.7], "{:.1%}", +1)[0] == [
        (2, True), (2, True), (-2, False), (-1, False), (0, False)]
    # nothing to compare: no direction, or fewer than two values
    assert report.heat([1, 2, 3], "{:d}", 0) == ([None] * 3, None)
    assert report.heat([0.5, None], "{:.1%}", +1) == ([None, None], None)


def test_tables_are_coloured_per_column_with_tooltips(tmp_path):
    (a, b, c) = report.heat_attrs([{"x": 0.9}, {"x": 0.5}, {"x": None}], [("x", "{:.1%}", +1, False)])
    assert a["x"] == " class='hb2 best' title='much better than the median (70.0%); best value'"
    assert b["x"] == " class='hw2' title='much worse than the median (70.0%)'" and c["x"] == ""
    cur = rep(entry("rust", placed_rate=0.95), entry("greedy", placed_rate=0.6), solvers=["rust", "greedy"])
    pick = report_html.Pick(cur["solvers"])
    stats = {s: report_html.aggregates(cur, s) for s in cur["solvers"]}
    html = report_html.summary_table(cur, stats, pick)
    assert "<td class='hb2 best' title='much better than the median (77.5%); best value'>95.0%</td>" in html
    assert "<td class='h0' title='near the median (0)'>0</td>" in html          # equal hard violations
    # the problem tables compare the solvers on each problem (config) on its own
    cur = rep(entry("rust", placed_rate=0.9), entry("greedy", placed_rate=0.5),
              entry("rust", "c2", placed_rate=0.2, hard_violations=2), entry("greedy", "c2", placed_rate=0.6),
              solvers=["rust", "greedy"])
    pick = report_html.Pick(cur["solvers"])
    block = report_html.scenario_html(cur, "01-x", cur["results"], {}, tmp_path, pick)
    rows = block.split("<table class='metrics'>")[1].split("<tr")[2:]
    assert [r.count("class='hb2 best' title='much better than the median (70.0%); best value'>90.0%") for r in
            rows] == [1, 0, 0, 0]
    assert "class='hb2 best' title='much better than the median (40.0%); best value'>60.0%" in rows[3]
    assert "<td class='bad'>2</td>" in rows[2]                    # a hard violation by Label Anything
    # one config at a time: a tab per config
    assert block.count("class='tab'") == 2 and "aria-controls='cfg-01-x-c2'" in block


def test_report_page_shows_three_labelers_by_default_and_folds_the_details(tmp_path):
    tools = ["ggrepel", "adjusttext", "textalloc"]
    cur = rep(*(entry(s, usable_rate=0.8) for s in ["rust", "naive", "greedy"] + tools),
              solvers=["rust", "naive", "greedy"] + tools,
              problems=[{"scenario": "01-x", "config": "c1", "title": "Tiny scatter", "description": "Ten points.",
                         "n_items": 10}])
    html = report_html.page(tmp_path, cur, {})
    # the bar: the three tools by default, naive and greedy on demand; Label Anything always
    on = re.findall(r"data-solver='([^']+)' data-default='1' aria-pressed='true'", html)
    assert on == tools and html.count("data-default='0' aria-pressed='false'") == 2
    assert ' data-solver="naive" hidden' in html and ' data-solver="greedy" hidden' in html
    assert ' data-solver="ggrepel" hidden' not in html and ' data-solver="rust" hidden' not in html
    # Label Anything's numbers next to the range of the others; where each labeler stands
    assert "class='kpis'" in html and "baselines 80.0%" in html and "<table class='stand'>" in html
    # a scenario no chapter names comes under "Other problems", with its title and description
    for anchor in ("id='summary'", "id='more'", "id='sc-01-x'", "id='weak'", "id='details'", "id='perf'",
                   "id='gates'", "id='runtime'", "id='parity'", "id='diff'"):
        assert anchor in html
    assert "Tiny scatter" in html and "Ten points. · 10 items" in html
    # concise wording, singular where it is one
    assert "Label Anything and 5 baseline methods are evaluated on 1 problem built from open data" in html
    assert all(f">{t}</a>" in html for t in ("Summary", "Other problems", "Limitations", "Technical details"))
    # self-contained: styles and script inline, fonts next to the page
    assert "<script src" not in html and "<link rel=" not in html and "fonts/NotoSans-Bold.ttf" in html
    # without the tools, the first three others are shown
    assert report_html.Pick(["rust", "naive", "greedy", "rust-ts"]).on == {"naive", "greedy"}
    assert report_html.Pick(["ts", "ggrepel"]).ref == "ts"


def test_others_better_needs_as_many_usable_labels_and_no_more_violations():
    cur = rep(entry("rust", usable_rate=0.80, clarity_unclear_rate=0.20),
              entry("greedy", usable_rate=0.85, clarity_unclear_rate=0.10),               # better on both
              entry("ggrepel", usable_rate=0.95, clarity_unclear_rate=0.05, hard_violations=3),  # violates
              entry("d3fc", usable_rate=0.50, clarity_unclear_rate=0.01),                 # fewer usable labels
              entry("ts", usable_rate=0.99, clarity_unclear_rate=0.0),                    # Label Anything too
              solvers=["rust", "greedy", "ggrepel", "d3fc", "ts"])
    rows = report.others_better(cur, "rust")
    assert [(r["metric"], r["solver"], r["value"]) for r in rows] == [("usable_rate", "greedy", 0.85),
                                                                       ("clarity_unclear_rate", "greedy", 0.10)]
    html = report_html.better_table(cur, report_html.Pick(cur["solvers"]))
    assert "<td>20.0%</td><td class='l'>greedy: 10.0%</td>" in html


def test_crop_window_shows_the_densest_part_of_a_large_canvas():
    dense = [item(f"a{k}", 1500 + k % 5 * 10, 600 + k // 5 * 10) for k in range(25)]
    x, y, w, h = report_html.crop_window(problem(dense + [item("b", 100, 100)], width=1800, height=800))
    assert (w, h) == (600, 400) and x <= 1500 and x + w >= 1540 and y <= 600 and y + h >= 640
    assert report_html.crop_window(problem(dense, width=1000, height=700)) is None    # legible as a whole
    html = report_html.shot({"img": "a.png", "size": [1800, 800]}, "alt", "cap", crop=[1200, 400, 600, 400],
                            canvas=[1800, 800])
    assert 'class="shot crop"' in html and 'data-crop="0.6667,0.5000,0.3333,0.5000"' in html
    assert 'style="width:300.00%;left:-200.00%;top:-100.00%"' in html


def test_runtime_svg_small_multiples():
    cur = rep(entry("rust", n=10), entry("rust", "c2", n=1000, runtime=50.0), entry("textalloc", n=10, runtime=80.0),
              solvers=["rust", "textalloc"])
    svg = report.runtime_svg(cur, "engine")
    root = ET.fromstring(svg)
    ns = "{http://www.w3.org/2000/svg}"
    dots = [c for c in root.iter(f"{ns}circle") if "dot" in (c.get("class") or "")]
    # legend (2) + LA panel (2 rust dots) + textalloc panel (2 rust + 1 textalloc)
    assert len(dots) == 2 + 2 + 3
    titles = [t.text for t in root.iter(f"{ns}title")]
    assert any("textalloc · 01-x/c1 · 10 items · 80.0 ms" in t for t in titles)
    assert "var(" not in svg                                  # standalone viewers need literal colours
    assert report.runtime_svg(rep(), "engine") is None


# ---------------------------------------------------------------------------
# gates
# ---------------------------------------------------------------------------
def perf_rows(passed=True):
    return {"rows": [{"solver": "rust", "implementation": "rust", "problem": p, "metric": t["metric"],
                      "median": 1.0 if passed else 1e9, "target": t["targets"]["rust"], "passed": passed}
                     for p, t in TARGETS.items()]}


def test_gates_pass_fail_and_allow_list(tmp_path):
    prev = rep(entry("rust"))
    ok = rep(entry("rust"), perf=perf_rows())
    g = gates.check(ok, prev)
    assert g["passed"] and [c["passed"] for c in g["checks"]] == [True, True, True]
    assert not gates.check(rep(entry("rust", hard_violations=2), perf=perf_rows()), prev)["passed"]
    assert not gates.check(rep(entry("rust"), perf=perf_rows(False)), prev)["passed"]
    g = gates.check(rep(entry("rust")), prev)                 # perf not measured
    assert not g["passed"] and "not measured" in " ".join(g["checks"][2]["details"])
    g = gates.check(ok, None)                                 # no previous: skipped, not failed
    assert g["passed"] and g["checks"][1]["skipped"]
    assert not gates.check(rep(entry("greedy"), perf=perf_rows()), None)["passed"]   # no LA solver at all
    regressed = rep(entry("rust", placed_rate=0.5), perf=perf_rows())
    assert not gates.check(regressed, prev)["passed"]
    allow_file = tmp_path / "allow.json"
    write_json(allow_file, {"allow": [{"metric": "placed_rate", "scenario": "01-*", "adr": "solver/search", "reason": "x"},
                                      {"metric": "ndcg_at_k", "scenario": "*", "adr": "solver/nothing"}]})
    allow, problems_ = gates.load_allow(allow_file)
    assert [a["adr"] for a in allow] == ["solver/search"] and len(problems_) == 1   # no such record
    g = gates.check(regressed, prev, allow, problems_)
    assert g["passed"] and any("allowed by ADR solver/search" in d for d in g["checks"][1]["details"])
    lines = gates.summary_lines(g)
    assert lines[0] == "release gates: PASS" and any("[pass]" in ln for ln in lines)


def test_gates_cli(tmp_path):
    cur = tmp_path / "cur.json"
    write_json(cur, rep(entry("rust"), perf=perf_rows()))
    assert gates.main([str(cur), "--allow", str(tmp_path / "missing.json")]) == 0
    write_json(cur, rep(entry("rust", hard_violations=1), perf=perf_rows()))
    assert gates.main([str(cur), "-o", str(tmp_path / "gate.json")]) == 1
    assert read_json(tmp_path / "gate.json")["passed"] is False


# ---------------------------------------------------------------------------
# runner end to end (tiny scenario, an external "rust" solver, previous diff, gates)
# ---------------------------------------------------------------------------
def test_runner_end_to_end(tmp_path, monkeypatch):
    monkeypatch.chdir(paths.REPO)
    root = tmp_path / "problems" / "99-tiny"
    write_json(root / "tiny.json", problem([item("A", 50, 50), item("B", 120, 50), item("C", 160, 70)]))
    write_json(root / "scenario.json", {"scenario": "99-tiny", "title": "tiny",
                                        "configs": [{"name": "tiny", "quick": True, "n_items": 3,
                                                     "files": {"problem": "tiny.json"}}]})
    out = tmp_path / "rep"
    ext = f"rust={sys.executable} -m bench.solvers.greedy {{problem}} -o {{result}}"
    args = ["--problems", str(tmp_path / "problems"), "--out", str(out), "--solver", ext, "--solver", "naive",
            "--runs", "2", "--no-render"]
    assert run.main(args) == 0
    res = read_json(out / "results.json")
    assert res["solvers"] == ["rust", "naive"] and res["baseline_runs"] == 1
    by = {r["solver"]: r for r in res["results"]}
    assert by["rust"]["kind"] == "label-anything" and by["naive"]["kind"] == "baseline"
    assert by["rust"]["deterministic"] and len(by["rust"]["runtime"]["runs"]) == 2
    assert (out / "index.html").exists() and (out / "plots" / "runtime-engine.svg").exists()
    html = (out / "index.html").read_text(encoding="utf-8")
    for anchor in ("id='summary'", "id='perf'", "id='gates'", "id='runtime'", "id='parity'", "id='diff'",
                   "id='sc-99-tiny'"):
        assert anchor in html
    # second run: previous diff + gates (perf not measured -> the gate fails, exit 1)
    prev = out / "results.json"
    keep = tmp_path / "prev.json"
    keep.write_text(prev.read_text(encoding="utf-8"), encoding="utf-8")
    monkeypatch.setattr("bench.perf.runner.run_perf", lambda *a, **k: {"runs": 1, "rows": [], "machine": {}})
    code = run.main(args + ["--previous", str(keep), "--gate"])
    res = read_json(out / "results.json")
    assert code == 1 and res["diff"]["rows"] == [] and res["gate"]["passed"] is False
    assert json.dumps(res["gate"]).count("not measured") == 1
    # rebuild the report from the stored results (no solver runs)
    (out / "index.html").unlink()
    assert report.main([str(out / "results.json"), "--previous", str(keep)]) == 0
    assert (out / "index.html").exists() and read_json(out / "results.json")["diff"]["rows"] == []
    assert report.main([str(out / "results.json"), "--gate"]) == 1


# ---------------------------------------------------------------------------
# milestone acceptance (M3, M4)
# ---------------------------------------------------------------------------
def _row(solver, config, **summary):
    return {"solver": solver, "scenario": "02-volcano", "config": config, "summary": summary}


def test_milestones_m3_and_m4():
    from bench import milestones

    dense = dict(placed_rate=0.6, placed=60, placed_weighted=0.70, priority_inversions=0, leader_crossings=0)
    full = dict(dense, placed=66, placed_weighted=0.77)
    easy = dict(placed_rate=1.0, placed=10, placed_weighted=1.0, priority_inversions=0, leader_crossings=0)
    rep = {"results": [_row("rust-greedy", "a", **dense), _row("rust", "a", **full),
                       _row("rust-greedy", "b", **easy), _row("rust", "b", **easy),
                       _row("greedy", "a", **dict(dense, leader_crossings=3))]}
    assert milestones.m3(rep)[0]  # baselines do not count
    ok, lines = milestones.m4(rep)
    assert ok and "+10.0%" in lines[0] and "1 dense problems" in lines[0]
    # less than 5 % on average, or a new priority inversion, fails M4
    assert not milestones.m4(rep, min_gain=0.2)[0]
    rep["results"][1]["summary"] = dict(full, priority_inversions=1)
    assert not milestones.m4(rep)[0]
    rep["results"][1]["summary"] = dict(full, leader_crossings=2)
    ok, lines = milestones.m3(rep)
    assert not ok and "2 crossings" in lines[1]
    # M4 needs a -greedy twin (or the twin of --baseline)
    assert not milestones.m4({"results": [_row("rust", "a", **full)]})[0]
    assert "*-ladder" in milestones.m4(rep, baseline="ladder")[1][0]
    # prefix mode: the inversions are the placed items after the first omitted one
    assert milestones.inversions({"placed": 10, "total": 100, "prefix_rate": 0.08}, "prefix") == 2
    assert milestones.inversions({"placed": 10, "priority_inversions": 3}, "strict") == 3


def test_scaling_exponent_is_the_log_log_slope():
    from bench.report import scaling_exponent

    rows = [{"solver": "rust", "scenario": "10-stress", "n_items": n, "summary": {},
             "runtime_reported": {"median": 0.5 * n ** 1.5}} for n in (200, 2000, 20000)]
    assert abs(scaling_exponent(rows, "rust") - 1.5) < 1e-9
    assert scaling_exponent(rows[:2], "rust") is None
    # without an engine-reported runtime, the wall time
    walls = [{"solver": "b", "scenario": "10-stress", "n_items": n, "summary": {}, "runtime": {"median": float(n)}}
             for n in (100, 1000, 10000)]
    assert abs(scaling_exponent(walls, "b") - 1.0) < 1e-9


class _Stub:
    """A baseline that places A and B where soft classes are left out, only A where they are avoided."""

    name = "stub"

    def __init__(self):
        self.modes = []

    def solve(self, problem, path, result_path, timeout, options=None):
        mode = (options or {})["soft"]
        self.modes.append(mode)
        ids = ["A", "B"] if mode == "ignore" else ["A"]
        res = {"version": "1", "stats": {"placed": len(ids), "total": 2, "hard_violations": 0,
                                         "leader_crossings": 0, "runtime_ms": 1.0, "seed": 0},
               "placements": [{"id": i, "placed": i in ids, "anchor_side": "top-right", "model": "adjacent",
                               "box": {"x": x + 4, "y": 30, "w": 30, "h": 10}} if i in ids else
                              {"id": i, "placed": False, "reason": "no_feasible_candidate"}
                              for i, x in (("A", 50), ("B", 120))]}
        return res, 1.0


def test_choose_soft_keeps_the_emulation_with_more_usable_labels(tmp_path):
    prob = problem([item("A", 50, 45), item("B", 120, 45)],
                   obstacles={"vector": [{"class": "grid", "polylines": [[[0, 35], [200, 35]]], "width": 1}]},
                   avoid={"label": {"grid": 0.2}})
    path = tmp_path / "p.json"
    write_json(path, prob)
    assert run.has_soft_classes(prob, path)
    stub = _Stub()
    mode, res, _wall, choice = run.choose_soft(stub, prob, path, tmp_path / "r.json", 10.0, None)
    assert stub.modes == ["hard", "ignore"]
    assert mode == "ignore" and res["stats"]["placed"] == 2
    assert choice["tried"]["hard"]["usable"] == 1 and choice["tried"]["ignore"]["usable"] == 2
    assert read_json(tmp_path / "r.json")["stats"]["placed"] == 2
    # without soft classes there is nothing to choose
    plain = problem([item("A", 50, 45)])
    assert not run.has_soft_classes(plain, path)


def test_engine_wall_time_comes_from_a_cold_single_solve():
    s = run.Solver("rust=/bin/la place {problem} -o {result} --warmup 3")
    assert s.cold_cmd == "/bin/la place {problem} -o {result} --warmup 0"
    assert run.Solver("rust=/bin/la place {problem} -o {result}").cold_cmd is None
    assert run.Solver("rust=/bin/la place {problem} -o {result} --warmup 0").cold_cmd is None
    assert run.Solver("other=/bin/x {problem} {result} --warmup 3").cold_cmd is None  # not an engine
