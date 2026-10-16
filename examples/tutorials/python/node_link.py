"""Node-link diagrams (docs/tutorials/node-link.md): nodes as items with their true shapes,
edges as obstacles, internal labels for large nodes, priority by degree."""

import math
from pathlib import Path

# --8<-- [start:graph]
import label_anything as la

nodes = {"core": (300, 190), "api": (170, 120), "db": (440, 100), "cache": (450, 260), "auth": (160, 275),
         "web": (60, 55), "mobile": (55, 185), "admin": (80, 350), "queue": (300, 330), "worker": (450, 350),
         "search": (570, 180), "index": (590, 50), "metrics": (585, 300), "logs": (300, 45)}
edges = [("core", "api"), ("core", "db"), ("core", "cache"), ("core", "auth"), ("core", "queue"), ("api", "web"),
         ("api", "mobile"), ("api", "auth"), ("auth", "admin"), ("queue", "worker"), ("worker", "db"),
         ("db", "search"), ("search", "index"), ("cache", "metrics"), ("worker", "metrics"), ("core", "logs"),
         ("api", "logs"), ("db", "logs")]
degree = {n: sum(n in e for e in edges) for n in nodes}
servers = {"db", "cache"}                                   # drawn as rounded rectangles


def mark(n):
    return la.Mark.rect(84, 34, corner_radius=6) if n in servers else la.Mark.circle(5 + 5 * degree[n])


def boundary(n, ux, uy):
    """Distance from the center of node n to its outline in direction (ux, uy)."""
    if n in servers:
        return min(42 / abs(ux) if ux else math.inf, 17 / abs(uy) if uy else math.inf)
    return 5 + 5 * degree[n]


def edge_line(a, b):
    """The drawn edge: from outline to outline, as a renderer draws it."""
    (ax, ay), (bx, by) = nodes[a], nodes[b]
    d = math.hypot(bx - ax, by - ay)
    ux, uy = (bx - ax) / d, (by - ay) / d
    sa, sb = boundary(a, ux, uy), boundary(b, -ux, -uy)
    return [(round(ax + ux * sa, 1), round(ay + uy * sa, 1)), (round(bx - ux * sb, 1), round(by - uy * sb, 1))]


res = la.place(
    anchors=list(nodes.values()), labels=list(nodes), ids=list(nodes), marks=[mark(n) for n in nodes],
    canvas=(640, 400), preset="graph",                     # internal labels for large nodes, edges = "lines"
    vector=[{"class": "lines", "width": 1.5, "polylines": [edge_line(a, b) for a, b in edges]}],
    priority=la.Priority.degree(),                         # incident edges: polyline ends on the mark
)
print({p.id: p.model for p in res.placements})
# --8<-- [end:graph]
same = la.place_problem(Path("../problems/graph.json"))
assert [(p.id, p.box) for p in same.placements] == [(p.id, p.box) for p in res.placements]
assert res["core"].model == "internal" and res["web"].model == "adjacent" and res.stats["placed"] == len(nodes)
assert res["core"].priority["rank"] == 0, res["core"].priority     # the hub is the most important node
print("ok")
