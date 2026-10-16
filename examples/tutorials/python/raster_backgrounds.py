"""Raster backgrounds (docs/tutorials/raster-backgrounds.md): an image file with mode
options, and pixels from memory (NumPy, Pillow)."""

import csv
from pathlib import Path

# --8<-- [start:file]
import label_anything as la

rows = list(csv.DictReader(open("outliers.csv")))
res = la.place(
    anchors=[(float(r["x"]), float(r["y"])) for r in rows], labels=[r["name"] for r in rows], ids=[r["id"] for r in rows],
    background="scatter.png",                         # canvas = the image size (/ scale)
    background_mode="ink",
    background_options={"ink": {"background": "auto", "threshold": 0.12, "dilate": 1}},
    avoid={"ink": "hard"},                            # labels never touch drawn pixels ...
    avoid_leader={"ink": 0.5},                        # ... leaders may cross them at a cost
    models=["adjacent", "slider", "distant"],
)
# --8<-- [end:file]
assert res.stats["hard_violations"] == 0 and len(res.placed) >= 18, res
same = la.place_problem(Path("../problems/raster-ink.json"))
assert [(p.id, p.box) for p in same.placements] == [(p.id, p.box) for p in res.placements]

# --8<-- [start:numpy]
import numpy as np
from PIL import Image

pixels = np.asarray(Image.open("map.png").convert("RGBA"))   # H x W x 4, uint8
places = {"harbour": (300, 140), "old-town": (228, 178), "mill": (168, 262), "station": (380, 178)}
res = la.place(
    anchors=list(places.values()), labels=["Harbour", "Old Town", "Mill", "Station"], ids=list(places),
    background=pixels,                                # handed to the engine without copying through JSON
    background_mode="classmap",
    background_options={"classmap": {"#9cc3e6": "water", "#bfe0a8": "parks", "#8f8f8f": "roads"}},
    avoid={"water": "hard", "parks": 0.2, "roads": 1.0},
    mark=la.Mark.circle(3),
)
for p in res.placements:
    print(p.id, p.anchor_side, p.box)
# --8<-- [end:numpy]
assert res.stats["placed"] == 4 and res.stats["hard_violations"] == 0
assert set(res.stats["grid"]["classes"]) >= {"water", "parks", "roads"}, res.stats["grid"]

# --8<-- [start:capabilities]
print(la.capabilities())    # {'svg': True, 'raster_formats': ['png', 'jpeg', 'webp'], 'raw_rgba': True, ...}
# --8<-- [end:capabilities]
assert "png" in la.capabilities()["raster_formats"]
print("ok")
