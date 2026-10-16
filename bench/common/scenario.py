"""Helpers shared by the scenario build scripts.

Output layout (all reproducible, gitignored):

    bench/out/problems/<scenario>/<config>.json          problem (schema problem.v1.json)
    bench/out/problems/<scenario>/<config>.truth.json    exact obstacle geometry for the evaluator
    bench/out/problems/<scenario>/<config>.bg.svg|.png   background files for rendering
    bench/out/problems/<scenario>/scenario.json          manifest (configs, quick flag, sources)
"""
from __future__ import annotations

import base64
import io
import math
import sys
from pathlib import Path
from typing import Iterable

from PIL import Image

from . import paths
from .jsonio import write_json
from .scene import Scene
from .sources import SOURCES


def png_bytes(img: Image.Image, palette: bool = False) -> bytes:
    """Deterministic PNG encoding (no metadata)."""
    buf = io.BytesIO()
    im = img
    if palette:
        im = img.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


def data_url(png: bytes, mime: str = "image/png") -> str:
    return f"data:{mime};base64,{base64.b64encode(png).decode('ascii')}"


class Writer:
    """Collects the configs of one scenario and writes files + manifest."""

    def __init__(self, scenario: str, title: str, sources: Iterable[str], notes: str = ""):
        self.scenario = scenario
        self.title = title
        self.sources = list(sources)
        self.notes = notes
        self.dir = paths.scenario_out(scenario)
        self.configs: list[dict] = []
        self.extra: dict = {}

    def config(self, name: str, problem: dict, *, truth: dict | None = None, svg: str | None = None,
               png: bytes | None = None, quick: bool = False, description: str = "", sub: str | None = None,
               **meta) -> dict:
        d = self.dir / sub if sub else self.dir
        d.mkdir(parents=True, exist_ok=True)
        problem.setdefault("version", "1")
        p = write_json(d / f"{name}.json", problem, nd=3)
        files = {"problem": str(p.relative_to(self.dir))}
        if truth is not None:
            t = write_json(d / f"{name}.truth.json", truth, nd=3)
            files["truth"] = str(t.relative_to(self.dir))
        if svg is not None:
            sp = d / f"{name}.bg.svg"
            sp.write_text(svg, encoding="utf-8", newline="\n")
            files["background_svg"] = str(sp.relative_to(self.dir))
        if png is not None:
            pp = d / f"{name}.bg.png"
            pp.write_bytes(png)
            files["background_png"] = str(pp.relative_to(self.dir))
        size = p.stat().st_size
        entry = {"name": name if not sub else f"{sub}/{name}", "quick": quick, "description": description,
                 "n_items": len(problem["items"]), "bytes": size, "files": files}
        entry.update(meta)
        self.configs.append(entry)
        print(f"  wrote {self.scenario}/{entry['name']}: {entry['n_items']} items, {size / 1e6:.2f} MB")
        if size > 5_000_000:
            print(f"  WARNING: {entry['name']} exceeds 5 MB", file=sys.stderr)
        return entry

    def finish(self) -> Path:
        man = {"scenario": self.scenario, "title": self.title, "notes": self.notes,
               "sources": [{"id": s, "url": SOURCES[s].url, "sha256": SOURCES[s].sha256,
                            "license": SOURCES[s].license, "attribution": SOURCES[s].attribution}
                           for s in self.sources],
               "configs": self.configs}
        man.update(self.extra)
        return write_json(self.dir / "scenario.json", man, nd=3, indent=1)


# ---------------------------------------------------------------------------
# Chart helpers
# ---------------------------------------------------------------------------
def nice_ticks(lo: float, hi: float, n: int = 6) -> list[float]:
    if hi <= lo:
        return [lo]
    raw = (hi - lo) / max(1, n)
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        step = m * mag
        if step >= raw:
            break
    start = math.ceil(lo / step - 1e-9) * step
    out = []
    v = start
    while v <= hi + 1e-9 * step:
        out.append(round(v, 10))
        v += step
    return out


def fmt_tick(v: float) -> str:
    if abs(v) >= 1e6:
        return f"{v / 1e6:g}M"
    if abs(v) >= 1e4:
        return f"{v / 1e3:g}k"
    return f"{v:g}"


class Axes:
    """Linear (or log10) mapping of a data domain onto a plot rectangle (canvas px, y down)."""

    def __init__(self, x0, y0, x1, y1, xdom, ydom, xlog=False, ylog=False):
        self.x0, self.y0, self.x1, self.y1 = x0, y0, x1, y1
        self.xdom, self.ydom = xdom, ydom
        self.xlog, self.ylog = xlog, ylog

    def _t(self, v, dom, log):
        if log:
            v, dom = math.log10(v), (math.log10(dom[0]), math.log10(dom[1]))
        return (v - dom[0]) / (dom[1] - dom[0])

    def px(self, x: float, y: float) -> tuple[float, float]:
        tx = self._t(x, self.xdom, self.xlog)
        ty = self._t(y, self.ydom, self.ylog)
        return (self.x0 + tx * (self.x1 - self.x0), self.y1 - ty * (self.y1 - self.y0))

    def decorate(self, sc: Scene, xlabel: str = "", ylabel: str = "", grid: bool = True, size: float = 10.0,
                 xticks: list[float] | None = None, yticks: list[float] | None = None, tick_fmt=fmt_tick,
                 grid_class: str = "grid", axes_class: str = "axes", text_class: str = "text") -> None:
        xt = xticks if xticks is not None else (_log_ticks(self.xdom) if self.xlog else nice_ticks(*self.xdom))
        yt = yticks if yticks is not None else (_log_ticks(self.ydom) if self.ylog else nice_ticks(*self.ydom))
        for v in xt:
            x, _ = self.px(v, self.ydom[0])
            if grid:
                sc.polyline([(x, self.y0), (x, self.y1)], "gridline", grid_class, stroke="#e3e3e3", width=1.0)
            sc.polyline([(x, self.y1), (x, self.y1 + 5)], "tick", axes_class, stroke="#555555", width=1.0)
            sc.text(x, self.y1 + 7 + size, tick_fmt(v), "ticklabel", text_class, size=size, anchor="middle",
                    fill="#555555")
        for v in yt:
            _, y = self.px(self.xdom[0], v)
            if grid:
                sc.polyline([(self.x0, y), (self.x1, y)], "gridline", grid_class, stroke="#e3e3e3", width=1.0)
            sc.polyline([(self.x0 - 5, y), (self.x0, y)], "tick", axes_class, stroke="#555555", width=1.0)
            sc.text(self.x0 - 8, y + size * 0.35, tick_fmt(v), "ticklabel", text_class, size=size, anchor="end",
                    fill="#555555")
        sc.polyline([(self.x0, self.y1), (self.x1, self.y1)], "axis", axes_class, stroke="#555555", width=1.0)
        sc.polyline([(self.x0, self.y0), (self.x0, self.y1)], "axis", axes_class, stroke="#555555", width=1.0)
        if xlabel:
            sc.text((self.x0 + self.x1) / 2, self.y1 + 2 * size + 18, xlabel, "axistitle", text_class,
                    size=size + 1, anchor="middle", fill="#333333")
        if ylabel:
            sc.text(self.x0 - 44, (self.y0 + self.y1) / 2, ylabel, "axistitle", text_class, size=size + 1,
                    anchor="middle", fill="#333333", rotate=-90.0)


def _log_ticks(dom) -> list[float]:
    lo, hi = math.floor(math.log10(dom[0])), math.ceil(math.log10(dom[1]))
    return [10.0 ** k for k in range(lo, hi + 1) if dom[0] <= 10.0 ** k <= dom[1]]


def base_problem(width: float, height: float, preset: str, font_size: float = 11.0, padding: float = 4.0) -> dict:
    return {"version": "1", "canvas": {"width": width, "height": height, "padding": padding}, "preset": preset,
            "defaults": {"font": {"size": font_size}}, "items": []}


def svg_source(sc: Scene) -> dict:
    """SVG obstacle source with explicit class rules (every drawn element matches a rule)."""
    return {"source": sc.svg(), "classes": sc.svg_rules()}


def merge_avoid(problem: dict, label: dict | None = None, leader: dict | None = None,
                ignore_background: bool = False) -> dict:
    """Merge avoid entries into ``problem['avoid']``; optionally make class 'background' ignored."""
    av = problem.setdefault("avoid", {})
    lab = dict(av.get("label", {}))
    lea = dict(av.get("leader", {}))
    lab.update(label or {})
    lea.update(leader or {})
    if ignore_background:
        lab["background"] = "ignore"
        lea["background"] = "ignore"
    if lab:
        av["label"] = lab
    if lea:
        av["leader"] = lea
    return problem
