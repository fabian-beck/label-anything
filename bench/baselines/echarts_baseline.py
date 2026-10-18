"""ECharts baseline: Apache ECharts scatter labels with ``labelLayout: {hideOverlap: true}``, rendered
server-side in Node (no DOM).

Translation (see bench/baselines/README.md and echarts_layout.mjs):

* one scatter series on value axes of exactly the canvas: every labeled item is a symbol at its anchor
  (circle marks: their diameter; other marks: their bounding box as a rect symbol), in priority order,
* every label at one position, the first of the problem's position order that ECharts has outside the
  symbol (top / right / bottom / left; a diagonal first position gives its horizontal side), at
  ``placement.offset`` from the symbol (``label.distance``),
* ``hideOverlap`` hides labels that overlap one already shown, larger symbols first (ECharts' default
  priority), ties in data order; it compares labels only: marks and obstacle classes are not avoided
  (unsupported), labels may leave the label area. No leader lines.

    python -m bench.baselines.echarts_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse

from ..common.geom import Box, Circle
from ..common.jsonio import read_json, write_json
from . import node
from .results import build_result
from .scene import Note, Scene, build_scene, without_obstacles

TOOL = "echarts"
OBSTACLES = False  # the tool is told no obstacle classes: soft emulations do not differ
SIDES = ("top", "right", "bottom", "left")


def version() -> str | None:
    return node.pkg_version("echarts")


def available() -> str | None:
    return node.available(("echarts", "zrender"))


def position(scene: Scene) -> str:
    """The first position of the problem's order that ECharts has outside the symbol."""
    for p in scene.positions:
        for s in (p, p.split("-")[-1]):
            if s in SIDES:
                return s
    return "right"


def scene_json(scene: Scene) -> tuple[dict, list[Note]]:
    """The scene handed to echarts_layout.mjs (canvas px) and the tool-specific notes."""
    labels = []
    rects = False
    for lab in scene.labels:
        e = {"id": lab.id, "x": lab.x, "y": lab.y, "w": lab.w, "h": lab.h, "font_size": lab.font_size,
             "bold": lab.font_weight >= 550}
        if isinstance(lab.shape, Circle):
            e["d"] = 2.0 * lab.shape.r
        else:
            b = lab.mark_box
            e["rect"] = [b.w, b.h]
            rects = True
        labels.append(e)
    pos = position(scene)
    offsets = {lab.offset for lab in scene.labels}
    notes = [Note("unsupported", "echarts-obstacles", "ECharts' hideOverlap compares labels only: marks and "
                                                      "obstacle classes are not avoided"),
             Note("unsupported", "echarts-positions", f"one position for every label ({pos}); no alternatives, "
                                                      "no leader lines"),
             Note("unsupported", "echarts-priority", "hideOverlap keeps labels of larger symbols first (ties in "
                                                     "priority order)")]
    if rects:
        notes.append(Note("emulation", "echarts-marks", "marks other than circles are rect symbols of their "
                                                        "bounding box"))
    if len(offsets) > 1:
        notes.append(Note("unsupported", "echarts-offsets", "per-item offsets: ECharts uses one distance"))
    return ({"width": scene.width, "height": scene.height, "position": pos,
             "distance": scene.labels[0].offset if scene.labels else 0.0, "labels": labels}, notes)


def solve(problem: dict, problem_path=None, options: dict | None = None) -> dict:
    """``options``: ``soft`` (``hard`` or ``ignore``), how soft classes reach the tool (``build_scene``)."""
    scene = without_obstacles(build_scene(problem, problem_path, soft=(options or {}).get("soft", "hard")))
    js, notes = scene_json(scene)
    out = node.run("echarts_layout.mjs", js, "la-echarts-")
    by_id = {lab.id: lab for lab in scene.labels}
    boxes = {}
    for e in out["labels"]:
        lab = by_id.get(e["id"])
        if lab is None or e.get("hidden"):
            continue
        boxes[lab.id] = Box(float(e["x"]), float(e["y"]), float(e["x"]) + lab.w, float(e["y"]) + lab.h)
    v = out.get("versions", {})
    return build_result(scene, boxes, {}, float(out.get("runtime_ms", 0.0)), f"echarts/{v.get('echarts')}", notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
