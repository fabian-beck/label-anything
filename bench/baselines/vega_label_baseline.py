"""vega-label baseline: Vega's ``label`` transform (Kittivorawong et al.), run headless in Node.

Translation (see bench/baselines/README.md and vega_label.mjs):

* layout = the label area (``size`` = its width and height, ``padding: 0``);
  coordinates are canvas px minus the area's origin (y down, as in Vega),
* base mark: a ``path`` mark with every labeled item's true mark outline;
  ``avoidBaseMark: true`` keeps labels off all labeled marks,
* ``avoidMarks``: one mark per obstacle layer — circles as ``symbol``s
  (area π r²), rects as ``rect``s, polylines as stroked ``path``s with their
  stroke width, polygons as filled paths, raster class masks as one filled path
  of horizontal pixel runs per class (emulation), marks of items that are not
  labeled,
* ``anchor``: the 8 adjacent positions in the problem's position order
  (perceptual unless the preset or problem says otherwise), ``offset``: the
  problem's ``placement.offset``, ``sort``: the reference priority rank,
* text measurement: the problem's label box (see vega_label.mjs).

vega-label draws no leader lines; labels it cannot place get opacity 0 and are
reported unplaced.

    python -m bench.baselines.vega_label_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..common.geom import Box, Circle
from ..common.jsonio import read_json, write_json
from .results import build_result
from .scene import Note, Scene, build_scene

TOOL = "vega-label"
HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "vega_label.mjs"
NODE_MODULES = HERE / "node_modules"
MAX_RUNS = 400_000  # pixel runs per raster mask before falling back to 2-px cells
TIMEOUT = 900.0


def _pkg_version(name: str) -> str | None:
    try:
        return json.loads((NODE_MODULES / name / "package.json").read_text(encoding="utf-8"))["version"]
    except (OSError, ValueError, KeyError):
        return None


def version() -> str | None:
    v = _pkg_version("vega-label")
    return f"{v} (vega {_pkg_version('vega')})" if v else None


def available() -> str | None:
    node = shutil.which("node")
    if node is None:
        return "node is not on PATH (Node ≥ 20 is required)"
    try:
        out = subprocess.run([node, "--version"], capture_output=True, text=True, timeout=30).stdout.strip()
        major = int(out.lstrip("v").split(".")[0])
    except (OSError, ValueError, subprocess.SubprocessError):
        return "cannot run node --version"
    if major < 20:
        return f"node {out} is older than 20"
    for pkg in ("vega", "vega-label", "canvas"):
        if _pkg_version(pkg) is None:
            return f"{pkg} is not installed (npm ci --prefix bench/baselines)"
    return None


def _fmt(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return s if s not in ("-0", "") else "0"


def _ring_path(ring, ox: float, oy: float) -> str:
    pts = list(ring)
    return ("M" + " L".join(f"{_fmt(x - ox)},{_fmt(y - oy)}" for x, y in pts) + " Z") if len(pts) >= 3 else ""


def _shape_path(shape, ox: float, oy: float) -> str:
    if isinstance(shape, Circle):
        x, y, r = shape.cx - ox, shape.cy - oy, max(shape.r, 0.25)
        return (f"M{_fmt(x - r)},{_fmt(y)} A{_fmt(r)},{_fmt(r)} 0 1,0 {_fmt(x + r)},{_fmt(y)} "
                f"A{_fmt(r)},{_fmt(r)} 0 1,0 {_fmt(x - r)},{_fmt(y)} Z")
    return " ".join(p for p in (_ring_path(r, ox, oy) for r in shape.rings()) if p)


def scene_json(scene: Scene) -> tuple[dict, list[Note]]:
    """The scene handed to vega_label.mjs (layout coordinates) and the tool-specific notes."""
    a = scene.area
    ox, oy = a.x0, a.y0
    notes: list[Note] = []
    labels = [{"id": lab.id, "text": lab.text, "w": lab.w, "h": lab.h, "rank": lab.rank,
               "path": _shape_path(lab.shape, ox, oy)} for lab in scene.labels]
    layers: list[dict] = []
    labeled = {lab.id for lab in scene.labels}
    others = [shp for iid, shp in scene.marks if iid not in labeled]
    if others:
        layers.append({"name": "other_marks", "type": "path",
                       "values": [{"path": _shape_path(s, ox, oy)} for s in others]})
    obs = scene.obstacles
    for k, cls in enumerate(obs.classes()):
        circ = [{"x": x - ox, "y": y - oy, "size": math.pi * r * r} for x, y, r, c in obs.circles if c == cls]
        if circ:
            layers.append({"name": f"c{k}_circles", "type": "symbol", "values": circ})
        rects = [{"x": x - ox, "y": y - oy, "w": w, "h": h} for x, y, w, h, c in obs.rects if c == cls]
        if rects:
            layers.append({"name": f"c{k}_rects", "type": "rect", "values": rects})
        lines = [{"path": "M" + " L".join(f"{_fmt(x - ox)},{_fmt(y - oy)}" for x, y in pts), "width": max(w, 0.5)}
                 for pts, w, c in obs.polylines if c == cls]
        if lines:
            layers.append({"name": f"c{k}_lines", "type": "stroke", "values": lines})
        polys = [{"path": " ".join(p for p in (_ring_path(r, ox, oy) for r in rings) if p)}
                 for rings, c in obs.polygons if c == cls]
        if polys:
            layers.append({"name": f"c{k}_polygons", "type": "path", "values": polys})
        for j, m in enumerate(mm for mm in obs.masks if mm.cls == cls):
            runs = m.runs()
            how = f"{len(runs)} pixel runs"
            if len(runs) > MAX_RUNS:
                runs = [(x0, y0, s, s) for x0, y0, s in m.cells(2.0)]
                how = f"{len(runs)} cells of 2 px"
            path = " ".join(f"M{_fmt(x - ox)},{_fmt(y - oy)}h{_fmt(w)}v{_fmt(h)}h{_fmt(-w)}Z" for x, y, w, h in runs)
            layers.append({"name": f"c{k}_raster{j}", "type": "path", "values": [{"path": path}] if path else []})
            notes.append(Note("emulation", f"vega-raster:{cls}", f"raster class {cls!r} as a filled path of {how}"))
    anchors = [p for p in scene.positions if p in ("top", "right", "bottom", "left", "top-right", "bottom-right",
                                                    "top-left", "bottom-left")]
    offset = scene.labels[0].offset if scene.labels else 0.0
    if len({lab.offset for lab in scene.labels}) > 1:
        notes.append(Note("unsupported", "vega-offsets", "per-item offsets: vega-label uses one offset "
                                                         f"({offset:g} px)"))
    notes.append(Note("unsupported", "vega-leaders", "vega-label draws no leader lines (adjacent anchors only)"))
    return ({"width": a.w, "height": a.h, "offset": offset, "anchors": anchors, "labels": labels,
             "layers": layers}, notes)


ALIGN = {"left": 0.0, "center": 0.5, "right": 1.0}
BASELINE = {"top": 0.0, "middle": 0.5, "bottom": 1.0}


def box_from_label(x: float, y: float, align: str, baseline: str, w: float, h: float, origin=(0.0, 0.0)) -> Box:
    """Canvas box of a vega-label result (anchor point x, y in layout coordinates + align / baseline)."""
    x0 = origin[0] + x - ALIGN.get(align, 0.0) * w
    y0 = origin[1] + y - BASELINE.get(baseline, 0.0) * h
    return Box(x0, y0, x0 + w, y0 + h)


def solve(problem: dict, problem_path=None) -> dict:
    scene = build_scene(problem, problem_path)
    js, notes = scene_json(scene)
    with tempfile.TemporaryDirectory(prefix="la-vega-") as d:
        sp, op = Path(d) / "scene.json", Path(d) / "out.json"
        sp.write_text(json.dumps(js), encoding="utf-8")
        r = subprocess.run([shutil.which("node") or "node", str(SCRIPT), str(sp), str(op)], capture_output=True,
                           text=True, timeout=TIMEOUT)
        if r.returncode != 0:
            raise RuntimeError(f"vega_label.mjs failed ({r.returncode}): {r.stderr.strip()[-800:]}")
        out = json.loads(op.read_text(encoding="utf-8"))
    by_id = {lab.id: lab for lab in scene.labels}
    boxes = {}
    for e in out["labels"]:
        lab = by_id.get(e["id"])
        if lab is None or not e.get("opacity") or e.get("x") is None:
            continue
        boxes[lab.id] = box_from_label(float(e["x"]), float(e["y"]), e.get("align") or "left",
                                       e.get("baseline") or "top", lab.w, lab.h, (scene.area.x0, scene.area.y0))
    v = out.get("versions", {})
    impl = f"vega-label/{v.get('vega-label')} (vega {v.get('vega')}, canvas {v.get('canvas')})"
    return build_result(scene, boxes, {}, float(out.get("runtime_ms", 0.0)), impl, notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
