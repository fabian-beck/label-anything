"""d3fc baseline: d3fc-label-layout's ``layoutRemoveOverlaps(layoutGreedy())`` (the README's strategy), headless
in Node.

Translation (see bench/baselines/README.md and d3fc_layout.mjs):

* the labels in priority order (greedy places them in input order), each as its box grown by
  m = mark radius + ``placement.offset`` on every side, anchored at the item's anchor point: d3fc puts a
  corner or an edge midpoint of the rect at the anchor (8 positions), so the box keeps m from it,
* ``bounds`` = the label area; greedy prefers positions inside it, it does not enforce them,
* d3fc knows only the labels: marks and obstacle classes are not avoided (unsupported), labels may cover
  them; hidden labels are reported unplaced. No leader lines.

    python -m bench.baselines.d3fc_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse

from ..common.geom import Box
from ..common.jsonio import read_json, write_json
from . import node
from .results import build_result
from .scene import Note, Scene, build_scene, without_obstacles

TOOL = "d3fc"
OBSTACLES = False  # the tool is told no obstacle classes: soft emulations do not differ
PACKAGE = "@d3fc/d3fc-label-layout"
MAX_N = 2500  # removeOverlaps compares every visible pair once per hidden label: O(n³) in dense problems


def version() -> str | None:
    return node.pkg_version(PACKAGE)


def available() -> str | None:
    return node.available((PACKAGE, "d3-array"))


def scene_json(scene: Scene) -> tuple[dict, list[Note]]:
    """The scene handed to d3fc_layout.mjs (canvas px) and the tool-specific notes."""
    a = scene.area
    labels = [{"id": lab.id, "x": lab.x, "y": lab.y, "w": lab.w, "h": lab.h, "m": lab.mark_radius + lab.offset}
              for lab in scene.labels]
    notes = [Note("unsupported", "d3fc-obstacles", "d3fc-label-layout avoids only other labels: marks and obstacle "
                                                   "classes are not avoided"),
             Note("emulation", "d3fc-margin", "each label is handed over grown by its mark radius + offset on "
                                              "every side (d3fc puts labels at their anchor point)"),
             Note("unsupported", "d3fc-leaders", "d3fc-label-layout draws no leader lines (8 fixed positions)")]
    return {"area": [a.x0, a.y0, a.x1, a.y1], "labels": labels}, notes


def solve(problem: dict, problem_path=None, options: dict | None = None) -> dict:
    """``options``: ``soft`` (``hard`` or ``ignore``), how soft classes reach the tool (``build_scene``)."""
    from . import Unsupported

    scene = without_obstacles(build_scene(problem, problem_path, soft=(options or {}).get("soft", "hard")))
    if len(scene.labels) > MAX_N:
        raise Unsupported(f"{len(scene.labels):,} labels: d3fc's removeOverlaps compares every visible pair "
                          f"once per hidden label (limit {MAX_N:,} labels)")
    js, notes = scene_json(scene)
    out = node.run("d3fc_layout.mjs", js, "la-d3fc-")
    by_id = {lab.id: lab for lab in scene.labels}
    boxes = {}
    for e in out["labels"]:
        lab = by_id.get(e["id"])
        if lab is None or e.get("hidden"):
            continue
        boxes[lab.id] = Box(float(e["x"]), float(e["y"]), float(e["x"]) + lab.w, float(e["y"]) + lab.h)
    v = out.get("versions", {})
    return build_result(scene, boxes, {}, float(out.get("runtime_ms", 0.0)),
                        f"d3fc-label-layout/{v.get('d3fc-label-layout')}", notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
