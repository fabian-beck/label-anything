"""Build scenario 07: node-link diagrams.

Layouts are deterministic force layouts (networkx ``forceatlas2_layout`` with strong
gravity, fixed seed), rotated so their principal axis is horizontal, scaled into the
canvas and freed of node overlaps. Edges are straight center-to-center segments given as
``obstacles.vector`` polylines of class ``lines`` (soft, preset ``graph``); leaders use
the preset's octilinear ``angles`` style.

Configs:
* ``lesmis-circles`` (quick)  Les Misérables co-occurrence (77 nodes, 254 edges), circular nodes,
                              radius 3 + 1.5·sqrt(degree), every character labeled,
* ``lesmis-shapes``           same layout, UML/ER-like nodes: rounded rects (corner radius 4) sized to
                              hold the name for degree ≥ 8, ellipses for the others,
* ``cora-circles``            Cora citation network, largest connected component (2,485 papers,
                              5,069 links), 150 most cited papers labeled with their paper ids (alternative: last 4 digits), other papers are hard
                              ``nodes`` obstacles.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import networkx as nx
import numpy as np
from scipy.spatial import cKDTree

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch, text  # noqa: E402
from bench.common.scenario import Writer, base_problem, merge_avoid  # noqa: E402

SCENARIO = "07-node-link"
SOURCES = ["vega-datasets-3.2.1", "cora-cites", "cora-content"]
TOPICS = {"Case_Based": "Case-based reasoning", "Genetic_Algorithms": "Genetic algorithms",
          "Neural_Networks": "Neural networks", "Probabilistic_Methods": "Probabilistic methods",
          "Reinforcement_Learning": "Reinforcement learning", "Rule_Learning": "Rule learning",
          "Theory": "Theory"}


def fit(pos: dict, w: float, h: float, margin: float) -> dict:
    xs = [p[0] for p in pos.values()]
    ys = [p[1] for p in pos.values()]
    sx = (w - 2 * margin) / (max(xs) - min(xs))
    sy = (h - 2 * margin) / (max(ys) - min(ys))
    s = min(sx, sy)
    ox = (w - s * (max(xs) - min(xs))) / 2
    oy = (h - s * (max(ys) - min(ys))) / 2
    return {n: (round(ox + s * (p[0] - min(xs)), 3), round(oy + s * (p[1] - min(ys)), 3)) for n, p in pos.items()}


def orient(pos: dict) -> dict:
    """Rotate a layout about its centroid so that its principal axis is horizontal."""
    keys = sorted(pos, key=str)
    xy = np.array([pos[k] for k in keys], dtype=np.float64)
    xy -= xy.mean(axis=0)
    c = np.cov(xy.T)
    a = -0.5 * math.atan2(2 * c[0, 1], c[0, 0] - c[1, 1])
    co, si = math.cos(a), math.sin(a)
    return {k: (co * x - si * y, si * x + co * y) for k, (x, y) in zip(keys, xy.tolist())}


def separate(pos: dict, half: dict, w: float, h: float, margin: float, gap: float = 2.0,
             rounds: int = 500) -> dict:
    """Push overlapping node boxes (half extents ``half``, canvas px) apart until ``gap`` px
    separate them: each overlapping pair moves apart by half the overlap each along the axis
    of the smaller overlap, all pairs at once, staying inside the canvas margin."""
    keys = sorted(pos, key=str)
    xy = np.array([pos[k] for k in keys], dtype=np.float64)
    hw = np.array([half[k] for k in keys], dtype=np.float64) + gap / 2
    reach = float(np.hypot(*(2 * hw.max(axis=0))))
    for _ in range(rounds):
        pairs = cKDTree(xy).query_pairs(reach, output_type="ndarray")
        if len(pairs) == 0:
            break
        pairs = pairs[np.lexsort((pairs[:, 1], pairs[:, 0]))]
        i, j = pairs[:, 0], pairs[:, 1]
        d = xy[j] - xy[i]
        ox = hw[i, 0] + hw[j, 0] - np.abs(d[:, 0])
        oy = hw[i, 1] + hw[j, 1] - np.abs(d[:, 1])
        hit = (ox > 1e-9) & (oy > 1e-9)
        if not hit.any():
            break
        i, j, d, ox, oy = i[hit], j[hit], d[hit], ox[hit], oy[hit]
        along_x = ox <= oy
        delta = np.zeros((len(i), 2))
        delta[along_x, 0] = np.where(d[along_x, 0] >= 0, 0.5, -0.5) * ox[along_x]
        delta[~along_x, 1] = np.where(d[~along_x, 1] >= 0, 0.5, -0.5) * oy[~along_x]
        move = np.zeros_like(xy)
        np.add.at(move, i, -delta)
        np.add.at(move, j, delta)
        xy += move
        xy[:, 0] = np.clip(xy[:, 0], margin, w - margin)
        xy[:, 1] = np.clip(xy[:, 1], margin, h - margin)
    return {k: (round(x, 3), round(y, 3)) for k, (x, y) in zip(keys, xy.tolist())}


def floats(pos: dict) -> dict:
    return {n: (float(p[0]), float(p[1])) for n, p in pos.items()}


def lesmis():
    tgz = fetch.ensure("vega-datasets-3.2.1", verbose=False)
    d = json.loads(fetch.read_tar_member(tgz, "package/data/miserables.json"))
    G = nx.Graph()
    for n in d["nodes"]:
        G.add_node(n["index"], name=n["name"], group=n["group"])
    for e in d["links"]:
        G.add_edge(e["source"], e["target"], weight=e["value"])
    # node sizes (layout units) make ForceAtlas2 keep the nodes apart; the overlap removal
    # then uses the larger node of the two configs (lesmis-shapes)
    size = {n: 3 + 1.5 * math.sqrt(G.degree(n)) for n in G}
    pos = nx.forceatlas2_layout(G, seed=7, max_iter=600, strong_gravity=True, gravity=0.05, node_size=size)
    pos = fit(orient(floats(pos)), 1000.0, 760.0, 60.0)
    f = text.font(400)
    half = {}
    for n in G:
        deg = G.degree(n)
        if deg >= 8:
            half[n] = ((f.width(G.nodes[n]["name"], 10.0) + 16) / 2, 12.0)
        else:
            rx = 5 + 1.5 * math.sqrt(deg)
            half[n] = (rx, max(0.65 * rx, 3 + 1.5 * math.sqrt(deg)))
    return G, separate(pos, half, 1000.0, 760.0, 60.0)


def cora():
    content = fetch.ensure("cora-content", verbose=False)
    cites = fetch.ensure("cora-cites", verbose=False)
    topic = {}
    with open(content, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            topic[parts[0]] = parts[-1]
    G = nx.Graph()
    citations: dict[str, int] = {}
    with open(cites, encoding="utf-8") as f:
        for line in f:
            cited, citing = line.split()
            if cited != citing:
                G.add_edge(cited, citing)
                citations[cited] = citations.get(cited, 0) + 1
    lcc = max(nx.connected_components(G), key=lambda c: (len(c), sorted(c)[0]))
    H = nx.Graph()
    H.add_nodes_from(sorted(lcc))
    H.add_edges_from(sorted((min(a, b), max(a, b)) for a, b in G.subgraph(lcc).edges()))
    pos = nx.forceatlas2_layout(H, seed=7, max_iter=300, strong_gravity=True, gravity=0.05)
    pos = fit(orient(floats(pos)), 1600.0, 1200.0, 30.0)
    half = {n: (1.5 + 0.8 * math.sqrt(H.degree(n)),) * 2 for n in H}
    return H, separate(pos, half, 1600.0, 1200.0, 30.0), topic, citations


def edge_layer(G, pos, width=0.8) -> dict:
    lines = [[list(pos[a]), list(pos[b])] for a, b in sorted(G.edges(), key=lambda e: (str(e[0]), str(e[1])))]
    return {"class": "lines", "polylines": lines, "width": width}


def main() -> None:
    wr = Writer(SCENARIO, "Node-link diagrams", SOURCES,
                notes="Deterministic networkx ForceAtlas2 layouts (strong gravity, seed 7), "
                      "nodes kept apart; edges as soft 'lines'.")
    G, pos = lesmis()
    items = []
    for n in sorted(G.nodes()):
        deg = G.degree(n)
        x, y = pos[n]
        items.append({"id": G.nodes[n]["name"],
                      "anchor": {"type": "point", "x": x, "y": y,
                                 "mark": {"shape": "circle", "r": round(3 + 1.5 * math.sqrt(deg), 3)}},
                      "label": {"type": "text", "text": G.nodes[n]["name"]},
                      "attrs": {"degree": deg, "group": G.nodes[n]["group"]}})
    p = base_problem(1000.0, 760.0, "graph", font_size=10.0)
    p["items"] = items
    p["obstacles"] = {"vector": [edge_layer(G, pos)]}
    p["priority"] = {"terms": [{"attr": "degree"}]}
    wr.config("lesmis-circles", p, quick=True,
              description="Les Misérables, 77 circular nodes (radius by degree), all labeled, octilinear leaders.")
    f = text.font(400)
    items = []
    for n in sorted(G.nodes()):
        deg = G.degree(n)
        x, y = pos[n]
        name = G.nodes[n]["name"]
        if deg >= 8:
            # label box = text + 2 × 0.15 em padding; + 0.2 em inner padding per side fits inside
            w = round(f.width(name, 10.0) + 16, 2)
            mark = {"shape": "rect", "w": w, "h": 24.0, "corner_radius": 4.0}
        else:
            rx = round(5 + 1.5 * math.sqrt(deg), 3)
            mark = {"shape": "ellipse", "rx": rx, "ry": round(0.65 * rx, 3)}
        items.append({"id": name, "anchor": {"type": "point", "x": x, "y": y, "mark": mark},
                      "label": {"type": "text", "text": name}, "attrs": {"degree": deg, "group": G.nodes[n]["group"]}})
    p = base_problem(1000.0, 760.0, "graph", font_size=10.0)
    p["items"] = items
    p["obstacles"] = {"vector": [edge_layer(G, pos)]}
    p["priority"] = {"terms": [{"attr": "degree"}]}
    wr.config("lesmis-shapes", p,
              description="Same layout with UML-like rounded rects (internal labels) and ER-like ellipses.")
    H, pos, topic, citations = cora()
    ranked = sorted(H.nodes(), key=lambda n: (-citations.get(n, 0), int(n)))
    labeled = set(ranked[:150])
    items = []
    others = []
    for n in sorted(H.nodes(), key=int):
        deg = H.degree(n)
        x, y = pos[n]
        r = round(1.5 + 0.8 * math.sqrt(deg), 3)
        if n in labeled:
            t = TOPICS.get(topic.get(n, ""), "Unknown")
            items.append({"id": n, "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": r}},
                          "label": {"type": "text", "text": n, "alternatives": [n[-4:]]},
                          "attrs": {"citations": citations.get(n, 0), "degree": deg, "topic": t}})
        else:
            others.append([x, y, r])
    p = base_problem(1600.0, 1200.0, "graph", font_size=9.0)
    p["items"] = items
    p["obstacles"] = {"vector": [edge_layer(H, pos, 0.6), {"class": "nodes", "circles": others}]}
    p["priority"] = {"terms": [{"attr": "citations", "transform": "log1p"}]}
    merge_avoid(p, {"nodes": "hard"}, {"nodes": 1.0})
    wr.config("cora-circles", p,
              description="Cora citation network (2,485 papers): 150 most cited labeled; other nodes are hard.")
    wr.finish()


if __name__ == "__main__":
    main()
