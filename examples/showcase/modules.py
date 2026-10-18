"""A diagram: the module graph of this repository's TypeScript packages.

Every module of the TypeScript packages (``ts/packages/*/src``, ``bindings/js-extras/src``)
is a node, sized by its lines of code and coloured by its package; every import is an edge
(as the playground's network scene reads them). The layout is Kamada–Kawai's (networkx,
deterministic), the edges are drawn as gentle curves. The problem labels every module, the
most imported first (the eight hubs set larger and bold): next to its node, or out on a
leader in the crowd; the edges are a soft obstacle (a label may cross one at a cost), the
nodes a hard one, and what does not fit is left out.
"""

from __future__ import annotations

import math
import re
from collections import Counter
from xml.sax.saxutils import escape

import networkx as nx

from common import FIGURES, HERE, ROOT, compose, f, report, solve, write_problem

NAME = "modules"
W, H = 960, 600
ROOTS = {
    "core": "ts/packages/core/src", "text": "ts/packages/text/src", "svg": "ts/packages/svg/src",
    "raster": "ts/packages/raster/src", "extras": "bindings/js-extras/src", "wasm": "ts/packages/wasm-adapter/src",
    "cli": "ts/packages/cli/src",
}
COLOURS = {"core": "#4e79a7", "text": "#f28e2b", "svg": "#59a14f", "raster": "#b07aa1", "extras": "#e15759",
           "wasm": "#76b7b2", "cli": "#9c755f"}
TEXT = "#1f2328"
IMPORT = re.compile(r'(?:from|import)\s+"([^"]+)"')


def graph() -> tuple[dict[str, dict], list[tuple[str, str]]]:
    nodes: dict[str, dict] = {}
    edges: list[tuple[str, str]] = []
    for pkg, root in ROOTS.items():
        base = ROOT / root
        files = sorted(p for p in base.rglob("*.ts") if not p.name.endswith(".d.ts")
                       and not {"generated", "conformance"} & set(p.relative_to(base).parts[:-1]))
        for file in files:
            rel = file.relative_to(base).with_suffix("").as_posix()
            node = f"{pkg}/{rel}"
            nodes[node] = {"id": node, "pkg": pkg, "path": rel, "lines": file.read_text(encoding="utf-8").count("\n") + 1}
            for target in IMPORT.findall(file.read_text(encoding="utf-8")):
                if target.startswith("."):
                    t = (file.parent / target).resolve()
                    if t.is_relative_to(base.resolve()):  # not the generated WebAssembly glue
                        edges.append((node, f"{pkg}/" + re.sub(r"\.js$", "", t.relative_to(base.resolve()).as_posix())))
                elif target.startswith("@label-anything/"):
                    name = target.split("/")[1]
                    if name in ROOTS:
                        edges.append((node, f"{name}/index"))
    edges = sorted({(a, b) for a, b in edges if a in nodes and b in nodes and a != b})
    return nodes, edges


def name(n: dict) -> str:
    """A module's name: its file, or its folder for an index (the package for the package's)."""
    parts = n["path"].split("/")
    if parts[-1] == "index":
        return n["pkg"] if len(parts) == 1 else parts[-2]
    return parts[-1]


def layout(nodes: dict[str, dict], edges: list[tuple[str, str]]) -> dict[str, tuple[float, float]]:
    g = nx.Graph()
    g.add_nodes_from(sorted(nodes))
    g.add_edges_from(edges)
    pos = nx.kamada_kawai_layout(g, scale=1.0)
    # a fisheye: the dense core of the graph spread out, its periphery drawn in
    cx = sum(p[0] for p in pos.values()) / len(pos)
    cy = sum(p[1] for p in pos.values()) / len(pos)
    for k, (x, y) in pos.items():
        r = math.hypot(x - cx, y - cy)
        pos[k] = (cx + (x - cx) * r ** -0.4, cy + (y - cy) * r ** -0.4) if r > 0 else (x, y)
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    mx, my = 60, 40
    sx = (W - 2 * mx - 130) / (max(xs) - min(xs))
    sy = (H - 2 * my) / (max(ys) - min(ys))
    return {k: (mx + 130 + (p[0] - min(xs)) * sx, my + (p[1] - min(ys)) * sy) for k, p in pos.items()}


def curve(a: tuple[float, float], b: tuple[float, float], n: int = 8) -> list[tuple[float, float]]:
    """A gentle arc from a to b (a quadratic Bézier, bent to the left by 12 % of its length)."""
    mx, my = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
    dx, dy = b[0] - a[0], b[1] - a[1]
    cx, cy = mx - dy * 0.12, my + dx * 0.12
    return [((1 - t) ** 2 * a[0] + 2 * (1 - t) * t * cx + t * t * b[0],
             (1 - t) ** 2 * a[1] + 2 * (1 - t) * t * cy + t * t * b[1]) for t in (i / n for i in range(n + 1))]


def radius(n: dict) -> float:
    return 2.5 + 0.11 * math.sqrt(n["lines"])


def diagram(nodes, edges, pos) -> tuple[str, list[list[tuple[float, float]]]]:
    curves = [curve(pos[a], pos[b]) for a, b in edges]
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         f'<rect id="background" width="{W}" height="{H}" fill="#ffffff"/>',
         '<g class="edges" fill="none" stroke="#8b939c" stroke-opacity="0.32" stroke-width="0.8">']
    for c in curves:
        o.append('<path d="M' + "L".join(f"{f(x)} {f(y)}" for x, y in c) + '"/>')
    o.append("</g>")
    o.append('<g class="nodes" stroke="#ffffff" stroke-width="1">')
    for k in sorted(nodes, key=lambda k: -nodes[k]["lines"]):
        x, y = pos[k]
        o.append(f'<circle cx="{f(x)}" cy="{f(y)}" r="{f(radius(nodes[k]))}" fill="{COLOURS[nodes[k]["pkg"]]}"/>')
    o.append("</g>")
    o.append(f'<g class="legend" font-size="11" fill="{TEXT}">')
    o.append('<text x="16" y="24" font-size="12" font-weight="700">Packages</text>')
    for i, (pkg, col) in enumerate(COLOURS.items()):
        o.append(f'<circle cx="22" cy="{42 + i * 17}" r="5" fill="{col}"/>')
        o.append(f'<text x="32" y="{46 + i * 17}">{escape(pkg)}</text>')
    o.append(f'<text x="16" y="{46 + len(COLOURS) * 17 + 6}" fill="#5f6670" font-size="10">Size: lines of code</text>')
    o.append(f'<text x="16" y="{46 + len(COLOURS) * 17 + 20}" fill="#5f6670" font-size="10">Lines: imports</text>')
    o.append("</g>")
    o.append("</svg>")
    return "\n".join(o) + "\n", curves


def problem(nodes, edges, pos, curves) -> dict:
    deg = Counter(b for _, b in edges)
    legend_h = 46 + len(COLOURS) * 17 + 26
    return {
        "version": "1",
        "canvas": {"width": W, "height": H, "padding": 4},
        "defaults": {"font": {"size": 11}},
        "obstacles": {"vector": [
            {"class": "edges", "polylines": [[[round(x, 1), round(y, 1)] for x, y in c] for c in curves], "width": 0.8},
            {"class": "legend", "rects": [[8, 8, 128, legend_h]]},
        ]},
        "items": [{
            "id": k,
            "anchor": {"type": "point", "x": round(pos[k][0], 1), "y": round(pos[k][1], 1),
                       "mark": {"shape": "circle", "r": round(radius(n), 2)}},
            "label": {"type": "text", "text": name(n)},
            # the most imported first
            "priority": deg[k] + n["lines"] / 1e5,
        } for k, n in sorted(nodes.items())],
        # a hub's leader may pass the node of a less imported module
        "avoid": {"label": {"edges": 0.4, "legend": "hard"},
                  "leader": {"edges": 0.1, "legend": "hard", "lower_items": 0.6}},
        "placement": {"models": ["adjacent", "slider", "distant"], "max_distance": "4em"},
        "leaders": {"style": "straight", "max_length": "6em"},
        "priority": {"font_classes": [{"first": 8, "scale": 1.2, "weight": "bold"}, {"scale": 0.95}]},
        "degrade": ["distant", "omit"],
        "solver": {"seed": 1},
    }


def make(cli: str) -> str:
    nodes, edges = graph()
    pos = layout(nodes, edges)
    picture, curves = diagram(nodes, edges, pos)
    (HERE / f"{NAME}-graph.svg").write_text(picture, encoding="utf-8")
    result = solve(cli, write_problem(NAME, problem(nodes, edges, pos, curves)))
    svg = compose(W, H, "The module graph of Label Anything's TypeScript packages, labeled by Label Anything",
                  picture.split(">", 1)[1].rsplit("</svg>", 1)[0], result,
                  style=".labels text{stroke:#ffffff;stroke-width:2.6px;stroke-linejoin:round;paint-order:stroke}",
                  leaders='fill="none" stroke="#5f6670" stroke-width="0.8"')
    (FIGURES / f"{NAME}.svg").write_text(svg, encoding="utf-8")
    return report(NAME, result)
