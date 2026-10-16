"""adjustText baseline (I. Flyamer, MIT; version ≥ 1.x): iterative force-directed repulsion.

Translation (see bench/baselines/README.md):

* texts: one ``Text`` per label at its anchor (``ha = va = "center"``), in priority
  order (adjustText has no explicit priority; input order decides the swaps of
  ``prevent_crossings``), with the problem's label box as its extent,
* ``x``/``y``: points sampled along polylines and polygon outlines (emulation:
  adjustText repels from points and boxes only),
* ``objects``: bounding boxes of every item's mark, of obstacle circles and
  rects, and of raster cells (emulation),
* the sampling step of lines (2, 4, 8, 16 or 32 px) and the raster cell size
  (twice that, at least 4 px) are the finest whose first iteration stays within
  ``PAIR_LIMIT`` (see below),
* ``avoid_self=True`` (texts are also repelled from their own anchor),
  ``prevent_crossings=True``, ``ensure_inside_axes=True`` (= the label area),
  arrows on (``arrowprops={"arrowstyle": "-"}``, default ``min_arrow_len=5``);
* a fixed iteration budget ``iter_lim=ITER_LIM`` instead of the default
  1-second wall-clock limit, so results do not depend on machine speed.

adjustText never omits labels: every label is reported placed. Each iteration
compares every x-overlapping interval pair with every y-overlapping pair (a dense
``|X| × |Y| × 2`` broadcast, about 3 bytes per pair of pairs at peak); problems
whose first iteration needs more than ``PAIR_LIMIT`` comparisons (about one second
per iteration here) even at the coarsest emulation are reported "n/a"
(``Unsupported``) with the estimate. With ``ITER_LIM`` = 100 a solve takes at most
a couple of minutes here (adjustText stops earlier once no overlap is left).

    python -m bench.baselines.adjusttext_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse
import time

import numpy as np

from ..common.geom import Box
from ..common.jsonio import read_json, write_json
from . import Unsupported
from .mpl import Canvas, ensure_matplotlib, fix_extent, px_to_pt
from .results import build_result
from .scene import Note, build_scene, ray_exit, sample_polyline

TOOL = "adjusttext"
ITER_LIM = 100
MIN_ARROW_LEN = 5.0
STEPS = (2.0, 4.0, 8.0, 16.0, 32.0)   # line sampling steps tried, finest first
EXPAND = (1.05, 1.2)                  # adjustText's default text expansion when texts repel each other
PAIR_LIMIT = 1.25e8                   # comparisons in the first iteration (≈ 1 s here, 200 MB of temporaries)


def version() -> str | None:
    try:
        from importlib.metadata import version as v

        return v("adjustText")
    except Exception:  # noqa: BLE001
        return None


def available() -> str | None:
    try:
        import adjustText  # noqa: F401
        import matplotlib  # noqa: F401
    except ImportError as e:
        return f"{e.name or 'adjustText'} is not installed (pip install -r bench/baselines/requirements.txt)"
    v = version() or "0"
    if int(v.split(".")[0]) < 1:
        return f"adjustText {v} is older than 1.0"
    return None


def pair_cost(labels, static: list[Box]) -> float:
    """Comparisons of adjustText's first iteration: |X|·|Y| of the x- and y-overlapping interval pairs,
    texts vs texts (expanded by ``EXPAND``) and texts vs static points/objects (labels at their anchors)."""
    from adjustText.arrops import overlap_intervals

    if not labels:
        return 0.0
    T = np.array([[lab.x - lab.w / 2 * EXPAND[0], lab.x + lab.w / 2 * EXPAND[0],
                   lab.y - lab.h / 2 * EXPAND[1], lab.y + lab.h / 2 * EXPAND[1]] for lab in labels])
    xt = len(overlap_intervals(T[:, 0], T[:, 1], T[:, 0], T[:, 1]))
    yt = len(overlap_intervals(T[:, 2], T[:, 3], T[:, 2], T[:, 3]))
    cost = float(xt) * float(yt)
    if static:
        S = np.array([[b.x0, b.x1, b.y0, b.y1] for b in static])
        xe = len(overlap_intervals(T[:, 0], T[:, 1], S[:, 0], S[:, 1]))
        ye = len(overlap_intervals(T[:, 2], T[:, 3], S[:, 2], S[:, 3]))
        cost = max(cost, float(xe) * float(ye))
    return 2.0 * cost


def warmup() -> None:
    """Import the tool and register the fonts once, outside the timed runs."""
    import adjustText  # noqa: F401

    ensure_matplotlib()


def solve(problem: dict, problem_path=None) -> dict:
    from adjustText import adjust_text
    from matplotlib.transforms import Bbox

    scene = build_scene(problem, problem_path)
    cv = Canvas(scene.width, scene.height, scene.area)
    tool_notes: list[Note] = []
    try:
        ax = cv.ax
        texts = []
        for lab in scene.labels:
            xd, yd = cv.to_data(lab.x, lab.y)
            t = ax.text(xd, yd, lab.text, fontsize=px_to_pt(lab.font_size),
                        fontweight="bold" if lab.font_weight >= 550 else "normal", ha="center", va="center")
            fix_extent(t, lab.w, lab.h)
            texts.append(t)
        obs = scene.obstacles
        fixed: list[Box] = [shp.bbox() for _iid, shp in scene.marks]
        fixed += [Box(x - r, y - r, x + r, y + r) for x, y, r, _c in obs.circles]
        fixed += [Box(x, y, x + w, y + h) for x, y, w, h, _c in obs.rects]
        cost = pair_cost(scene.labels, fixed)
        if cost > PAIR_LIMIT:
            raise Unsupported(f"adjustText's pairwise overlap test needs {cost / 1e6:,.0f} M comparisons in the "
                              f"first iteration for this problem (limit {PAIR_LIMIT / 1e6:,.0f} M)")
        has_lines = bool(obs.polylines or obs.polygons)
        for step in STEPS:
            pts = [p for pl, _w, _c in obs.polylines for p in sample_polyline(pl, step)]
            pts += [p for rings, _c in obs.polygons for r in rings for p in sample_polyline(list(r) + [r[0]], step)]
            cell = max(4.0, 2.0 * step)
            cells = [Box(x0, y0, x0 + s, y0 + s) for m in obs.masks for x0, y0, s in m.cells(cell)]
            cost = pair_cost(scene.labels, fixed + cells + [Box(x, y, x, y) for x, y in pts])
            if cost <= PAIR_LIMIT or not (has_lines or obs.masks):
                break
        if cost > PAIR_LIMIT:
            raise Unsupported(f"adjustText's pairwise overlap test needs {cost / 1e6:,.0f} M comparisons in the "
                              f"first iteration even with lines sampled every {step:g} px (limit "
                              f"{PAIR_LIMIT / 1e6:,.0f} M)")
        if has_lines:
            tool_notes.append(Note("emulation", "adjusttext-lines", f"polylines and polygon outlines as {len(pts)} "
                                                                    f"points every {step:g} px"))
        if obs.masks:
            tool_notes.append(Note("emulation", "adjusttext-raster", f"raster classes as {len(cells)} boxes "
                                                                     f"(cells of {cell:g} px)"))
        boxes = fixed + cells
        objects = [Bbox.from_extents(b.x0, cv.H - b.y1, b.x1, cv.H - b.y0) for b in boxes]
        px = [p[0] for p in pts]
        py = [cv.H - p[1] for p in pts]
        t0 = time.perf_counter()
        if texts:
            adjust_text(texts, x=np.asarray(px) if px else None, y=np.asarray(py) if px else None,
                        objects=objects or None, ax=ax, avoid_self=True, prevent_crossings=True,
                        ensure_inside_axes=True, expand_axes=False, iter_lim=ITER_LIM, time_lim=None,
                        min_arrow_len=MIN_ARROW_LEN, arrowprops={"arrowstyle": "-", "lw": 0.5})
        runtime = (time.perf_counter() - t0) * 1000.0
        out_boxes, ports = {}, {}
        for lab, t in zip(scene.labels, texts):
            xc, yc = (float(v) for v in t.get_unitless_position())  # centre (ha = va = center)
            box = cv.box_to_canvas(xc - lab.w / 2, yc - lab.h / 2, lab.w, lab.h)
            out_boxes[lab.id] = box
            # adjustText draws an arrow when max(x distance, y distance) of the nearest box edges to the target
            # is ≥ min_arrow_len (its display_dists); the arrow is clipped at the text's extent (= the box)
            xdist = min(abs(box.x0 - lab.x), abs(box.x1 - lab.x))
            ydist = min(abs(box.y0 - lab.y), abs(box.y1 - lab.y))
            if max(xdist, ydist) >= MIN_ARROW_LEN and not box.contains_point((lab.x, lab.y)):
                ports[lab.id] = ray_exit(box, (box.cx, box.cy), (lab.x, lab.y))
    finally:
        cv.close()
    return build_result(scene, out_boxes, ports, runtime, f"adjustText/{version()}", tool_notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
