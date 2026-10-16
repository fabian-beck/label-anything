"""Leaders and leader styles (docs/tutorials/leaders.md): the same dense cluster with every
leader style and with boundary labels, plus reading leaders from the result."""

import json
from pathlib import Path

import label_anything as la

# the cluster and the unlabeled dots of the tutorial problems
cluster = json.loads(Path("../problems/leaders-straight.json").read_text())
names = [it["id"] for it in cluster["items"]]
anchors = [(it["anchor"]["x"], it["anchor"]["y"]) for it in cluster["items"]]
dots = cluster["obstacles"]["vector"][0]["points"]

# --8<-- [start:styles]
common = dict(
    ids=names, canvas=(480, 300), mark=la.Mark.circle(3),
    vector=[{"class": "points", "r": 2, "points": dots}],
    models=["adjacent", "distant"], max_distance="9em",     # distant = labels with leaders
)
styles = {
    "straight": "straight",
    "angles": la.Leaders(style="angles", angles=range(0, 360, 45)),     # 0 = right, 90 = up
    "orthogonal": "orthogonal",
    "elbow": la.Leaders(style="elbow", angles=[45, 135, 225, 315], port="side-center"),
    "curved": "curved",
}
for name, leaders in styles.items():
    res = la.place(anchors, names, leaders=leaders, **common)
    print(f"{name:10}", res, sum(p.leader is not None for p in res.placed), "leaders")
# --8<-- [end:styles]
    same = la.place_problem(Path(f"../problems/leaders-{name}.json"))
    assert [(p.id, p.box) for p in same.placements] == [(p.id, p.box) for p in res.placements], name
    assert all(p.leader.style == name for p in res.placed if p.leader), name

# --8<-- [start:boundary]
res = la.place(anchors, names, ids=names, canvas=(480, 300), mark=la.Mark.circle(3),
               vector=[{"class": "points", "r": 2, "points": dots}],
               models=["boundary"], boundary={"sides": ["left", "right"], "align": "stack"},
               leaders="orthogonal")
# --8<-- [end:boundary]
same = la.place_problem(Path("../problems/leaders-boundary.json"))
assert [(p.id, p.box) for p in same.placements] == [(p.id, p.box) for p in res.placements]
assert sum(p.model == "boundary" for p in res.placed) >= 10, res

# --8<-- [start:read]
for p in res.placed:
    if p.leader is not None:
        print(p.id, p.model, p.leader.style, p.leader.points, p.leader.port, round(p.leader.length, 1))
print(res.stats["leader_crossings"])       # 0: leaders never cross (avoid.leader.leaders is hard)
# --8<-- [end:read]
assert res.stats["leader_crossings"] == 0
print("ok")
