"""Interactive maps and stability (docs/tutorials/interactive-maps.md): re-label a map
after every pan and zoom, warm-started from the previous frame, and measure how much the
labels move."""

import json
import math
from pathlib import Path

import label_anything as la

cities = json.loads(Path("../problems/priority-cities.json").read_text())["items"]
world = {c["id"]: (c["anchor"]["x"], c["anchor"]["y"]) for c in cities}
pop = {c["id"]: c["attrs"]["pop"] for c in cities}
W, H = 480, 320


# --8<-- [start:frames]
def view(zoom, cx, cy):
    """Screen positions of the cities visible from a camera at (cx, cy)."""
    pos = {}
    for key, (x, y) in world.items():
        sx, sy = (x - cx) * zoom + W / 2, (y - cy) * zoom + H / 2
        if 0 <= sx <= W and 0 <= sy <= H:
            pos[key] = (sx, sy)
    return pos


def follow(res, before, after):
    """The previous labels, each box moved with its anchor: the next frame's warm start."""
    moved = []
    for p in res.placed:
        if p.id in after:
            dx, dy = after[p.id][0] - before[p.id][0], after[p.id][1] - before[p.id][1]
            moved.append({"id": p.id, "placed": True, "box": {"x": p.box.x + dx, "y": p.box.y + dy, "w": p.box.w, "h": p.box.h}})
    return moved


def label(pos, warm=None):
    ids = list(pos)                      # stable ids and the same priority in every frame
    return la.place([pos[i] for i in ids], ids, ids=ids, canvas=(W, H), font_size=14,
                    priority=[pop[i] for i in ids], models=["adjacent", "slider"], warm_start=warm)


camera = [(1.0, 240, 160), (1.0, 252, 166), (1.3, 255, 168), (1.7, 258, 170), (2.2, 262, 172)]
frames, prev, prev_pos = [], None, None
for zoom, cx, cy in camera:
    pos = view(zoom, cx, cy)
    res = label(pos, follow(prev, prev_pos, pos) if prev else None)
    print(f"zoom {zoom}: {res}", res.stats.get("flicker"))
    frames.append((pos, res))
    prev, prev_pos = res, pos
# --8<-- [end:frames]


def offsets(pos, res):
    return {p.id: (p.box.cx - pos[p.id][0], p.box.cy - pos[p.id][1]) for p in res.placed}


def movement(frames):
    """Mean change of label offsets (box center - anchor) between consecutive frames, px."""
    d = []
    for (pa, ra), (pb, rb) in zip(frames, frames[1:]):
        oa, ob = offsets(pa, ra), offsets(pb, rb)
        d += [math.dist(oa[i], ob[i]) for i in oa.keys() & ob.keys()]
    return sum(d) / len(d)


# --8<-- [start:nesting]
nested = 0
for (pa, ra), (pb, rb) in zip(frames[1:], frames[2:]):     # the zoom-in steps
    still_visible = {p.id for p in ra.placed if p.id in pb}
    nested += still_visible <= {p.id for p in rb.placed}  # labels only get added when zooming in
print(f"{nested} of {len(frames) - 2} zoom-in steps nest")
# --8<-- [end:nesting]

cold = []
for zoom, cx, cy in camera:
    pos = view(zoom, cx, cy)
    cold.append((pos, label(pos)))
warm_move, cold_move = movement(frames), movement(cold)
print(f"mean label movement per frame: {warm_move:.1f} px warm-started, {cold_move:.1f} px without")
assert warm_move < cold_move, (warm_move, cold_move)
assert all(r.stats["hard_violations"] == 0 for _, r in frames)
assert all("flicker" in r.stats for _, r in frames[1:])
assert nested >= len(frames) - 3, nested
print("ok")
