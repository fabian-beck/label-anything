"""Raster background modes of spec §4.6, at raster-pixel resolution, plus an exact
area integrator for axis-aligned boxes.

The evaluator uses the per-pixel definition of each mode (no grid averaging and
no ``ink.dilate``; those are engine-internal conservative approximations).
"""
from __future__ import annotations

import io
import math

import numpy as np
from PIL import Image

from . import model, spec


def decode_rgba(src: dict) -> np.ndarray:
    """RGBA8 array (H, W, 4) of a raster source (data URL / base64 / path / raw rgba)."""
    if "rgba" in src:
        import base64
        r = src["rgba"]
        buf = np.frombuffer(base64.b64decode(r["data"]), dtype=np.uint8)
        return buf.reshape(int(r["height"]), int(r["width"]), 4).copy()
    data = model.raster_bytes(src)
    with Image.open(io.BytesIO(data)) as im:
        return np.asarray(im.convert("RGBA"), dtype=np.uint8).copy()


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def oklab(rgb01: np.ndarray) -> np.ndarray:
    """sRGB in [0,1] (..., 3) -> OKLab (..., 3) (Björn Ottosson's matrices)."""
    lin = srgb_to_linear(rgb01)
    m1 = np.array([[0.4122214708, 0.5363325363, 0.0514459929],
                   [0.2119034982, 0.6806995451, 0.1073969566],
                   [0.0883024619, 0.2817188376, 0.6299787005]])
    m2 = np.array([[0.2104542553, 0.7936177850, -0.0040720468],
                   [1.9779984951, -2.4285922050, 0.4505937099],
                   [0.0259040371, 0.7827717662, -0.8086757660]])
    lms = lin @ m1.T
    lms = np.cbrt(lms)
    return lms @ m2.T


def parse_color(c: str) -> np.ndarray:
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return np.array([int(c[i:i + 2], 16) for i in (0, 2, 4)], dtype=np.float64)


def border_background(rgba: np.ndarray) -> np.ndarray:
    """Most frequent border colour, quantized to 5 bits per channel; ties -> lowest value."""
    h, w = rgba.shape[:2]
    border = np.concatenate([rgba[0, :, :3], rgba[h - 1, :, :3], rgba[:, 0, :3], rgba[:, w - 1, :3]])
    q = (border.astype(np.int64) >> 3)
    key = (q[:, 0] << 10) | (q[:, 1] << 5) | q[:, 2]
    vals, counts = np.unique(key, return_counts=True)  # vals ascending -> argmax picks the lowest on ties
    k = int(vals[int(np.argmax(counts))])
    qr, qg, qb = (k >> 10) & 31, (k >> 5) & 31, k & 31
    return np.array([(v << 3) | (v >> 2) for v in (qr, qg, qb)], dtype=np.float64)


def _composite(rgba: np.ndarray, bg: np.ndarray) -> np.ndarray:
    a = rgba[..., 3:4].astype(np.float64) / 255.0
    return rgba[..., :3].astype(np.float64) * a + bg[None, None, :] * (1.0 - a)


def luma(rgba: np.ndarray) -> np.ndarray:
    """Rec. 709 luma of the sRGB values composited over white, in [0,1]."""
    c = _composite(rgba, np.array([255.0, 255.0, 255.0])) / 255.0
    return 0.2126 * c[..., 0] + 0.7152 * c[..., 1] + 0.0722 * c[..., 2]


def ink_map(rgba: np.ndarray, background: str = "auto", threshold: float = 0.12) -> np.ndarray:
    bg = border_background(rgba) if background in (None, "auto") else parse_color(background)
    comp = _composite(rgba, bg) / 255.0
    d = oklab(comp) - oklab(bg[None, None, :] / 255.0)
    dist = np.sqrt((d * d).sum(axis=-1))
    return (dist > threshold).astype(np.float32)


def alpha_map(rgba: np.ndarray, threshold: float = 0.1) -> np.ndarray:
    return (rgba[..., 3].astype(np.float64) / 255.0 > threshold).astype(np.float32)


def cost_map(rgba: np.ndarray, invert: bool = False) -> np.ndarray:
    y = luma(rgba)
    return (y if invert else 1.0 - y).astype(np.float32)


def _box5(a: np.ndarray) -> np.ndarray:
    p = np.pad(a, 2, mode="edge")
    s = np.cumsum(np.cumsum(np.pad(p, ((1, 0), (1, 0))), axis=0), axis=1)
    h, w = a.shape
    return (s[5:5 + h, 5:5 + w] - s[0:h, 5:5 + w] - s[5:5 + h, 0:w] + s[0:h, 0:w]) / 25.0


def saliency_map(rgba: np.ndarray) -> np.ndarray:
    y = luma(rgba)
    p = np.pad(y, 1, mode="edge")
    gx = (p[:-2, 2:] + 2 * p[1:-1, 2:] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[1:-1, :-2] + p[2:, :-2])
    gy = (p[2:, :-2] + 2 * p[2:, 1:-1] + p[2:, 2:]) - (p[:-2, :-2] + 2 * p[:-2, 1:-1] + p[:-2, 2:])
    g = np.sqrt(gx * gx + gy * gy)
    c = np.abs(y - _box5(y))
    gm, cm = g.max(), c.max()
    g = g / gm if gm > 0 else g
    c = c / cm if cm > 0 else c
    return (0.5 * (g + c)).astype(np.float32)


def classmap_maps(rgba: np.ndarray, palette: dict[str, str], tolerance: float, unmatched: str,
                  background: str = "auto", threshold: float = 0.12) -> dict[str, np.ndarray]:
    bgmask = ink_map(rgba, background, threshold) < 0.5
    lab = oklab(rgba[..., :3].astype(np.float64) / 255.0)
    best = np.full(rgba.shape[:2], np.inf)
    best_idx = np.full(rgba.shape[:2], -1, dtype=np.int64)
    cols = list(palette.items())
    for k, (col, _cls) in enumerate(cols):
        d = lab - oklab(parse_color(col)[None, None, :] / 255.0)
        dist = np.sqrt((d * d).sum(axis=-1))
        better = (dist <= tolerance) & (dist < best)
        best = np.where(better, dist, best)
        best_idx = np.where(better, k, best_idx)
    out: dict[str, np.ndarray] = {}
    for k, (_col, cls) in enumerate(cols):
        if cls == "ignore":
            continue
        m = (best_idx == k) & ~bgmask
        out[cls] = np.maximum(out.get(cls, 0), m.astype(np.float32))
    if unmatched == "ink":
        m = (best_idx < 0) & ~bgmask
        out["ink"] = np.maximum(out.get("ink", np.zeros(m.shape, np.float32)), m.astype(np.float32))
    return out


def source_maps(src: dict) -> dict[str, np.ndarray]:
    """Per-class value maps (raster px, values in [0,1]) of one raster source."""
    rgba = decode_rgba(src)
    mode = src.get("mode", spec.element_default("obstacles.raster.mode"))
    cls = src.get("class", spec.element_default("obstacles.raster.class"))
    ink = src.get("ink", {}) or {}
    bg = ink.get("background", spec.element_default("obstacles.raster.ink.background"))
    thr = float(ink.get("threshold", spec.element_default("obstacles.raster.ink.threshold")))
    if mode == "ink":
        return {cls: ink_map(rgba, bg, thr)}
    if mode == "alpha":
        t = float((src.get("alpha") or {}).get("threshold", spec.element_default("obstacles.raster.alpha.threshold")))
        return {cls: alpha_map(rgba, t)}
    if mode == "cost":
        inv = bool((src.get("cost") or {}).get("invert", spec.element_default("obstacles.raster.cost.invert")))
        return {cls: cost_map(rgba, inv)}
    if mode == "saliency":
        return {cls: saliency_map(rgba)}
    if mode == "classmap":
        tol = float(src.get("classmap_tolerance", spec.element_default("obstacles.raster.classmap_tolerance")))
        unm = src.get("unmatched", spec.element_default("obstacles.raster.unmatched"))
        return classmap_maps(rgba, src.get("classmap", {}), tol, unm, bg, thr)
    raise ValueError(f"unknown raster mode {mode!r}")


class Integrator:
    """Exact integral of a piecewise-constant grid over axis-aligned boxes.

    ``cell`` is the size of one grid cell in canvas px, ``origin`` the canvas
    position of the grid's top-left corner. The cumulative integral is bilinear
    inside each cell, so fractional box edges are exact.
    """

    def __init__(self, values: np.ndarray, cell: float = 1.0, origin: tuple[float, float] = (0.0, 0.0)):
        v = np.asarray(values)
        self.h, self.w = v.shape
        self.cell = float(cell)
        self.ox, self.oy = float(origin[0]), float(origin[1])
        if v.dtype == np.bool_ or v.dtype == np.uint8:
            # binary masks: exact integer SAT (int32 while the total fits, else int64)
            vmax = 1 if v.dtype == np.bool_ else 255
            dt = np.int32 if v.size * vmax < 2 ** 31 else np.int64
            self.scale = 1.0 / 255.0 if v.dtype == np.uint8 else 1.0
            self.sat = np.zeros((self.h + 1, self.w + 1), dtype=dt)
            np.cumsum(np.cumsum(v.astype(dt), axis=0, dtype=dt), axis=1, dtype=dt, out=self.sat[1:, 1:])
        else:
            self.scale = 1.0
            self.sat = np.zeros((self.h + 1, self.w + 1), dtype=np.float64)
            self.sat[1:, 1:] = np.cumsum(np.cumsum(v.astype(np.float64), axis=0), axis=1)

    def _F(self, gx: float, gy: float) -> float:
        gx = min(max(gx, 0.0), float(self.w))
        gy = min(max(gy, 0.0), float(self.h))
        i, j = int(math.floor(gx)), int(math.floor(gy))
        i, j = min(i, self.w - 1), min(j, self.h - 1)
        fx, fy = gx - i, gy - j
        s = self.sat
        s00, s10, s01, s11 = float(s[j, i]), float(s[j, i + 1]), float(s[j + 1, i]), float(s[j + 1, i + 1])
        return (s00 + fx * (s10 - s00) + fy * (s01 - s00) + fx * fy * (s11 - s10 - s01 + s00)) * self.scale

    def integral(self, x0: float, y0: float, x1: float, y1: float) -> float:
        """∫ value over the canvas box, in canvas px² (value 1 = fully covered)."""
        if x1 <= x0 or y1 <= y0:
            return 0.0
        c = self.cell
        gx0, gx1 = (x0 - self.ox) / c, (x1 - self.ox) / c
        gy0, gy1 = (y0 - self.oy) / c, (y1 - self.oy) / c
        v = self._F(gx1, gy1) - self._F(gx0, gy1) - self._F(gx1, gy0) + self._F(gx0, gy0)
        return max(0.0, v) * c * c
