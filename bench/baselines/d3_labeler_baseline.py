"""D3-Labeler baseline: Evan Wang's simulated-annealing labeler (2013), the original labeler.js run in Node.

Translation (see bench/baselines/README.md and d3_labeler.mjs):

* layout = the label area (coordinates: canvas px minus its origin, y down); the labels in priority
  order, each starting with its baseline-left corner at its anchor (the README's usage), anchors with the
  mark radius (the tool's label–anchor overlap uses the square of side 2r),
* ``start(nsweeps)`` with 1,000 sweeps (the README's value), fewer when a sweep's n² energy terms would
  exceed the comparison budget, seeded,
* the tool knows only the labels and their anchors: other marks and obstacle classes are not avoided
  (unsupported); it never omits a label; its walls keep a label's baseline-left corner in the area, not
  the box. A label away from its mark gets a straight leader (as the tool's demo draws one), from the mark
  to the box edge facing it.

    python -m bench.baselines.d3_labeler_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse

from ..common.geom import Box
from ..common.jsonio import read_json, write_json
from . import node
from .results import build_result
from .scene import Note, Scene, build_scene, ray_exit, without_obstacles

TOOL = "d3-labeler"
OBSTACLES = False  # the tool is told no obstacle classes: soft emulations do not differ
COMMIT = "6de86705a8bbdebb00282aaa61755686f7309b31"  # tinker10/D3-Labeler master, vendor/d3-labeler
SWEEPS = 1000
BUDGET = 4.0e9  # energy terms of the whole run (2 n² per sweep)
MIN_SWEEPS = 100
SEED = 1


def version() -> str | None:
    return COMMIT[:7]


def available() -> str | None:
    if not (node.HERE / "vendor" / "d3-labeler" / "labeler.js").exists():
        return "vendor/d3-labeler/labeler.js is missing"
    return node.available()


def sweeps(n: int) -> int:
    """1,000 sweeps, or as many as the budget allows (``Unsupported`` below ``MIN_SWEEPS``)."""
    from . import Unsupported

    per = 2.0 * n * n
    k = SWEEPS if per <= 0 else min(SWEEPS, int(BUDGET // per))
    if k < MIN_SWEEPS:
        raise Unsupported(f"{n:,} labels: D3-Labeler's {MIN_SWEEPS} sweeps would take {per * MIN_SWEEPS / 1e9:,.0f} G "
                          f"energy terms (budget {BUDGET / 1e9:g} G)")
    return k


def scene_json(scene: Scene) -> tuple[dict, list[Note]]:
    """The scene handed to d3_labeler.mjs (layout coordinates) and the tool-specific notes."""
    a = scene.area
    k = sweeps(len(scene.labels))
    labels = [{"id": lab.id, "x": lab.x - a.x0, "y": lab.y - a.y0, "w": lab.w, "h": lab.h, "r": lab.mark_radius}
              for lab in scene.labels]
    notes = [Note("unsupported", "d3-labeler-obstacles", "D3-Labeler avoids only labels and labeled anchors: other "
                                                         "marks and obstacle classes are not avoided"),
             Note("unsupported", "d3-labeler-omission", "D3-Labeler never omits a label")]
    if k < SWEEPS:
        notes.append(Note("emulation", "d3-labeler-sweeps", f"{k} sweeps instead of {SWEEPS} (comparison budget)"))
    return {"width": a.w, "height": a.h, "sweeps": k, "seed": SEED, "commit": COMMIT[:7], "labels": labels}, notes


def solve(problem: dict, problem_path=None, options: dict | None = None) -> dict:
    """``options``: ``soft`` (``hard`` or ``ignore``), how soft classes reach the tool (``build_scene``)."""
    scene = without_obstacles(build_scene(problem, problem_path, soft=(options or {}).get("soft", "hard")))
    js, notes = scene_json(scene)
    out = node.run("d3_labeler.mjs", js, "la-d3-labeler-")
    by_id = {lab.id: lab for lab in scene.labels}
    a = scene.area
    boxes, ports = {}, {}
    for e in out["labels"]:
        lab = by_id.get(e["id"])
        if lab is None:
            continue
        x, y = float(e["x"]) + a.x0, float(e["y"]) + a.y0
        box = Box(x, y, x + lab.w, y + lab.h)
        boxes[lab.id] = box
        if not box.contains_point((lab.x, lab.y)):
            ports[lab.id] = ray_exit(box, (box.cx, box.cy), (lab.x, lab.y))
    return build_result(scene, boxes, ports, float(out.get("runtime_ms", 0.0)), f"d3-labeler/{COMMIT[:7]}", notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
