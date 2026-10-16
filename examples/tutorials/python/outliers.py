"""Label your outliers in five lines (docs/tutorials/outliers.md).

The chart is already drawn (scatter.png); outliers.csv lists the outliers to label. Run
in a copy of examples/tutorials/data (examples/tutorials/run.py does that).
"""

# --8<-- [start:five]
import csv
import label_anything as la

rows = list(csv.DictReader(open("outliers.csv")))
res = la.place(anchors=[(float(r["x"]), float(r["y"])) for r in rows], labels=[r["name"] for r in rows],
               background="scatter.png", preset="scatter")
for p in res.placements:
    print(p.lines, p.box, p.leader)
res.to_svg("outliers.svg")
# --8<-- [end:five]

# --- checks (not shown in the docs) ---
assert res.stats["hard_violations"] == 0 and res.stats["leader_crossings"] == 0
assert len(res.placed) >= 18, res
assert open("outliers.svg").read().startswith("<svg")
print("ok:", res)
