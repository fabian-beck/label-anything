"""Deterministic generator of the performance-target problems (brief §5.8).

* ``scatter-200``  — 800×600, 200 labels, 10,000 obstacle points,
* ``scatter-2000`` — 1920×1080, 2,000 labels, 100,000 obstacle points,
* ``raster-2048``  — 2048×2048 synthetic raster background (ink mode, raw RGBA)
  with 200 labels; its target is the engine's ``phases_ms.prepare``.

Scatter problems: preset ``scatter``, ``solver.strategy = "greedy"``; items
``{"id": "i<k>", "anchor": {"type": "point", "x", "y"}, "label": {"type": "text",
"text": "Label <k>"}}`` with anchors uniform in [10, w − 10] × [10, h − 10]; one
vector layer ``{"class": "points", "points": [...], "r": 1.5}`` with points
uniform in the same range. Random numbers come from SplitMix64 (seed per
problem), coordinates are rounded to 0.01 px, so every implementation can
regenerate byte-identical files (``python -m bench.perf generate DIR``).

The raster is drawn without randomness: white paper, a 64-px grid of 2-px dark
lines, a rotated 3-px stripe pattern in one quadrant, filled discs on a 256-px
lattice and a soft grey gradient band (the ink threshold keeps its dark half).
It is passed as raw RGBA (``obstacles.raster.rgba``) so that no image codec is
part of the measured preparation (base64 decoding still is).
"""
from __future__ import annotations

import argparse
import base64
import math
from pathlib import Path

import numpy as np

from ..common.jsonio import write_json

MASK64 = (1 << 64) - 1


class SplitMix64:
    """SplitMix64 (Steele, Lea & Flood 2014); ``uniform()`` gives 53-bit doubles in [0, 1)."""

    def __init__(self, seed: int):
        self.state = seed & MASK64

    def next(self) -> int:
        self.state = (self.state + 0x9E3779B97F4A7C15) & MASK64
        z = self.state
        z = ((z ^ (z >> 30)) * 0xBF58476D1CE4E5B9) & MASK64
        z = ((z ^ (z >> 27)) * 0x94D049BB133111EB) & MASK64
        return z ^ (z >> 31)

    def uniform(self) -> float:
        return (self.next() >> 11) * (1.0 / (1 << 53))


def _coords(rng: SplitMix64, n: int, w: float, h: float, margin: float = 10.0) -> list[list[float]]:
    out = []
    for _ in range(n):
        x = margin + rng.uniform() * (w - 2 * margin)
        y = margin + rng.uniform() * (h - 2 * margin)
        out.append([round(x, 2), round(y, 2)])
    return out


def _items(pts: list[list[float]]) -> list[dict]:
    return [{"id": f"i{k}", "anchor": {"type": "point", "x": x, "y": y},
             "label": {"type": "text", "text": f"Label {k}"}} for k, (x, y) in enumerate(pts)]


def scatter_problem(n_labels: int, n_points: int, width: int, height: int, seed: int) -> dict:
    rng = SplitMix64(seed)
    anchors = _coords(rng, n_labels, width, height)
    points = _coords(rng, n_points, width, height)
    return {"version": "1", "canvas": {"width": width, "height": height}, "preset": "scatter",
            "solver": {"strategy": "greedy"}, "items": _items(anchors),
            "obstacles": {"vector": [{"class": "points", "points": points, "r": 1.5}]}}


def synthetic_rgba(size: int) -> np.ndarray:
    """Deterministic RGBA8 test image (size × size × 4)."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float64)
    v = np.full((size, size), 250.0)
    v = np.where((x % 64 < 2) | (y % 64 < 2), 40.0, v)                         # grid lines
    q = (x < size / 2) & (y < size / 2)
    stripes = ((x * math.cos(0.5) + y * math.sin(0.5)) % 24.0) < 3.0
    v = np.where(q & stripes, 30.0, v)                                         # rotated stripes
    cx = (np.floor(x / 256.0) + 0.5) * 256.0
    cy = (np.floor(y / 256.0) + 0.5) * 256.0
    v = np.where((x - cx) ** 2 + (y - cy) ** 2 < 40.0 ** 2, 60.0, v)          # discs
    band = (y > size * 0.7) & (y < size * 0.8)
    v = np.where(band, np.minimum(v, 255.0 * (x / size)), v)                   # gradient band
    g = np.clip(np.rint(v), 0, 255).astype(np.uint8)
    rgba = np.empty((size, size, 4), dtype=np.uint8)
    rgba[..., 0] = g
    rgba[..., 1] = g
    rgba[..., 2] = np.clip(g.astype(np.int16) + 5, 0, 255).astype(np.uint8)
    rgba[..., 3] = 255
    return rgba


def raster_problem(size: int, n_labels: int, seed: int) -> dict:
    rng = SplitMix64(seed)
    anchors = _coords(rng, n_labels, size, size)
    rgba = synthetic_rgba(size)
    return {"version": "1", "canvas": {"width": size, "height": size}, "preset": "scatter",
            "solver": {"strategy": "greedy"}, "items": _items(anchors),
            "obstacles": {"raster": {"rgba": {"width": size, "height": size,
                                              "data": base64.b64encode(rgba.tobytes()).decode("ascii")},
                                     "mode": "ink", "class": "ink"}}}


def problems() -> dict[str, dict]:
    """All performance problems by name (seeds fixed)."""
    return {
        "scatter-200": scatter_problem(200, 10_000, 800, 600, seed=58_200),
        "scatter-2000": scatter_problem(2_000, 100_000, 1920, 1080, seed=58_2000),
        "raster-2048": raster_problem(2048, 200, seed=58_2048),
    }


def write_all(out_dir: str | Path) -> dict[str, Path]:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    paths = {}
    for name, prob in problems().items():
        paths[name] = write_json(out / f"{name}.json", prob, nd=2)
    return paths


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", nargs="?", default="bench/out/perf")
    a = ap.parse_args(argv)
    for name, p in write_all(a.out).items():
        print(f"{name}: {p} ({p.stat().st_size / 1e6:.1f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
