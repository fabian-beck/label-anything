"""Interactive maps and stability (docs/tutorials/interactive-maps.md): re-label a map
after every pan and zoom, warm-started from the previous frame, as a window on the map
whose labels are cut at the border of the view, and measure how much the labels move."""

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
def view(zoom, cx, cy, overscan=OVERSCAN):
    """Screen positions of the cities in the view of a camera at (cx, cy) and a little beyond it."""
    pos = {}
    for key, (x, y) in world.items():
        sx, sy = (x - cx) * zoom + W / 2, (y - cy) * zoom + H / 2
        if -overscan <= sx <= W + overscan and -overscan <= sy <= H + overscan:
            pos[key] = (sx, sy)
    return pos


def label(pos, zoom, cx, cy, warm=None):
    ids = list(pos)                      # stable ids and the same priority in every frame
    # the view is a window on the map: labels may cross its edges, where they are cut, and
    # stay on the map, whose bounds in the view are the region
    region = (W / 2 - cx * zoom, H / 2 - cy * zoom, W * zoom, H * zoom)
    return la.place([pos[i] for i in ids], ids, ids=ids, canvas=(W, H), overscan=OVERSCAN, region=region,
                    font_size=14, priority=[pop[i] for i in ids], models=["adjacent", "slider"], warm_start=warm)


camera = [(1.0, 240, 160), (1.0, 252, 166), (1.3, 255, 168), (1.7, 258, 170), (2.2, 262, 172)]
frames, prev = [], None
for zoom, cx, cy in camera:
    pos = view(zoom, cx, cy)
    res = label(pos, zoom, cx, cy, prev)  # the previous result: its boxes move with their points
    flicker = res.stats.get("flicker")   # labels moved, added, removed since the previous frame
    print(f"zoom {zoom}: {res}", flicker and {k: round(v, 1) for k, v in flicker.items()})
    frames.append((pos, res))
    prev = res
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
    cold.append((pos, label(pos, zoom, cx, cy)))
warm_move, cold_move = movement(frames), movement(cold)
print(f"mean label movement per frame: {warm_move:.1f} px warm-started, {cold_move:.1f} px without")


# --8<-- [start:border]
def in_view(box):
    return box.x < W and box.y < H and box.x1 > 0 and box.y1 > 0


def at_border(box, zone=40):
    return in_view(box) and (box.x < zone or box.y < zone or box.x1 > W - zone or box.y1 > H - zone)


def border_moves(solve, overscan):
    """A pan to the right in 8 steps of 6 px: how often a label at the border of the view
    changes its place beside its point, and how often it goes while still in view."""
    prev, moved, gone, seen = None, 0, 0, 0
    for step in range(9):
        cx = 240 + 6 * step
        pos = view(1.6, cx, 170, overscan)
        res = solve(pos, cx, prev and prev[1])
        if prev:
            old_pos, old = prev
            for p in old.placed:
                if p.id not in old_pos or not at_border(p.box):
                    continue
                seen += 1
                q = res[p.id] if p.id in pos else None
                if q is None or not q.placed:
                    gone += 1
                elif math.dist((p.box.cx - old_pos[p.id][0], p.box.cy - old_pos[p.id][1]),
                               (q.box.cx - pos[p.id][0], q.box.cy - pos[p.id][1])) > 1:
                    moved += 1
        prev = (pos, res)
    return moved, gone, seen


def contained(pos, cx, warm):            # every label inside the view, only the cities in it
    ids = list(pos)
    return la.place([pos[i] for i in ids], ids, ids=ids, canvas=(W, H), font_size=14,
                    priority=[pop[i] for i in ids], models=["adjacent", "slider"], warm_start=warm)


window = border_moves(lambda pos, cx, warm: label(pos, 1.6, cx, 170, warm), OVERSCAN)
inside = border_moves(contained, 0)
print("labels at the border, moved / gone / seen: window %d / %d / %d, contained %d / %d / %d" % (*window, *inside))
# --8<-- [end:border]

assert warm_move < cold_move, (warm_move, cold_move)
assert all(r.stats["hard_violations"] == 0 for _, r in frames)
assert all("flicker" in r.stats for _, r in frames[1:])
assert nested >= len(frames) - 3, nested
# a window keeps the labels at the border where they are
assert window[0] + window[1] < inside[0] + inside[1], (window, inside)
assert window[1] == 0, window
# and its labels cross the edges of the view
assert any(in_view(p.box) and (p.box.x < 0 or p.box.y < 0 or p.box.x1 > W or p.box.y1 > H)
           for _, r in frames for p in r.placed)
print("ok")
