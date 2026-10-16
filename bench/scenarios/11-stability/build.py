"""Build scenario 11: interactive stability — a 30-frame pan/zoom sequence over scenario 05.

Frames 0–19 zoom geometrically from the world view (zoom 1, 3.33 px/degree) to
zoom 8 while the center moves from (0°E, 20°N) to (10°E, 50°N); frames 20–29
pan east at zoom 8 to (28°E, 48°N). Every frame is an independent problem
(1200 × 600 px, equirectangular) containing the airports of the chosen set that
are visible in the frame; item ids are stable across frames.

``sequence.json`` lists the frames in order with their step kind (``start``,
``zoom_in``, ``pan``). The runner solves consecutive frames with ``warm_start``
= the previous frame's result, each previous box shifted by its anchor's
movement (so the warm start keeps the label's position relative to its anchor).

Sequences: ``zoom-pan-1000`` (quick; top 1000 airports), ``zoom-pan-3000`` (top 3000).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.geo import Equirect  # noqa: E402
from bench.common.jsonio import write_json  # noqa: E402
from bench.common.scenario import Writer, base_problem  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

A = load_module("05", "airports")
B = load_module("05", "build")
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


def main() -> None:
    aps = [a for a in A.load_airports() if A.WORLD.lat1 <= a.lat <= A.WORLD.lat0]
    ids = B.unique_ids(aps)
    wr = Writer(SCENARIO, "Interactive stability (pan/zoom sequence)", A.SOURCES,
                notes="30 frames per sequence; consecutive frames are solved with warm_start by the runner.")
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
    wr.extra["sequences"] = seqs
    # frame configs belong to sequences: keep them out of the per-config quick/full lists
    for c in wr.configs:
        c["sequence_frame"] = True
    wr.finish()


if __name__ == "__main__":
    main()
