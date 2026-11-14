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
* ``lesmis-force``            the layout of scenario 11's force sequences at rest (d3-force style, 300
                              ticks), fitted to the canvas: circles r = 3 + 1.5·sqrt(degree) in the color
                              of the character's community (the dataset's ``group``, ``attrs.color``),
                              edges as wide as the characters' co-occurrences, readable names,
* ``flare-imports``           the Flare visualization toolkit (vega-datasets ``flare.json``,
                              ``flare-dependencies.json``): 220 classes and their 708 import pairs in the same
                              force layout (rotated, principal axis horizontal), circles by degree in the
                              color of the class's top-level package; the 100 most connected classes are
                              labeled with their names, the other 120 are hard ``nodes`` obstacles,
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
from bench.common.forcesim import Simulation  # noqa: E402
from bench.common.scenario import (FONT_CLASSES_SPARSE, Writer, base_problem, merge_avoid,  # noqa: E402
                                   png_bytes)
from bench.common.scene import Scene  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

C = load_module("07", "cora")
SCENARIO = "07-node-link"
SOURCES = ["vega-datasets-3.2.1"] + C.SOURCES
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


GROUP_COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7",
                "#9c755f", "#bab0ac", "#d37295"]
"""One color per community of the Les Misérables data (``group`` 0–10)."""
NAMES = {"MotherInnocent": "Mother Innocent", "CountessdeLo": "Countess de Lo", "Mme.deR": "Mme. de R.",
         "BaronessT": "Baroness T.", "MotherPlutarch": "Mother Plutarch", "OldMan": "Old Man",
         "Child1": "Child 1", "Child2": "Child 2", "Woman1": "Woman 1", "Woman2": "Woman 2"}


def display_name(name: str) -> str:
    """The character's name as a reader writes it (the data runs words together: ``Mme.Thenardier``)."""
    return NAMES.get(name, name.replace(".", ". "))


def lesmis_force(G, ticks: int = 300) -> dict:
    """The d3-force style layout of scenario 11 (``bench.common.forcesim``) after ``ticks`` ticks, fitted
    to the 1000 × 760 canvas with a 40 px margin."""
    nodes = sorted(G.nodes())
    idx = {n: k for k, n in enumerate(nodes)}
    sim = Simulation(len(nodes), [(idx[a], idx[b]) for a, b in sorted(G.edges())])
    for _ in range(ticks):
        sim.tick()
    return fit({n: (float(sim.x[idx[n]][0]), float(sim.x[idx[n]][1])) for n in nodes}, 1000.0, 760.0, 40.0)


def flare():
    """Flare's classes (leaves of ``flare.json``) and their imports; the top-level package of every class."""
    tgz = fetch.ensure("vega-datasets-3.2.1", verbose=False)
    nodes = json.loads(fetch.read_tar_member(tgz, "package/data/flare.json"))
    deps = json.loads(fetch.read_tar_member(tgz, "package/data/flare-dependencies.json"))
    by_id = {n["id"]: n for n in nodes}

    def package(n):
        while by_id[n["parent"]].get("parent") is not None and by_id[by_id[n["parent"]]["parent"]].get("parent"):
            n = by_id[n["parent"]]
        return by_id[n["parent"]]["name"] if by_id[n["parent"]].get("parent") else n["name"]

    G = nx.Graph()
    for n in sorted(nodes, key=lambda n: n["id"]):
        if "size" in n:
            G.add_node(n["id"], name=n["name"], package=package(n))
    for e in deps:
        if e["source"] in G and e["target"] in G and e["source"] != e["target"]:
            G.add_edge(e["source"], e["target"])
    return G


def cora():
    H, topic, citations = C.load()
    pos = fit(orient(C.layout(H)), 1600.0, 1200.0, 30.0)
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
    p["priority"] = {"terms": [{"attr": "degree"}], "font_classes": FONT_CLASSES_SPARSE}
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
              description="Same layout with UML-style rounded rectangles (internal labels) and ER-style ellipses.")
    # the force layout at rest: circles by degree, colored by community, edges by co-occurrence
    fpos = lesmis_force(G)
    sc = Scene(1000.0, 760.0, background="#ffffff")
    for a, b in sorted(G.edges()):
        w = round(0.5 + 0.25 * math.sqrt(G.edges[a, b]["weight"]), 1)
        sc.polyline([fpos[a], fpos[b]], "edge", "lines", stroke="#aab2bb", width=w, opacity=0.8)
    items = []
    for n in sorted(G.nodes()):
        deg = G.degree(n)
        x, y = fpos[n]
        grp = G.nodes[n]["group"]
        items.append({"id": G.nodes[n]["name"],
                      "anchor": {"type": "point", "x": x, "y": y,
                                 "mark": {"shape": "circle", "r": round(3 + 1.5 * math.sqrt(deg), 3)}},
                      "label": {"type": "text", "text": display_name(G.nodes[n]["name"])},
                      "attrs": {"degree": deg, "group": grp, "color": GROUP_COLORS[grp % len(GROUP_COLORS)]}})
    p = base_problem(1000.0, 760.0, "graph", font_size=10.0)
    p["items"] = items
    p["obstacles"] = {"vector": sc.vector_layers()}
    p["priority"] = {"terms": [{"attr": "degree"}], "font_classes": FONT_CLASSES_SPARSE}
    wr.config("lesmis-force", p, svg=sc.svg(), png=png_bytes(sc.png()),
              description="Les Misérables in its d3-force layout at rest: circles by degree, colored by community.")
    # Flare: a software dependency network in the same force layout
    F = flare()
    fnodes = sorted(F.nodes())
    fidx = {n: k for k, n in enumerate(fnodes)}
    sim = Simulation(len(fnodes), [(fidx[a], fidx[b]) for a, b in sorted(F.edges())], charge=-150.0)
    for _ in range(300):
        sim.tick()
    W, Hh = 1400.0, 1000.0
    fpos = fit(orient({n: (float(sim.x[fidx[n]][0]), float(sim.x[fidx[n]][1])) for n in fnodes}), W, Hh, 40.0)
    labeled = set(sorted(fnodes, key=lambda n: (-F.degree(n), F.nodes[n]["name"], n))[:100])
    packages = sorted({F.nodes[n]["package"] for n in F})
    pcolor = {pk: GROUP_COLORS[k % len(GROUP_COLORS)] for k, pk in enumerate(packages)}
    sc = Scene(W, Hh, background="#ffffff")
    for a, b in sorted(F.edges()):
        sc.polyline([fpos[a], fpos[b]], "edge", "lines", stroke="#b4bcc4", width=0.6, opacity=0.7)
    for k, pk in enumerate(packages):
        sc.rect(16, 18 + 15 * k - 8, 9, 9, "swatch", "legend", fill=pcolor[pk])
        sc.text(30, 18 + 15 * k, f"flare.{pk}", "legendtext", "text", size=10, fill="#333333")
    items = []
    for n in fnodes:
        deg = F.degree(n)
        x, y = fpos[n]
        pk = F.nodes[n]["package"]
        r = round(2 + 0.8 * math.sqrt(deg), 3)
        if n not in labeled:
            sc.circle(x, y, r, "node", "nodes", fill=pcolor[pk], opacity=0.75, stroke="#ffffff", stroke_width=0.6)
            continue
        items.append({"id": f"{pk}.{F.nodes[n]['name']}#{n}",
                      "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": r}},
                      "label": {"type": "text", "text": F.nodes[n]["name"]},
                      "attrs": {"degree": deg, "package": pk, "color": pcolor[pk]}})
    p = base_problem(W, Hh, "graph", font_size=9.0)
    p["items"] = items
    p["obstacles"] = {"vector": sc.vector_layers()}
    p["priority"] = {"terms": [{"attr": "degree"}], "font_classes": FONT_CLASSES_SPARSE}
    merge_avoid(p, {"legend": "hard", "nodes": "hard"}, {"legend": "hard", "nodes": 1.0})
    wr.config("flare-imports", p, svg=sc.svg(), png=png_bytes(sc.png()),
              description="Flare: 220 classes and their imports, force layout; the 100 most connected labeled.")
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
    p["priority"] = {"terms": [{"attr": "citations", "transform": "log1p"}], "font_classes": FONT_CLASSES_SPARSE}
    merge_avoid(p, {"nodes": "hard"}, {"nodes": 1.0})
    wr.config("cora-circles", p,
              description="Cora citation network (2,485 papers): the 150 most cited labeled; other nodes as hard "
                          "obstacles.")
    wr.finish()


if __name__ == "__main__":
    main()
