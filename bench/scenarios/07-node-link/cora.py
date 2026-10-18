"""Data access for scenario 07's Cora citation network (pygcn copy).

* the graph: the largest connected component of the citation links (2,485 papers,
  5,069 links), nodes and edges in sorted order; the topic and the citation count of
  every paper,
* its layout: networkx ``forceatlas2_layout`` (strong gravity, seed 7, 300 iterations),
  ≈ 2 minutes; cached in ``bench/data/cora/forceatlas2-layout.json`` for the graph and
  parameters it was computed with.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import networkx as nx

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch, paths  # noqa: E402

SOURCES = ["cora-cites", "cora-content"]
LAYOUT = {"seed": 7, "max_iter": 300, "strong_gravity": True, "gravity": 0.05}


def load() -> tuple[nx.Graph, dict[str, str], dict[str, int]]:
    """The largest connected component, the topic of every paper and its citation count."""
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
    return H, topic, citations


def layout(H: nx.Graph) -> dict[str, tuple[float, float]]:
    """ForceAtlas2 positions of ``H`` (layout units), from the cache when it holds this graph's."""
    key = hashlib.sha256(json.dumps([list(H.nodes()), list(H.edges()), LAYOUT]).encode()).hexdigest()
    cache = paths.data_dir("cora") / "forceatlas2-layout.json"
    if cache.exists():
        d = json.loads(cache.read_text(encoding="utf-8"))
        if d.get("key") == key:
            return {n: (x, y) for n, (x, y) in d["pos"].items()}
    pos = {n: (float(p[0]), float(p[1])) for n, p in nx.forceatlas2_layout(H, **LAYOUT).items()}
    # floats are written as repr, which reads back exactly
    cache.write_text(json.dumps({"key": key, "pos": pos}), encoding="utf-8")
    return pos
