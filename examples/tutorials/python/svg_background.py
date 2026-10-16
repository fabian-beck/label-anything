"""Labels over an SVG background (docs/tutorials/svg-background.md): class rules with CSS
selectors, item marks taken from the SVG, and checking what the rules matched."""

import csv
import json
from pathlib import Path

# --8<-- [start:place]
import label_anything as la

rows = list(csv.DictReader(open("outliers.csv")))
res = la.place(
    anchors=[(float(r["x"]), float(r["y"])) for r in rows],
    labels=[r["name"] for r in rows],
    ids=[r["id"] for r in rows],
    svg_ids=[r["id"] for r in rows],       # <circle id="o3"> draws item "o3" ...
    auto_mark_items=True,                  # ... and becomes its mark
    background="scatter.svg",
    svg_classes=[                          # first match wins
        ("#background", "ignore"),
        (".legend *", "legend"),
        ("text", "text"),
        (".grid line", "grid"),
        (".axis line", "axes"),
        ("circle.point", "points"),
        ("path.trend", "lines"),
    ],
    avoid={"legend": "hard", "grid": "ignore", "points": 0.3, "lines": 1.5},
    avoid_leader={"legend": "hard", "grid": "ignore"},
    preset="scatter",
)
print(res, res.stats["grid"]["classes"])
# --8<-- [end:place]
assert res.stats["hard_violations"] == 0 and len(res.placed) >= 18, res
assert {"legend", "text", "axes", "points", "lines"} <= set(res.stats["grid"]["classes"]), res.stats["grid"]
# the JSON version of this tutorial (problems/svg-classes.json) is the same problem
same = la.place_problem(Path("../problems/svg-classes.json"))
assert [(p.id, p.box) for p in same.placements] == [(p.id, p.box) for p in res.placements]

# --8<-- [start:warnings]
report = la.validate({
    "items": [{"anchor": {"type": "point", "x": 10, "y": 10}, "label": {"type": "text", "text": "A"}}],
    "obstacles": {"svg": {"source": "<svg xmlns='http://www.w3.org/2000/svg' width='100' height='50'/>",
                          "classes": [{"selector": "path.trend", "class": "lines"}]}},
    "avoid": {"label": {"lnies": 2.0}},    # a typo: no rule produces this class
})
print(report.valid, report.warnings)       # True [{'pointer': '/avoid/label/lnies', 'code': 'unknown_class', ...}]
# --8<-- [end:warnings]
assert report.valid and report.warnings[0]["code"] == "unknown_class", report

# --8<-- [start:debug]
res = la.place(
    anchors=[(float(r["x"]), float(r["y"])) for r in rows], labels=[r["name"] for r in rows],
    background="scatter.svg", preset="scatter", debug_svg=True,
)
res.to_svg("scatter-debug.svg")            # one heatmap layer per class: heatmap-points, ...
# --8<-- [end:debug]
svg = open("scatter-debug.svg").read()
assert 'id="heatmap-points"' in svg and 'id="heatmap-lines"' in svg and 'id="heatmap-text"' in svg, "heatmaps"
print(json.dumps(res.stats["grid"]))
print("ok")
