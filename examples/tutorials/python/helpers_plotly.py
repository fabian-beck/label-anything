"""The Plotly helper (docs/getting-started/python.md): annotations and leader shapes for a
Plotly scatter plot. Writes plotly.html."""

import csv

# --8<-- [start:plotly]
import plotly.graph_objects as go
import label_anything as la
from label_anything.plotly import label_points

rows = list(csv.DictReader(open("points.csv")))
x = [float(r["x"]) for r in rows]
y = [600 - float(r["y"]) for r in rows]
fig = go.Figure(go.Scatter(x=x, y=y, mode="markers", marker={"size": 6, "color": "#9aa5b1"}))
out = label_points(fig, x, y, [r["name"] for r in rows],               # adds layout annotations
                   priority=la.Priority.outlierness(), max_labels=15)  # and leader shapes to fig
fig.write_html("plotly.html", include_plotlyjs="cdn")
print(out.result, len(out.annotations), "annotations,", len(out.shapes), "leader shapes")
# --8<-- [end:plotly]
assert out.result.stats["hard_violations"] == 0 and len(out.annotations) == len(out.result.placed) > 0
print("ok")
