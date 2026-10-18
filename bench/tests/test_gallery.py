"""The gallery page (bench/gallery.py): figures solved and rendered, a run's comparisons and frames."""
from __future__ import annotations

import sys
import xml.etree.ElementTree as ET
from pathlib import Path

from PIL import Image

from bench import gallery, run
from bench.common import paths
from bench.common.jsonio import read_json, write_json
from bench.eval.tests.helpers import item, problem
from bench.solvers import greedy

SECTIONS = (
    gallery.Section("tests", "Test figures", "two of them", "A lede with <code>markup</code>.", (
        gallery.Fig("03-gapminder/y2005-vector", "Bubbles & labels: {placed} of {total}",
                    "Captions are HTML; {leaders} leaders.", wide=True),
        gallery.Fig("03-gapminder/not-built", "Never shown", "This problem was not built."),
    )),
    gallery.Section("weak", "Where it falls short", "", "", (
        gallery.Fig("03-gapminder/y2005-vector", "Again, as a limit", "{omitted} omitted.", limit=True),
    )),
)


def _problems(root: Path) -> Path:
    sc = root / "03-gapminder"
    write_json(sc / "y2005-vector.json", problem([item("A", 50, 50), item("B", 120, 50), item("C", 160, 70)]))
    write_json(sc / "scenario.json", {"scenario": "03-gapminder", "title": "tiny",
                                      "configs": [{"name": "y2005-vector", "quick": True, "n_items": 3,
                                                   "files": {"problem": "y2005-vector.json"}}]})
    return root


def _solve(problem_path: Path, result_path: Path) -> dict:
    res = greedy.solve(read_json(problem_path))
    write_json(result_path, res)
    return res


def test_gallery_from_a_run(tmp_path, monkeypatch):
    monkeypatch.chdir(paths.REPO)
    problems = _problems(tmp_path / "problems")
    rep = tmp_path / "rep"
    ext = f"rust={sys.executable} -m bench.solvers.greedy {{problem}} -o {{result}}"
    assert run.main(["--problems", str(problems), "--out", str(rep), "--solver", ext, "--solver", "greedy",
                     "--solver", "naive", "--runs", "1"]) == 0
    out = rep / "gallery"
    assert gallery.build(out, _solve, problems, rep, SECTIONS, log=lambda m: None) == 0
    page = (out / "index.html").read_text(encoding="utf-8")
    assert page.startswith("<!doctype html>") and "<title>Label Anything Gallery</title>" in page
    assert '<section id="tests">' in page and 'href="#tests"' in page and "Never shown" not in page
    assert "Bubbles &amp; labels: 3 of 3" in page and "<code>markup</code>" in page and "0 leaders" in page
    data = read_json(out / "gallery.json")
    fig = data["figures"]["03-gapminder/y2005-vector"]
    assert (fig["placed"], fig["total"], fig["hard_violations"]) == (3, 3, 0)
    assert fig["settings"]["items"] == 3 and fig["reasons"] == {}
    # one vector image: the page shows it at the canvas size, the viewer zooms into the same file
    assert fig["img"] == fig["full"] == "img/03-gapminder__y2005-vector.svg" and fig["size"] == [200, 100]
    assert fig["full_size"] == [round(200 * gallery.ZOOM), round(100 * gallery.ZOOM)]
    root = ET.parse(out / fig["img"]).getroot()
    assert root.get("viewBox") == "0 0 200 100" and "@font-face" in (out / fig["img"]).read_text(encoding="utf-8")
    assert (f'href="{fig["full"]}" target="_blank" rel="noopener" data-w="{fig["full_size"][0]}" '
            f'data-h="{fig["full_size"][1]}" data-bw="200" data-vector="1"') in page
    assert '<dialog class="viewer" id="viewer"' in page and "dlg.showModal()" in page
    # the settings of the problem, a download link; the limits section last, with its figure
    assert "Settings of this problem" in page and f'<a href="{fig["img"]}" download>SVG</a>' in page
    assert page.index('<section id="tests">') < page.index('<section id="weak">')
    assert 'class="fig limit"' in page and "0 omitted." in page
    # one font weight on the page
    assert "font-weight: 700" not in page and "NotoSans-Bold" not in page
    # the run's renderings of the same problem: Label Anything and the greedy baseline (naive is not shown)
    (cmp,) = data["comparisons"]
    assert [c["solver"] for c in cmp["cells"]] == ["rust", "greedy"]
    assert all((out / c["img"]).exists() and c["full"] == c["img"] for c in cmp["cells"])
    assert [c["img"] for c in cmp["cells"]] == [f"img/cmp/{s}/03-gapminder__y2005-vector.svg"
                                                for s in ("rust", "greedy")]
    assert 'class="cell mine"' in page
    # self-contained (fonts and their licence), linked from and to the report
    assert (out / "fonts" / "NotoSans-Regular.ttf").exists() and (out / "fonts" / "OFL.txt").exists()
    assert not (out / "fonts" / "NotoSans-Bold.ttf").exists()
    assert "fonts.googleapis" not in page and 'href="../index.html"' in page
    assert "href='gallery/'" in (rep / "index.html").read_text(encoding="utf-8")


def test_stability_frames(tmp_path):
    rep = tmp_path / "rep"
    imgs = []
    for k in (0, 15, 29):
        p = rep / "img" / "rust" / "11-stability" / "zoom" / f"frame{k:03d}.png"
        p.parent.mkdir(parents=True, exist_ok=True)
        Image.new("RGB", (40, 30), "white").save(p)
        imgs.append(str(p.relative_to(rep)))
    steps = [{"step": "zoom_in", "flip_rate": 0.25}] * 19 + [{"step": "pan", "flip_rate": 0.05}] * 10
    report = {"sequences": [
        {"solver": "naive", "scenario": "11-stability", "sequence": "zoom", "images": imgs},
        {"solver": "rust", "scenario": "11-stability", "sequence": "zoom", "images": imgs, "frames": [{}] * 30,
         "metrics": {"steps": steps, "displacement_median_px": 3.0, "nesting_fraction_mean": 0.8}}]}
    st = gallery.stability(rep, report, tmp_path / "out")
    assert [f["frame"] for f in st["frames"]] == [1, 16, 30]
    assert all(f["full"] == f["img"] for f in st["frames"])  # frames are zoomed as the run rendered them
    assert (st["zoom_steps"], st["pan_steps"], st["flips_zoom"], st["flips_pan"]) == (19, 10, 0.25, 0.05)
    assert all((tmp_path / "out" / f["img"]).exists() for f in st["frames"])
    html = gallery.stability_html(st)
    assert "Frame 30 of 30" in html and "25 % change side per zoom step" in html and "80 % of labels" in html
    assert "makes 25 % of the labels change sides" in html


def test_missing_run_parts_are_left_out(tmp_path):
    assert gallery.comparisons(tmp_path, {"results": []}, tmp_path / "out") == []
    assert gallery.stability(tmp_path, {"sequences": []}, tmp_path / "out") is None
    assert gallery.problem_files(tmp_path, "03-gapminder/y2005-vector") is None


def test_split_word_follows_the_break_rules():
    t = "uimanager.UIImplementationProvider"
    # "UI·Implementation" is an acronym break, "Implementat|ion" breaks inside a word
    assert gallery.split_word({"lines": ["uimanager.UI", "Implementat", "ionProvider"]}, t)
    assert not gallery.split_word({"lines": ["uimanager.UI", "ImplementationProvider"]}, t)
    assert not gallery.split_word({"lines": ["uimanager.UIView", "OperationQueue"]}, "uimanager.UIViewOperationQueue")
    assert not gallery.split_word({"lines": ["Hong Kong,", "China"]}, "Hong Kong, China")
    assert gallery.split_word({"lines": ["Mytili", "ni"]}, "Mytilini")
