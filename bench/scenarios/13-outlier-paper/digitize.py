"""Digitize Figures 1, 3, 4 and 8 of Mumtaz et al. (2019) into ``figures.json`` (provenance only).

H. Mumtaz, M. van Garderen, F. Beck, D. Weiskopf: *Label Placement for Outliers in Scatterplots*,
EuroVis 2019 short paper, doi:10.2312/evs.20191161. The figures are raster images in the PDF;
extract them first (poppler-utils) into a directory of their own:

    pdfimages -png paper.pdf figs/          # figs/im-000.png (Fig. 1), -004 (3), -006 (4), -014 (8)
    python bench/scenarios/13-outlier-paper/digitize.py figs/ -o bench/scenarios/13-outlier-paper/figures.json

What it reads off each figure, in image px:

* **dots**: red (outliers) and blue (other points) connected components of the dot colours; a
  component of k dots' area is split by k-means (overlapping dots); dots drawn exactly on top of
  each other stay one;
* **data values**: through the axes, located by their tick marks (the tick values are typed in
  below), rounded to integers for the software metrics;
* **names**: each red dot gets the name the figure prints next to it, by an optimal assignment
  to the approximate positions typed in below;
* **published labels**: the grey label text, words found as components of the coloured sub-pixel
  fringes of its glyphs, matched to the names by measured width (Noto Sans at the size that gives
  the paper's widths) and distance (optimal assignment); words the analysis misses or cuts are
  typed in (``MANUAL``); a label has a leader where grey pixels run from its dot to its text.

``build.py`` uses only ``figures.json``; this script documents where it comes from.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage
from scipy.optimize import linear_sum_assignment
from sklearn.cluster import KMeans

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.text import font  # noqa: E402

RED = np.array((219, 51, 24))
BLUE = np.array((94, 128, 176))

# key: image, figure, scale (canvas px per image px: 12 px Noto Sans labels then have the paper's
# widths), axis names and tick values (from the left/top tick on), integer data, the names printed
# next to the outliers with their approximate data positions
FIGS = {
    "fig1-cbo-rfc": dict(image="im-000.png", figure="Figure 1", scale=0.5, x=("cbo", 0, 10), y=("rfc", 140, -20),
                         integer=True, names={
        "InitializationBean": (20, 140), "EditArticleAction": (16, 83), "TopicsManagerBean": (8, 69),
        "PFFForm": (28, 61), "ShowProfileAction": (20, 38), "RedactorsManager": (29, 42), "Topic": (35, 44),
        "ActionManager": (57, 53), "Redactor": (69, 41), "Guardian": (52, 36), "PFFWidget": (25, 28),
        "RequestWrapper": (40, 28), "Rights": (29, 24), "ProfileForm": (17, 21), "PFFValidator": (35, 10),
        "PTFDataModel": (27, 7), "BadParamsException": (39, 11), "NotAllowedException": (43, 11),
        "IAction": (61, 5)}),
    "fig3-cbo-wmc": dict(image="im-004.png", figure="Figure 3", scale=0.5, x=("cbo", 0, 10), y=("wmc", 35, -5),
                         integer=True, names={
        "TestManagerBean": (13, 36), "Topic": (35, 34), "TestManagerRemote": (6, 33), "Article": (19, 31),
        "Redactor": (69, 31), "HyperlinkProperties": (13, 29), "InitializationBean": (20, 29), "PFFForm": (28, 29),
        "TopicsManagerBean": (8, 24), "PFFField": (15, 23), "Issue": (22, 22), "RequestWrapper": (40, 23),
        "ArticlesManagerBean": (7, 21), "TopicsManager": (19, 19), "ArticlesManagerLocal": (7, 18),
        "Contact": (13, 18), "PFFWidget": (25, 17), "RedactorsManager": (29, 17), "HTMLHelper": (21, 15),
        "Rights": (29, 15), "Guardian": (52, 15), "PFFValidator": (35, 8), "PTFDataModel": (27, 7),
        "BadParamsException": (39, 6), "NotAllowedException": (43, 6), "IAction": (61, 5),
        "ActionManager": (57, 4)}),
    "fig8-income-disorders": dict(image="im-014.png", figure="Figure 8", scale=0.4,
                                  x=("median_income", 40000, 5000), y=("mental_disorders", 4.0, -0.5),
                                  integer=False, names={
        "Maine": (50700, 3.42), "Vermont": (59500, 2.94), "Rhode Island": (55700, 2.96),
        "New Hampshire": (75700, 3.19), "Mississippi": (40000, 2.59), "Alabama": (44500, 2.52),
        "Massachusetts": (67800, 2.65), "Minnesota": (68700, 1.96), "Washington": (67200, 1.76),
        "Connecticut": (72800, 1.84), "Florida": (48800, 1.54), "Georgia": (50700, 1.45), "Nevada": (51900, 1.21),
        "New Jersey": (68300, 1.42), "District of Columbia": (70100, 1.49), "Maryland": (73500, 1.34),
        "Alaska": (75100, 1.18)}),
}
# Figure 4 is Figure 3 with a lower outlier threshold: six more names (Util's dot is drawn blue)
FIGS["fig4-cbo-wmc-more"] = dict(FIGS["fig3-cbo-wmc"], image="im-006.png", figure="Figure 4", names={
    **FIGS["fig3-cbo-wmc"]["names"], "Message": (15, 20), "EditArticleAction": (16, 14), "Util": (18, 13),
    "ShowProfileAction": (20, 9), "NewAccountForm": (25, 4), "CharacterEncodingFilter": (1, 6)})
ORDER = ["fig1-cbo-rfc", "fig3-cbo-wmc", "fig4-cbo-wmc-more", "fig8-income-disorders"]
# words the component analysis misses or cuts (thin glyphs without fringes): text extents, image px
MANUAL = {
    "fig1-cbo-rfc": {"Topic": (463, 714, 519, 737), "IAction": (783, 961, 858, 979)},
    "fig3-cbo-wmc": {"Topic": (469, 161, 525, 184)},
    "fig4-cbo-wmc-more": {"Topic": (509, 166, 565, 189), "Issue": (354, 448, 407, 466), "Util": (304, 662, 338, 681),
                          "IAction": (840, 817, 915, 836), "EditArticleAction": (68, 591, 256, 610)},
}


def rgb(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("RGB")).astype(int)


def dots(a: np.ndarray, col: np.ndarray, tol: int = 40) -> list[tuple[float, float]]:
    """Centres of the dots of one colour; components of k dots' area are split by k-means."""
    m = ndimage.binary_closing(np.abs(a - col).sum(axis=2) < tol, iterations=1)
    lab, n = ndimage.label(m)
    sizes = ndimage.sum(m, lab, range(1, n + 1))
    unit = float(np.median(sizes[sizes > 20]))
    out = []
    for i in range(1, n + 1):
        if sizes[i - 1] < 0.35 * unit:
            continue
        ys, xs = np.nonzero(lab == i)
        k = max(1, int(round(sizes[i - 1] / unit)))
        if k == 1:
            out.append((float(xs.mean()), float(ys.mean())))
        else:
            km = KMeans(n_clusters=k, n_init=10, random_state=0).fit(np.c_[xs, ys])
            out += [(float(x), float(y)) for x, y in km.cluster_centers_]
    return out


def axes(a: np.ndarray) -> tuple[int, int, list[float], list[float]]:
    """The axis row (top) and column (right) and the tick positions along them (outside the plot)."""
    blk = a.sum(axis=2) < 150
    h, w = blk.shape
    row = int(np.argmax(blk.sum(axis=1)[:h // 4]))
    col = int(w // 2 + np.argmax(blk.sum(axis=0)[w // 2:]))
    lab, n = ndimage.label(blk[row - 9:row - 2, :].sum(axis=0) >= 5)
    xt = [float(np.mean(np.nonzero(lab == i)[0])) for i in range(1, n + 1)]
    lab, n = ndimage.label(blk[:, col + 3:col + 10].sum(axis=1) >= 5)
    yt = [float(np.mean(np.nonzero(lab == i)[0])) for i in range(1, n + 1)]
    return row, col, xt, yt


def calibration(ticks: list[float], start: float, step: float, axis_at: int) -> list[list[float]]:
    """(px, value) of the first and last regular tick: the ticks one step apart (the axis' own end
    and the tick at the far axis are not ticks of the scale)."""
    ticks = [t for t in ticks if abs(t - axis_at) > 3]
    gaps = np.diff(ticks)
    g = float(np.median(gaps))
    reg = [t for k, t in enumerate(ticks) if (k > 0 and abs(gaps[k - 1] - g) < 2) or
           (k + 1 < len(ticks) and abs(gaps[k] - g) < 2)]
    return [[reg[0], start], [reg[-1], start + step * (len(reg) - 1)]]


def lin(p: float, cal) -> float:
    (p0, v0), (p1, v1) = cal
    return v0 + (p - p0) * (v1 - v0) / (p1 - p0)


def inv(v: float, cal) -> float:
    (p0, v0), (p1, v1) = cal
    return p0 + (v - v0) * (p1 - p0) / (v1 - v0)


def words(a: np.ndarray, row: int, col: int) -> list[tuple[int, int, int, int]]:
    """Boxes of the label words: the grey glyphs with their coloured sub-pixel fringes (leaders are
    grey with neutral anti-aliasing), below the top axis and left of the right one."""
    r_, b_ = a[..., 0], a[..., 2]
    dr = np.abs(a - RED).sum(axis=2)
    db = np.abs(a - BLUE).sum(axis=2)
    dot = ndimage.binary_dilation(((dr < 160) & (r_ - b_ > 80)) | ((db < 120) & (b_ - r_ > 40)), iterations=2)
    fringe = (a.max(axis=2) - a.min(axis=2) > 20) & ~dot & (a.sum(axis=2) < 740)
    seed = ndimage.binary_dilation(fringe, iterations=2) & ((np.abs(a - 128).sum(axis=2) < 12) | fringe)
    m = ndimage.binary_dilation(seed, structure=np.ones((3, 9), bool))
    m[:row + 3, :] = False
    m[:, col - 2:] = False
    lab, _ = ndimage.label(m)
    out = []
    for i, (ys, xs) in enumerate(ndimage.find_objects(lab)):
        if not 8 <= ys.stop - ys.start <= 60 or xs.stop - xs.start < 8:
            continue
        yy, xx = np.nonzero(seed[ys, xs] & (lab[ys, xs] == i + 1))
        out.append((xs.start + int(xx.min()), ys.start + int(yy.min()), xs.start + int(xx.max()) + 1,
                    ys.start + int(yy.max()) + 1))
    return sorted(out, key=lambda b: (b[1], b[0]))


def label_boxes(a, row, col, named, size, manual) -> dict[str, tuple[int, int, int, int]]:
    """The text box of each name: one word or a run of up to three words on a line, matched by width
    and distance to the name's dot (optimal assignment, every word used once)."""
    ws = words(a, row, col)
    cands = []
    for i, b in enumerate(ws):
        cands.append(((i,), b))
        run, cur = [i], b
        for _ in range(2):
            nxt = [j for j, c in enumerate(ws) if j not in run and -8 <= c[0] - cur[2] <= 22 and c[2] > cur[2]
                   and abs((c[1] + c[3]) / 2 - (cur[1] + cur[3]) / 2) < 8]
            if not nxt:
                break
            j = min(nxt, key=lambda j: ws[j][0])
            run = run + [j]
            c = ws[j]
            cur = (min(cur[0], c[0]), min(cur[1], c[1]), max(cur[2], c[2]), max(cur[3], c[3]))
            cands.append((tuple(run), cur))
    f = font(400)
    names = [n for n in named if n not in manual]
    cost = np.full((len(names), len(cands)), 1e6)
    for i, n in enumerate(names):
        px, py = named[n]
        wn = f.width(n, size)
        for j, (_ids, b) in enumerate(cands):
            wb = b[2] - b[0]
            if abs(wb - wn) > max(0.12 * wn, 10.0):
                continue
            d = math.hypot(max(b[0] - px, px - b[2], 0), max(b[1] - py, py - b[3], 0))
            cost[i, j] = 4 * abs(wb - wn) / wn + d / 400
    out = dict(manual)
    used: set[int] = set()
    rows, cols = linear_sum_assignment(cost)
    for i, j in sorted(zip(rows, cols), key=lambda t: cost[t[0], t[1]]):
        ids, b = cands[j]
        if cost[i, j] >= 1e6 or used & set(ids):
            raise SystemExit(f"no text found for {names[i]!r}")
        out[names[i]] = b
        used |= set(ids)
    return out


def has_leader(a: np.ndarray, p, box, r: float) -> bool:
    """Grey pixels all along a segment from the dot to some point of the text box's outline (the
    figures' leaders end anywhere on it), the segment's ends left out."""
    grey = (np.abs(a - 128).sum(axis=2) < 40) | ((a.max(axis=2) - a.min(axis=2) < 8) & (a.sum(axis=2) < 600))
    x0, y0, x1, y1 = box
    ends = [(x, y) for x in np.arange(x0, x1 + 1, 2.0) for y in (y0, y1)]
    ends += [(x, y) for y in np.arange(y0, y1 + 1, 2.0) for x in (x0, x1)]
    best = 0.0
    for qx, qy in ends:
        length = math.hypot(qx - p[0], qy - p[1])
        if length < 14:
            continue
        # only ends on the side facing the dot: the segment must not cross the text first
        bx, by = qx - 3 * (qx - p[0]) / length, qy - 3 * (qy - p[1]) / length
        if x0 < bx < x1 and y0 < by < y1:
            continue
        hits = n = 0
        for s in np.linspace(0, 1, 60):
            d = s * length
            if d < r + 3 or d > length - 2:
                continue
            x, y = p[0] + s * (qx - p[0]), p[1] + s * (qy - p[1])
            n += 1
            hits += bool(grey[int(y) - 1:int(y) + 2, int(x) - 1:int(x) + 2].any())
        if n:
            best = max(best, hits / n)
    return best > 0.85


def digitize(key: str, spec: dict, images: Path) -> dict:
    a = rgb(images / spec["image"])
    row, col, xt, yt = axes(a)
    xn, x0, xs = spec["x"]
    yn, y0, ys = spec["y"]
    xcal = calibration(xt, x0, xs, col)
    ycal = calibration(yt, y0, ys, row)
    red, blue = dots(a, RED), dots(a, BLUE)
    names = list(spec["names"])
    sx, sy = xcal[1][1] - xcal[0][1], ycal[1][1] - ycal[0][1]
    cand = red + blue                     # a name may sit on a blue dot (Util in Figure 4)
    cost = np.array([[((lin(x, xcal) - spec["names"][n][0]) / sx) ** 2 +
                      ((lin(y, ycal) - spec["names"][n][1]) / sy) ** 2 for x, y in cand] for n in names])
    rows, cols = linear_sum_assignment(cost)
    if any(cost[i, j] ** 0.5 > 0.02 for i, j in zip(rows, cols)):
        raise SystemExit(f"{key}: a name is farther than 2 % of the axis from its dot")
    rnd = (lambda v: int(round(v))) if spec["integer"] else (lambda v: round(v, 3))
    xr = (lambda v: int(round(v))) if spec["integer"] else (lambda v: int(round(v, -2)))
    at = {names[i]: cand[j] for i, j in zip(rows, cols)}
    used = set(cols.tolist())
    size = 12.0 / spec["scale"]           # the font size (image px) that gives the paper's label widths
    boxes = label_boxes(a, row, col, at, size, MANUAL.get(key, {}))
    r = 7.0
    outliers = []
    for n in sorted(names):
        p = at[n]
        outliers.append({"name": n, xn: xr(lin(p[0], xcal)), yn: rnd(lin(p[1], ycal)),
                         "label": list(boxes[n]), "leader": has_leader(a, p, boxes[n], r)})
    others = sorted(({xn: xr(lin(x, xcal)), yn: rnd(lin(y, ycal))} for k, (x, y) in enumerate(cand)
                     if k not in used), key=lambda o: (o[xn], o[yn]))
    return {"figure": spec["figure"], "image_size": [a.shape[1], a.shape[0]], "scale": spec["scale"],
            "plot": [0, row, col, a.shape[0]], "dot_radius": r,
            "x": {"name": xn, "ticks": xcal}, "y": {"name": yn, "ticks": ycal},
            "outliers": outliers, "others": others}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("images", help="directory with the PNGs pdfimages extracted from the paper")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    figs = {k: digitize(k, FIGS[k], Path(a.images)) for k in ORDER}
    doc = {"paper": "H. Mumtaz, M. van Garderen, F. Beck, D. Weiskopf: Label Placement for Outliers in "
                    "Scatterplots. EuroVis 2019 short paper, doi:10.2312/evs.20191161",
           "units": "image px of the figures as embedded in the PDF; data values in the axes' units",
           "figures": figs}
    Path(a.out).write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    for k, f in figs.items():
        print(f"{k}: {len(f['outliers'])} outliers ({sum(o['leader'] for o in f['outliers'])} with leaders), "
              f"{len(f['others'])} other points")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
