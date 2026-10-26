"""Build scenario 11: interactive stability — frame sequences of maps and graphs.

Pan/zoom over scenario 05's airports: frames 0–19 zoom geometrically from the world view
(zoom 1, 3.33 px/degree) to zoom 8 while the center moves from (0°E, 20°N) to
(10°E, 50°N); frames 20–29 pan east at zoom 8 to (28°E, 48°N). Every frame is an
independent problem (1200 × 600 px, equirectangular) containing the airports of the
chosen set that are visible in the frame.

Force layout of scenario 07's Les Misérables graph (77 nodes, 254 edges) under a
d3-force-style simulation (``bench.common.forcesim``): every 4th of the first 240 ticks
from the start (layout running), and a node dragged along an arc (40 ticks of the settled
layout reheated to alpha 0.3, Valjean moved 240 px). Every frame is an independent
problem (1000 × 760 px, preset ``graph``, 10 px names written out as in scenario 07's
``lesmis-force``, nodes in the colors of their communities, priority = degree, edges as soft
``lines``).

Item ids are stable across frames. ``sequence.json`` lists the frames in order with their
step kind (``start``, ``zoom_in``, ``pan``, ``tick``, ``drag``). The runner solves
consecutive frames with ``warm_start`` = the previous frame's result, each previous box
shifted by its anchor's movement (so the warm start keeps the label's position relative
to its anchor).

Sequences: ``zoom-pan-1000`` (quick; top 1000 airports), ``zoom-pan-3000`` (top 3000),
``force-lesmis`` (quick; 61 frames), ``drag-lesmis`` (quick; 41 frames).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.forcesim import Simulation  # noqa: E402
from bench.common.geo import Equirect  # noqa: E402
from bench.common.jsonio import write_json  # noqa: E402
from bench.common.scenario import Writer, base_problem  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

A = load_module("05", "airports")
B = load_module("05", "build")
G07 = load_module("07", "build")
SCENARIO = "11-stability"
W, H = 1200.0, 600.0
BASE = W / 360.0  # px per degree at zoom 1


def views() -> list[tuple[str, float, float, float]]:
    out = []
    for t in range(20):
        f = t / 19
        z = 8.0 ** f
        lon = 0.0 + 10.0 * f
        lat = 20.0 + 30.0 * f
        out.append(("start" if t == 0 else "zoom_in", lon, lat, z))
    for t in range(1, 11):
        f = t / 10
        out.append(("pan", 10.0 + 18.0 * f, 50.0 - 2.0 * f, 8.0))
    return out


def projection(lon: float, lat: float, zoom: float) -> Equirect:
    ppd = BASE * zoom
    hw, hh = W / 2 / ppd, H / 2 / ppd
    return Equirect(lon - hw, lon + hw, lat + hh, lat - hh, W, H)


GW, GH, GSCALE = 1000.0, 760.0, 1.35  # graph canvas; simulation units -> px


def graph_problem(G, nodes, xy) -> dict:
    """One frame of the force layout: simulation positions around the canvas center."""
    pos = {n: (round(GW / 2 + GSCALE * float(xy[k][0]), 3), round(GH / 2 + GSCALE * float(xy[k][1]), 3))
           for k, n in enumerate(nodes)}
    items = []
    for n in nodes:
        deg = G.degree(n)
        x, y = pos[n]
        grp = G.nodes[n]["group"]
        items.append({"id": G.nodes[n]["name"],
                      "anchor": {"type": "point", "x": x, "y": y,
                                 "mark": {"shape": "circle", "r": round(3 + 1.5 * math.sqrt(deg), 3)}},
                      "label": {"type": "text", "text": G07.display_name(G.nodes[n]["name"])},
                      "attrs": {"degree": deg, "color": G07.GROUP_COLORS[grp % len(G07.GROUP_COLORS)]}})
    p = base_problem(GW, GH, "graph", font_size=10.0)
    p["items"] = items
    p["obstacles"] = {"vector": [G07.edge_layer(G, pos)]}
    p["priority"] = {"terms": [{"attr": "degree"}]}
    return p


def graph_sequences(wr: Writer) -> list[dict]:
    """``force-lesmis`` (the layout running from the start) and ``drag-lesmis``."""
    G, _ = G07.lesmis()
    nodes = sorted(G.nodes())
    idx = {n: k for k, n in enumerate(nodes)}
    sim = Simulation(len(nodes), [(idx[a], idx[b]) for a, b in sorted(G.edges())])
    out = []

    def write(name: str, frames: list[dict], what: str) -> None:
        man = {"name": name, "frames": frames, "warm_start": True,
               "warm_start_mapping": "previous result, each box shifted by its anchor's displacement",
               "metrics": "python -m bench.eval sequence <sequence.json> --results <dir>"}
        write_json(wr.dir / name / "sequence.json", man, indent=1)
        out.append({"name": name, "manifest": f"{name}/sequence.json", "quick": True, "frames": len(frames),
                    "what": what})

    frames = []
    for t in range(241):
        if t % 4 == 0:
            fname = f"f{t // 4:03d}"
            wr.config(fname, graph_problem(G, nodes, sim.x), sub="force-lesmis", quick=False,
                      description=f"force-lesmis frame {t // 4}: tick {t}")
            frames.append({"file": f"{fname}.json", "step": "start" if t == 0 else "tick", "tick": t,
                           "n_items": len(nodes)})
        sim.tick()
    write("force-lesmis", frames, "Les Misérables force layout from the start, every 4th tick")
    # drag: the settled layout (300 ticks) reheated, Valjean moved along a half circle
    for _ in range(60):
        sim.tick()
    v = idx[next(n for n in nodes if G.nodes[n]["name"] == "Valjean")]
    x0, y0 = (float(c) for c in sim.x[v])
    sim.alpha_target = 0.3
    frames = []
    for t in range(41):
        ang = math.pi * t / 40
        sim.fixed = {v: (x0 + 120 * (1 - math.cos(ang)), y0 - 120 * math.sin(ang))}
        sim.tick()
        fname = f"f{t:03d}"
        wr.config(fname, graph_problem(G, nodes, sim.x), sub="drag-lesmis", quick=False,
                  description=f"drag-lesmis frame {t}: Valjean dragged, tick {t}")
        frames.append({"file": f"{fname}.json", "step": "start" if t == 0 else "drag", "tick": t,
                       "n_items": len(nodes)})
    write("drag-lesmis", frames, "Les Misérables, one node dragged through the settled layout")
    return out


def main() -> None:
    aps = [a for a in A.load_airports() if A.WORLD.lat1 <= a.lat <= A.WORLD.lat0]
    ids = B.unique_ids(aps)
    wr = Writer(SCENARIO, "Temporal stability (zoom and pan, force layout)", A.SOURCES + G07.SOURCES[:1],
                notes="Frame sequences; consecutive frames are solved with warm_start by the runner.")
    seqs = []
    for n, quick in ((1000, True), (3000, False)):
        name = f"zoom-pan-{n}"
        frames = []
        for t, (step, lon, lat, z) in enumerate(views()):
            proj = projection(lon, lat, z)
            vis = [a for a in aps[:n] if 4 <= proj(a.lon, a.lat)[0] <= W - 4 and 4 <= proj(a.lon, a.lat)[1] <= H - 4]
            p = base_problem(W, H, "map", font_size=10.0)
            p["items"] = B.items_for(vis, proj, lambda a: a.code, ids)
            p["priority"] = dict(B.PRIORITY)
            fname = f"f{t:03d}"
            wr.config(fname, p, sub=name, quick=False,
                      description=f"{name} frame {t}: {step}, center ({lon:.2f}, {lat:.2f}), zoom {z:.3f}")
            frames.append({"file": f"{fname}.json", "step": step,
                           "view": {"lon": round(lon, 4), "lat": round(lat, 4), "zoom": round(z, 5)},
                           "n_items": len(vis)})
        man = {"name": name, "frames": frames, "warm_start": True,
               "warm_start_mapping": "previous result, each box shifted by its anchor's displacement",
               "metrics": "python -m bench.eval sequence <sequence.json> --results <dir>"}
        write_json(wr.dir / name / "sequence.json", man, indent=1)
        seqs.append({"name": name, "manifest": f"{name}/sequence.json", "quick": quick, "frames": len(frames),
                     "airports": n})
    seqs += graph_sequences(wr)
    wr.extra["sequences"] = seqs
    # frame configs belong to sequences: keep them out of the per-config quick/full lists
    for c in wr.configs:
        c["sequence_frame"] = True
    wr.finish()


if __name__ == "__main__":
    main()
