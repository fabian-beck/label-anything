"""Build scenario 01: software-metrics outliers (React Native 0.63.5 Android runtime).

Scatterplot of class metrics computed by CkLite (CK definitions, see CkLite.java):
CBO (x) vs RFC (y), both on log10(1 + v) axes, with a deterministic jitter of at
most ±0.3 metric units so identical integer pairs do not coincide exactly.
Outliers are the classes with the largest k-NN distance (k = 5, canvas px); they
are labeled with their fully qualified class names, all other classes are
``points`` obstacles.

Configs: ``cbo-rfc-10-none`` (quick), ``cbo-rfc-30-vector`` (axes/grid/ticks as
vector layers), ``cbo-rfc-100-svg`` (SVG chart, wrapped names without the prefix that every
class shares: ``uimanager.UIViewOperationQueue`` for ``com.facebook.react.uimanager.…``),
``wmc-loc-30-raster`` (WMC vs LOC drawn into a PNG background, raster mode ``ink``, names as in
``cbo-rfc-100-svg``).
"""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.scenario import (FONT_CLASSES_DENSE, Axes, Writer, base_problem, data_url, merge_avoid, png_bytes,  # noqa: E402
                                   svg_source)
from bench.common.scene import Scene  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

M = load_module("01", "metrics")
SCENARIO = "01-software-metrics"
W, H = 1000.0, 720.0
PLOT = (78.0, 24.0, W - 24.0, H - 62.0)
RAW_TICKS = [0, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000]


def tick_fmt(v: float) -> str:
    return f"{round(10 ** v - 1):g}"


def chart(ms, fx, fy, xlab, ylab):
    xs_raw = [max(0.0, fx(m) + M.jitter(m.name, "x" + xlab, 0.3)) for m in ms]
    ys_raw = [max(0.0, fy(m) + M.jitter(m.name, "y" + ylab, 0.3)) for m in ms]
    xmax = max(xs_raw) * 1.08
    ymax = max(ys_raw) * 1.08
    ax = Axes(*PLOT, (0.0, M.log1p_axis(xmax)), (0.0, M.log1p_axis(ymax)))
    pts = [ax.px(M.log1p_axis(x), M.log1p_axis(y)) for x, y in zip(xs_raw, ys_raw)]
    xt = [M.log1p_axis(v) for v in RAW_TICKS if v <= xmax]
    yt = [M.log1p_axis(v) for v in RAW_TICKS if v <= ymax]
    return ax, pts, xt, yt


def decorated_scene(ax, xt, yt, xlab, ylab, pts=None, outliers=()) -> Scene:
    sc = Scene(W, H, background="#ffffff")
    ax.decorate(sc, xlabel=xlab, ylabel=ylab, xticks=xt, yticks=yt, tick_fmt=tick_fmt, size=10.0)
    if pts is not None:
        for k, (x, y) in enumerate(pts):
            if k not in outliers:
                sc.circle(x, y, 2.5, "pt", "points", fill="#7f8c99", opacity=0.75)
    return sc


def short_name(fqcn: str) -> str:
    """The class name without the package prefix every class of the code base shares."""
    for prefix in ("com.facebook.react.", "com.facebook."):
        if fqcn.startswith(prefix):
            return fqcn[len(prefix):]
    return fqcn


def make_items(ms, pts, outl, idx, wrap=None, name=lambda n: n) -> list[dict]:
    items = []
    for k in idx:
        m = ms[k]
        x, y = pts[k]
        lab = {"type": "text", "text": name(m.name)}
        if wrap:
            lab["wrap"] = wrap
        items.append({"id": m.name, "anchor": {"type": "point", "x": round(x, 3), "y": round(y, 3),
                                               "mark": {"shape": "circle", "r": 3.0}},
                      "label": lab,
                      "attrs": {"cbo": m.cbo, "rfc": m.rfc, "wmc": m.wmc, "loc": m.loc, "type": m.type,
                                "area": m.area, "outlierness": round(outl[k], 4)}})
    return items


def problem_with(items, extra=None) -> dict:
    p = base_problem(W, H, "scatter", font_size=10.0)
    p["items"] = items
    p["priority"] = {"terms": [{"attr": "outlierness"}], "font_classes": FONT_CLASSES_DENSE}
    if extra:
        p.update(extra)
    return p


def main() -> None:
    ms = M.load_metrics()
    wr = Writer(SCENARIO, "Software metrics outliers", M.SOURCES,
                notes=f"{len(ms)} classes of ReactAndroid/src/main/java (react-native 0.63.5), metrics by CkLite.")
    ax, pts, xt, yt = chart(ms, lambda m: m.cbo, lambda m: m.rfc, "CBO", "RFC")
    outl = M.knn_outlierness(pts, 5)
    order = sorted(range(len(ms)), key=lambda k: (-outl[k], ms[k].name))

    def points_layer(exclude):
        return {"class": "points", "r": 2.5,
                "points": [[round(x, 3), round(y, 3)] for k, (x, y) in enumerate(pts) if k not in exclude]}

    # 1. quick: 10 outliers, no background
    sel = order[:10]
    p = problem_with(make_items(ms, pts, outl, sel), {"obstacles": {"vector": [points_layer(set(sel))]}})
    wr.config("cbo-rfc-10-none", p, quick=True,
              description="10 k-NN outliers labeled with FQCNs; other classes as soft points; no axes.")
    # 2. 30 outliers with vector chart decorations
    sel = order[:30]
    sc = decorated_scene(ax, xt, yt, "Coupling between objects (CBO)", "Response for a class (RFC)")
    layers = [points_layer(set(sel))] + sc.vector_layers()
    p = problem_with(make_items(ms, pts, outl, sel), {"obstacles": {"vector": layers}})
    merge_avoid(p, {"grid": 0.2}, {"grid": 0.1})
    wr.config("cbo-rfc-30-vector", p, png=png_bytes(decorated_scene(ax, xt, yt, "Coupling between objects (CBO)",
                                                                  "Response for a class (RFC)", pts, set(sel)).png()),
              description="30 outliers; points, axes (hard), grid (soft) and tick labels (text) as vector layers.")
    # 3. 100 outliers, SVG chart, wrapped names
    sel = order[:100]
    sc = decorated_scene(ax, xt, yt, "Coupling between objects (CBO)", "Response for a class (RFC)", pts, set(sel))
    p = problem_with(make_items(ms, pts, outl, sel, wrap={"max_width": "16em", "max_lines": 3}, name=short_name),
                     {"obstacles": {"svg": svg_source(sc)}})
    merge_avoid(p, {"grid": 0.2}, {"grid": 0.1}, ignore_background=True)
    wr.config("cbo-rfc-100-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="100 outliers on an SVG scatterplot; names below com.facebook(.react) wrap at package dots.")
    # 4. WMC vs LOC on a raster background
    ax2, pts2, xt2, yt2 = chart(ms, lambda m: m.wmc, lambda m: m.loc, "WMC", "LOC")
    outl2 = M.knn_outlierness(pts2, 5)
    order2 = sorted(range(len(ms)), key=lambda k: (-outl2[k], ms[k].name))
    sel = order2[:30]
    sc = decorated_scene(ax2, xt2, yt2, "Weighted methods per class (WMC)", "Lines of code (LOC)", pts2, set(sel))
    png = png_bytes(sc.png(), palette=True)
    p = problem_with(make_items(ms, pts2, outl2, sel, name=short_name),
                     {"obstacles": {"raster": {"source": data_url(png), "mode": "ink", "class": "ink"}}})
    wr.config("wmc-loc-30-raster", p, png=png,
              description="WMC vs LOC, 30 outliers; the whole chart is a PNG background (raster mode ink).")
    wr.finish()


if __name__ == "__main__":
    main()
