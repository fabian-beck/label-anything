"""The seaborn helper (docs/getting-started/python.md): column names of a DataFrame, as in
seaborn's own functions. Writes seaborn.png."""

import matplotlib

matplotlib.use("Agg")

# --8<-- [start:seaborn]
import pandas as pd
import seaborn as sns
import label_anything as la
from label_anything.seaborn import label_points

df = pd.read_csv("points.csv")                             # columns x, y, name
df["y"] = 600 - df["y"]
ax = sns.scatterplot(data=df, x="x", y="y", color="#9aa5b1")
out = label_points(ax, data=df, x="x", y="y", label="name",
                   priority=la.Priority.outlierness(), max_labels=15)
ax.figure.savefig("seaborn.png")
# --8<-- [end:seaborn]
assert out.result.stats["hard_violations"] == 0 and len(out.result.placed) == 15, out.result
print("ok")
