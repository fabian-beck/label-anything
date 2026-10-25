"""Build scenario 13: the outlier-labeling figures of Mumtaz et al. (EuroVis 2019), reconstructed.

The scatterplots of Figures 1, 3, 4 and 8 of *Label Placement for Outliers in Scatterplots*
(doi:10.2312/evs.20191161), digitized into ``figures.json`` (``digitize.py``): the outliers with
their names, the other points, the axes, and where the paper's own algorithm put each label. The
canvas is the figure scaled so that 12 px labels in the bundled Noto Sans are as wide as the
paper's; labels stay inside the axes (top and right, as in the paper), the other points are soft
``points`` (preset ``scatter``), priority = outlierness (mean distance to the 5 nearest points).

Every config also gets the paper's published layout as a result next to the problem
(``<config>.published.json``): each label box centred on the text in the figure, with a straight
leader where the figure draws one, for ``python -m bench.eval``.
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.baselines.results import build_result  # noqa: E402
from bench.baselines.scene import build_scene, ray_exit  # noqa: E402
from bench.common.geom import Box  # noqa: E402
from bench.common.jsonio import read_json, write_json  # noqa: E402
from bench.common.scenario import Writer, base_problem  # noqa: E402

SCENARIO = "13-outlier-paper"
HERE = Path(__file__).resolve().parent
CONFIGS = {  # config: description
    "fig1-cbo-rfc": "Figure 1: 19 outlier classes of redactor by coupling (cbo) and response (rfc), 125 other "
                    "classes as soft points.",
    "fig3-cbo-wmc": "Figure 3: 27 outliers by coupling (cbo) and weighted methods (wmc).",
    "fig4-cbo-wmc-more": "Figure 4: Figure 3 with a lower outlier threshold, 33 outliers.",
    "fig8-income-disorders": "Figure 8: 17 outlier U.S. states by median income and the rate of mental disorders.",
}


def inv(v: float, cal) -> float:
    (p0, v0), (p1, v1) = cal
    return p0 + (v - v0) * (p1 - p0) / (v1 - v0)


def problem(fig: dict) -> tuple[dict, dict]:
    """The problem of one figure and the canvas position of each outlier (by name)."""
    s = fig["scale"]
    xn, yn = fig["x"]["name"], fig["y"]["name"]

    def px(o) -> tuple[float, float]:
        return (round(inv(o[xn], fig["x"]["ticks"]) * s, 2), round(inv(o[yn], fig["y"]["ticks"]) * s, 2))

    at = {o["name"]: px(o) for o in fig["outliers"]}
    others = [px(o) for o in fig["others"]]
    pts = list(at.values()) + others

    def outlierness(p) -> float:
        d = sorted(math.dist(p, q) for q in pts if q is not p)
        return sum(d[:5]) / 5

    r = fig["dot_radius"] * s
    items = [{"id": o["name"], "anchor": {"type": "point", "x": at[o["name"]][0], "y": at[o["name"]][1],
                                          "mark": {"shape": "circle", "r": r}},
              "label": {"type": "text", "text": o["name"]},
              "attrs": {xn: o[xn], yn: o[yn], "outlierness": round(outlierness(at[o["name"]]), 3)}}
             for o in fig["outliers"]]
    items.sort(key=lambda it: (-it["attrs"]["outlierness"], it["id"]))
    w, h = fig["image_size"][0] * s, fig["image_size"][1] * s
    x0, y0, x1, y1 = (v * s for v in fig["plot"])
    p = base_problem(w, h, "scatter", font_size=12.0, padding=0.0)
    p["canvas"]["region"] = [x0, y0, x1 - x0, y1 - y0]
    p["priority"] = {"terms": [{"attr": "outlierness"}]}
    p["obstacles"] = {"vector": [{"class": "points", "r": r, "points": [list(q) for q in others]}]}
    p["items"] = items
    return p, at


def published(problem_dict: dict, fig: dict) -> dict:
    """The paper's layout as a result: the problem's label box centred on the printed text, a straight
    leader from the dot to the box where the figure draws one."""
    s = fig["scale"]
    scene = build_scene(problem_dict)
    text = {o["name"]: o for o in fig["outliers"]}
    boxes, ports = {}, {}
    for lab in scene.labels:
        o = text[lab.id]
        x0, y0, x1, y1 = (v * s for v in o["label"])
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        box = Box(cx - lab.w / 2, cy - lab.h / 2, cx + lab.w / 2, cy + lab.h / 2)
        boxes[lab.id] = box
        ports[lab.id] = ray_exit(box, (box.cx, box.cy), (lab.x, lab.y)) if o["leader"] else None
    res = build_result(scene, boxes, ports, 0.0, "mumtaz2019-published")
    res["warnings"] = [{"code": "digitized", "pointer": "",
                        "message": f"the layout of {fig['figure']} of Mumtaz et al. (2019), digitized"}]
    return res


def main() -> None:
    doc = read_json(HERE / "figures.json")
    wr = Writer(SCENARIO, "Outlier labeling, after Mumtaz et al. (2019)", [],
                notes="Figures 1, 3, 4 and 8 of Mumtaz et al., Label Placement for Outliers in Scatterplots "
                      "(EuroVis 2019), digitized; see README.md.")
    for k, (name, desc) in enumerate(CONFIGS.items()):
        fig = doc["figures"][name]
        p, _ = problem(fig)
        entry = wr.config(name, p, quick=k == 0, description=desc)
        out = wr.dir / f"{name}.published.json"
        write_json(out, published(read_json(wr.dir / entry["files"]["problem"]), fig), nd=3)
        entry["files"]["published"] = out.name
    wr.finish()


if __name__ == "__main__":
    main()
