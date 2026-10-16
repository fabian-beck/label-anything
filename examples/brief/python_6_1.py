"""The Python example of the design brief (§6.1), verbatim, after a small prelude that
creates what it assumes: outlier pixel positions, their names and a scatter.png.

    python examples/brief/python_6_1.py [--out DIR]
"""

import argparse
import os

import numpy as np
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser()
parser.add_argument("--out", default=".")
os.chdir(parser.parse_args().out)

# --- prelude: a scatter plot as an image, and its 25 farthest points as outliers ---
rng = np.random.default_rng(1)
pts = rng.normal(size=(300, 2)) * [120, 80] + [400, 300]
img = Image.new("RGBA", (800, 600), "white")
draw = ImageDraw.Draw(img)
for x, y in pts:
    draw.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(128, 128, 128, 255))
img.save("scatter.png")
far = np.argsort(-np.hypot(pts[:, 0] - 400, (pts[:, 1] - 300) * 1.5))[:25]
outliers_px = [tuple(pts[i]) for i in far]
names = [f"org.example.Class{i}" for i in far]

# --- §6.1 verbatim ---
import label_anything as la

res = la.place(
    anchors=[(x, y) for x, y in outliers_px],
    labels=names,                         # list[str | la.Icon | la.Box | la.Composite]
    canvas=(800, 600),
    font_size=11,
    background="scatter.png",             # path | bytes | numpy RGBA | SVG string | None
    avoid={"ink": 0.5, "outliers": "hard"},
    leaders="elbow",                      # or la.Leaders(style="angles", angles=range(0, 360, 45))
    preset="scatter",
    priority=la.Priority.outlierness(k=5) + 0.5 * la.Priority.attr("cbo", "log1p")
             - 0.2 * la.Priority.label_size(),   # or a column name, a list of numbers, or a callable(item)
    omission="strict",                    # strict | prefix | weighted
    max_labels=None,
)
print(res.omission_order)                 # ids given up, lowest priority first
for p in res.placements: ...
res.to_svg("debug.svg")

# --- checks ---
placed = sum(1 for p in res.placements if p.placed)
assert placed >= 20, f"only {placed} of 25 labels placed"
assert res.stats["hard_violations"] == 0 and res.stats["leader_crossings"] == 0
assert os.path.getsize("debug.svg") > 1000
print(f"ok: {placed}/25 placed, debug.svg written")
