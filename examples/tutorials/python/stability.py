"""Interactive maps and stability (docs/tutorials/interactive-maps.md): re-label a map
after every pan and zoom from the previous frame, as a window on the map whose labels are
cut at the border of the view. A pan pins the labels: none moves. After a zoom they keep
their places beside their points, and give way only to more important ones."""

import json
import math
from pathlib import Path

import label_anything as la

cities = json.loads(Path("../problems/priority-cities.json").read_text())["items"]
world = {c["id"]: (c["anchor"]["x"], c["anchor"]["y"]) for c in cities}
pop = {c["id"]: c["attrs"]["pop"] for c in cities}
W, H = 480, 320          # the view, and the map at zoom 1
OVERSCAN = 100           # the map is labeled this far beyond the view: about a label's width


# --8<-- [start:frames]
def view(zoom, cx, cy, reach=3 * OVERSCAN):
    """Screen positions of the cities in the view of a camera at (cx, cy) and near it: the
    engine labels those up to the overscan beyond the view, the others are marks only."""
    pos = {}
    for key, (x, y) in world.items():
        sx, sy = (x - cx) * zoom + W / 2, (y - cy) * zoom + H / 2
        if -reach <= sx <= W + reach and -reach <= sy <= H + reach:
            pos[key] = (sx, sy)
    return pos


def label(pos, zoom, cx, cy, warm=None, pin=False):
    ids = list(pos)                      # stable ids and the same priority in every frame
    # the view is a window on the map: labels may cross its edges, where they are cut, and
    # stay on the map, whose bounds in the view are the region
    region = (W / 2 - cx * zoom, H / 2 - cy * zoom, W * zoom, H * zoom)
    return la.place([pos[i] for i in ids], ids, ids=ids, canvas=(W, H), overscan=OVERSCAN, region=region,
                    font_size=14, priority=[pop[i] for i in ids], models=["adjacent", "slider"],
                    warm_start=warm, pin=pin if warm else None)


camera = [(1.0, 240, 160), (1.0, 252, 166), (1.3, 255, 168), (1.7, 258, 170), (1.7, 270, 176), (2.2, 274, 178)]
frames, prev, zoomed = [], None, None
for zoom, cx, cy in camera:
    pos = view(zoom, cx, cy)
    # the previous result: its boxes move with their points. After a pan (the same zoom)
    # they are pinned: no label moves, the solve only adds labels. After a zoom they are
    # pinned too, but give way to more important labels: "yield"
    res = label(pos, zoom, cx, cy, prev, pin=True if zoom == zoomed else "yield")
    flicker = res.stats.get("flicker")   # labels moved, added, removed since the previous frame
    print(f"zoom {zoom}: {res}", flicker and {k: round(v, 1) for k, v in flicker.items()})
    frames.append((pos, res))
    prev, zoomed = res, zoom
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
for (pa, ra), (pb, rb) in zip(frames[1:], frames[2:]):     # the steps after the first pan
    # (a city that left the overscan is a mark only: reason "outside")
    still_labeled = {p.id for p in ra.placed if p.id in pb and rb[p.id].reason != "outside"}
    nested += still_labeled <= {p.id for p in rb.placed}   # labels only get added when zooming in
print(f"{nested} of {len(frames) - 2} steps nest")
# --8<-- [end:nesting]

cold = []
for zoom, cx, cy in camera:
    pos = view(zoom, cx, cy)
    cold.append((pos, label(pos, zoom, cx, cy)))
warm_move, cold_move = movement(frames), movement(cold)
print(f"mean label movement per frame: {warm_move:.1f} px warm-started, {cold_move:.1f} px without")


# --8<-- [start:border]
def in_view(box):
    return box.x < W and box.y < H and box.x1 > 0 and box.y1 > 0


def pan(solve, reach):
    """A pan to the right in 8 steps of 6 px: how often a label in view changes its place
    beside its point, and how often it goes while its place is still in view."""
    prev, moved, gone, seen = None, 0, 0, 0
    for step in range(9):
        cx = 240 + 6 * step
        pos = view(1.6, cx, 170, reach)
        res = solve(pos, cx, prev and prev[1])
        if prev:
            old_pos, old = prev
            now = {q.id: q for q in res.placements}
            for p in old.placed:
                if p.id not in pos or not in_view(p.box):
                    continue
                seen += 1
                q = now.get(p.id)
                if q is None or not q.placed:
                    gone += 1
                elif math.dist((p.box.cx - old_pos[p.id][0], p.box.cy - old_pos[p.id][1]),
                               (q.box.cx - pos[p.id][0], q.box.cy - pos[p.id][1])) > 1e-6:
                    moved += 1
        prev = (pos, res)
    return moved, gone, seen


def contained(pos, cx, warm):            # every label inside the view, only the cities in it
    ids = [i for i in pos if 0 <= pos[i][0] <= W and 0 <= pos[i][1] <= H]
    return la.place([pos[i] for i in ids], ids, ids=ids, canvas=(W, H), font_size=14,
                    priority=[pop[i] for i in ids], models=["adjacent", "slider"], warm_start=warm)


pinned = pan(lambda pos, cx, warm: label(pos, 1.6, cx, 170, warm, pin=True), 3 * OVERSCAN)
window = pan(lambda pos, cx, warm: label(pos, 1.6, cx, 170, warm), 3 * OVERSCAN)
inside = pan(contained, 3 * OVERSCAN)
for name, (moved, gone, seen) in (("pinned", pinned), ("window", window), ("contained", inside)):
    print(f"{name}: of {seen} labels in view, {moved} moved and {gone} went")
# --8<-- [end:border]

assert warm_move < cold_move, (warm_move, cold_move)
assert all(r.stats["hard_violations"] == 0 for _, r in frames)
assert all("flicker" in r.stats for _, r in frames[1:])
assert nested >= len(frames) - 3, nested
# every frame but the first is pinned; after a pan no label moved, after a zoom few
assert [r.stats.get("pinned") is not None for _, r in frames] == [False, True, True, True, True, True]
assert all(r.stats["flicker"]["moved"] == 0 for _, r in (frames[1], frames[4]))
assert sum(r.stats["flicker"]["moved"] for _, r in frames[1:]) <= 3
# while the view only pans, no label moves and none goes; kept inside the view, some do
assert pinned[:2] == (0, 0) and pinned[2] > 50, pinned
assert sum(inside[:2]) > sum(window[:2]) >= 0, (window, inside)
# and the labels of a window cross the edges of the view
assert any(in_view(p.box) and (p.box.x < 0 or p.box.y < 0 or p.box.x1 > W or p.box.y1 > H)
           for _, r in frames for p in r.placed)
print("ok")
