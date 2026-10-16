"""Shapes (docs/tutorials/shapes.md): circles, ellipses, rotated rectangles, polygons,
paths, icons with tips and area anchors, with internal and external labels."""

from pathlib import Path

# --8<-- [start:shapes]
import label_anything as la

marks = {   # item id -> (anchor, mark, label)
    "big": ((100, 110), la.Mark.circle(52), "Large bubble"),
    "medium": ((232, 86), la.Mark.circle(18), "Medium"),
    "small": ((250, 168), la.Mark.circle(5), "Small"),
    "ellipse": ((410, 92), la.Mark.ellipse(74, 34, rotation=-20), "Ellipse"),     # degrees, clockwise
    "card": ((560, 205), la.Mark.rect(120, 50, corner_radius=10, rotation=15), "Rotated card"),
    "triangle": ((105, 285), la.Mark.polygon([(-48, 40), (0, -44), (48, 40)], relative=True), "Triangle"),
    "blob": ((255, 290), la.Mark.path("M-44 0 C-44 -40 30 -46 40 -6 C50 30 -10 44 -30 30 Z", relative=True), "Path"),
    "pin": ((380, 250), la.Mark.icon(22, 32, tip=(11, 32)), "Pin (tip on the anchor)"),
}
p = la.Problem(canvas=(640, 380))
for key, (anchor, mark, text) in marks.items():
    p.item(anchor, text, id=key, mark=mark, placement={"internal": "prefer"} if key == "big" else None)
p.item(la.Area([(440, 280), (560, 262), (620, 320), (580, 368), (450, 360)]), "Region", id="region")
p.item(la.Area([(352, 330), (372, 322), (376, 342), (356, 348)]), "Tiny region", id="islet")
res = p.solve()
for pl in res.placements:
    print(f"{pl.id:9} {pl.model:9} {pl.anchor_side}")
# --8<-- [end:shapes]
same = la.place_problem(Path("../problems/shapes.json"))
assert [(q.id, q.box) for q in same.placements] == [(q.id, q.box) for q in res.placements]
assert res["big"].model == "internal" and res["region"].model == "internal" and res["islet"].model != "internal"

# --8<-- [start:item-shape]
res = la.place([(120, 80)], ["Ellipse"], canvas=(300, 200), marks=[la.Mark.ellipse(40, 16, rotation=30)],
               internal="never", item_shape=True)
print(res.placements[0].raw["item_shape"])     # the resolved geometry in canvas px
# --8<-- [end:item-shape]
assert res.placements[0].model != "internal" and res.placements[0].raw.get("item_shape")
print("ok")
