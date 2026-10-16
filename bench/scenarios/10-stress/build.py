"""Build scenario 10: stress / scale (SYNTHETIC-FROM-REAL).

Scenario 05's airports at 10× density: every served airport plus 9 jittered
copies (Gaussian jitter, σ = 0.6° in longitude and latitude, seed 10). A fixed
random permutation (seed 10) of this pool gives nested problems of
200, 500, 1000, 2000, 5000, 10000 and 20000 items on the same 1800 × 710 world
canvas, so density grows with n (runtime curves). Labels are IATA codes; copies
carry the code of their original. No background, no obstacles besides the items.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.scenario import Writer, base_problem  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

A = load_module("05", "airports")
SCENARIO = "10-stress"
SIZES = [200, 500, 1000, 2000, 5000, 10000, 20000]
COPIES = 10
SIGMA = 0.6


def pool():
    aps = [a for a in A.load_airports() if A.WORLD.lat1 + 1 <= a.lat <= A.WORLD.lat0 - 1]
    rng = np.random.default_rng(10)
    out = []
    for a in aps:
        out.append((a, 0, a.lon, a.lat))
        jit = rng.normal(0.0, SIGMA, size=(COPIES - 1, 2))
        for k in range(1, COPIES):
            lon = float(np.clip(a.lon + jit[k - 1, 0], -179.5, 179.5))
            lat = float(np.clip(a.lat + jit[k - 1, 1], A.WORLD.lat1 + 0.5, A.WORLD.lat0 - 0.5))
            out.append((a, k, lon, lat))
    perm = np.random.default_rng(10).permutation(len(out))
    return [out[i] for i in perm]


def main() -> None:
    entries = pool()
    wr = Writer(SCENARIO, "Stress and scale (synthetic from real)", A.SOURCES,
                notes=f"SYNTHETIC: {len(entries)} = 10 x served airports (originals + 9 jittered copies, "
                      f"sigma {SIGMA} deg, seed 10); nested prefixes of a fixed permutation.")
    for n in SIZES:
        items = []
        for a, k, lon, lat in entries[:n]:
            x, y = A.WORLD(lon, lat)
            items.append({"id": f"{a.code}-{a.id}~{k}",
                          "anchor": {"type": "point", "x": round(x, 3), "y": round(y, 3),
                                     "mark": {"shape": "circle", "r": A.mark_radius(a.routes)}},
                          "label": {"type": "text", "text": a.code},
                          "attrs": {"routes": a.routes, "copy": k}})
        p = base_problem(A.WORLD.width, A.WORLD.height, "map", font_size=9.0)
        p["items"] = items
        p["priority"] = {"terms": [{"attr": "routes", "transform": "log1p", "normalize": "minmax"}]}
        wr.config(f"n{n:05d}", p, quick=(n == 200), synthetic=True,
                  description=f"{n} airport anchors (10x density pool), no background.")
    wr.finish()


if __name__ == "__main__":
    main()
