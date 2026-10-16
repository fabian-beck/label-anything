"""The matplotlib helper (docs/getting-started/python.md): label the most outlying points of
a scatter plot; everything already drawn is an obstacle. Writes matplotlib.png."""

import csv

import matplotlib

matplotlib.use("Agg")

# --8<-- [start:matplotlib]
import matplotlib.pyplot as plt
import label_anything as la
from label_anything.matplotlib import label_points

rows = list(csv.DictReader(open("points.csv")))          # 300 points: x, y, name
x = [float(r["x"]) for r in rows]
y = [600 - float(r["y"]) for r in rows]
fig, ax = plt.subplots(figsize=(7, 4.5), dpi=100)
ax.scatter(x, y, s=12, color="#9aa5b1")
ax.set_title("The 15 most outlying classes")
out = label_points(ax, x, y, [r["name"] for r in rows],
                   priority=la.Priority.outlierness(), max_labels=15, fontsize=8,
                   degrade=["alternatives", "wrap", "distant", "evict_lower", "omit"])
fig.savefig("matplotlib.png", dpi=150)                    # labels are in data coordinates: any dpi works
print(out.result, len(out.texts), "texts,", len(out.leaders), "leaders")
# --8<-- [end:matplotlib]
assert out.result.stats["hard_violations"] == 0 and len(out.result.placed) >= 14, out.result
assert len(out.texts) >= 14
print("ok")
