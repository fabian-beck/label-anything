"""Build scenario 02: volcano plots of differential expression tables.

x = log2 fold change, y = -log10(p value). The top-N genes by significance
(smallest p value, ties by gene symbol) are labeled; every other gene is a
``points`` obstacle (the dense background). Thresholds |log2FC| = 1 and
p = 0.05 are drawn as ``lines``.

Configs:
* ``top20-vector`` (quick)  dense table (16,406 genes), points/thresholds/axes as vector layers,
* ``top50-svg``             dense table, SVG chart (colored significant genes, dashed thresholds),
* ``top30-transform``       dense table in data units: ``transform`` + ``y_axis: "up"``, no background,
* ``nfcore-top20-vector``   nf-core DESeq2 results (977 genes with p values), vector layers.
"""
from __future__ import annotations

import csv
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch  # noqa: E402
from bench.common.scenario import Axes, Writer, base_problem, merge_avoid, png_bytes, svg_source  # noqa: E402
from bench.common.scene import Scene  # noqa: E402

SCENARIO = "02-volcano"
SOURCES = ["galaxy-volcano-input", "nfcore-srp254919-deseq2", "nfcore-srp254919-genemeta"]
W, H = 900.0, 680.0
PLOT = (70.0, 34.0, W - 24.0, H - 60.0)


def _f(v):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return x if math.isfinite(x) else None


def load_galaxy():
    rows = []
    with open(fetch.ensure("galaxy-volcano-input", verbose=False), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            fc, p = _f(r["log2FoldChange"]), _f(r["pvalue"])
            if fc is None or p is None or p <= 0:
                continue
            rows.append({"gene": r["Gene"], "fc": fc, "p": p, "padj": _f(r["padj"])})
    return rows


def load_nfcore():
    names = {}
    with open(fetch.ensure("nfcore-srp254919-genemeta", verbose=False), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            names[r["gene_id"]] = r["gene_name"]
    rows = []
    with open(fetch.ensure("nfcore-srp254919-deseq2", verbose=False), encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f, delimiter="\t"):
            fc, p = _f(r["log2FoldChange"]), _f(r["pvalue"])
            if fc is None or p is None or p <= 0:
                continue
            rows.append({"gene": names.get(r["gene_id"], r["gene_id"]), "fc": fc, "p": p, "padj": _f(r["padj"])})
    # gene symbols are not unique in general: keep ids unique
    seen: dict[str, int] = {}
    for r in rows:
        seen[r["gene"]] = seen.get(r["gene"], 0) + 1
    return rows


def axes_for(rows) -> Axes:
    fcs = [r["fc"] for r in rows]
    ys = [-math.log10(r["p"]) for r in rows]
    lim = max(abs(min(fcs)), abs(max(fcs))) * 1.08
    return Axes(*PLOT, (-lim, lim), (0.0, max(ys) * 1.08))


def scene_for(rows, ax: Axes, sel: set[int], colored: bool, title: str | None) -> Scene:
    sc = Scene(W, H, background="#ffffff")
    ax.decorate(sc, xlabel="log2 fold change", ylabel="-log10 p value", size=10.0)
    y05 = ax.px(0, -math.log10(0.05))[1]
    sc.polyline([(PLOT[0], y05), (PLOT[2], y05)], "threshold", "lines", stroke="#999999", width=1.0, dash="4 3")
    for v in (-1.0, 1.0):
        if ax.xdom[0] < v < ax.xdom[1]:
            x = ax.px(v, 0)[0]
            sc.polyline([(x, PLOT[1]), (x, PLOT[3])], "threshold", "lines", stroke="#999999", width=1.0,
                        dash="4 3")
    for k, r in enumerate(rows):
        if k in sel:
            continue
        x, y = ax.px(r["fc"], -math.log10(r["p"]))
        col = "#9aa3ab"
        if colored and r["p"] < 0.05 and abs(r["fc"]) >= 1:
            col = "#d1495b" if r["fc"] > 0 else "#2e86ab"
        sc.circle(x, y, 1.8, "gene", "points", fill=col, opacity=0.7)
    if title:
        sc.text(PLOT[0] + 6, PLOT[1] - 12, title, "title", "text", size=12, weight=700, fill="#222222")
    return sc


def ranked(rows) -> list[int]:
    return sorted(range(len(rows)), key=lambda k: (rows[k]["p"], rows[k]["gene"]))


def items_for(rows, idx, pos) -> list[dict]:
    out = []
    seen: dict[str, int] = {}
    for k in idx:
        r = rows[k]
        x, y = pos(r)
        g = r["gene"]
        seen[g] = seen.get(g, 0) + 1
        iid = g if seen[g] == 1 else f"{g}#{seen[g]}"
        attrs = {"log2fc": r["fc"], "pvalue": r["p"], "neglog10p": round(-math.log10(r["p"]), 4)}
        if r["padj"] is not None:
            attrs["padj"] = r["padj"]
        out.append({"id": iid, "anchor": {"type": "point", "x": round(x, 4), "y": round(y, 4),
                                          "mark": {"shape": "circle", "r": 3.0}},
                    "label": {"type": "text", "text": g}, "attrs": attrs})
    return out


def problem(items, obstacles=None, **extra) -> dict:
    p = base_problem(W, H, "scatter", font_size=10.0)
    p["items"] = items
    p["priority"] = {"terms": [{"attr": "neglog10p"}]}
    if obstacles:
        p["obstacles"] = obstacles
    p.update(extra)
    return p


def vector_config(rows, n):
    ax = axes_for(rows)
    order = ranked(rows)
    sel = set(order[:n])
    sc = scene_for(rows, ax, sel, colored=False, title=None)
    p = problem(items_for(rows, order[:n], lambda r: ax.px(r["fc"], -math.log10(r["p"]))),
                {"vector": sc.vector_layers()})
    merge_avoid(p, {"grid": 0.2}, {"grid": 0.1})
    return p, sc


def main() -> None:
    dense = load_galaxy()
    small = load_nfcore()
    wr = Writer(SCENARIO, "Volcano plot", SOURCES,
                notes=f"dense: {len(dense)} genes (Galaxy volcanoplot test data); small: {len(small)} genes "
                      "with p values (nf-core SRP254919 DESeq2 results).")
    p, sc = vector_config(dense, 20)
    wr.config("top20-vector", p, quick=True, png=png_bytes(sc.png()),
              description="Top 20 of 16,406 genes; other genes, thresholds, axes and ticks as vector layers.")
    ax = axes_for(dense)
    order = ranked(dense)
    sel = set(order[:50])
    sc = scene_for(dense, ax, sel, colored=True, title="Differential expression")
    p = problem(items_for(dense, order[:50], lambda r: ax.px(r["fc"], -math.log10(r["p"]))),
                {"svg": svg_source(sc)})
    merge_avoid(p, {"grid": 0.2}, {"grid": 0.1}, ignore_background=True)
    wr.config("top50-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="Top 50 genes on an SVG volcano plot (colored significant genes, dashed thresholds).")
    # data units with transform + y_axis up
    sx = (PLOT[2] - PLOT[0]) / (ax.xdom[1] - ax.xdom[0])
    sy = (PLOT[3] - PLOT[1]) / (ax.ydom[1] - ax.ydom[0])
    ex = PLOT[0] - sx * ax.xdom[0]
    ey = (H - PLOT[3]) - sy * ax.ydom[0]
    sel = set(order[:30])
    pts = [[round(r["fc"], 5), round(-math.log10(r["p"]), 5)] for k, r in enumerate(dense) if k not in sel]
    p = problem(items_for(dense, order[:30], lambda r: (r["fc"], -math.log10(r["p"]))),
                {"vector": [{"class": "points", "points": pts, "r": 1.8}]},
                transform=[round(sx, 6), 0, 0, round(sy, 6), round(ex, 6), round(ey, 6)], y_axis="up")
    wr.config("top30-transform", p, png=png_bytes(scene_for(dense, ax, sel, False, None).png()),
              description="Top 30 genes, anchors and points in data units mapped by transform + y_axis up.")
    p, sc = vector_config(small, 20)
    wr.config("nfcore-top20-vector", p, png=png_bytes(sc.png()),
              description="Top 20 of 977 genes of an nf-core DESeq2 result table, vector layers.")
    wr.finish()


if __name__ == "__main__":
    main()
