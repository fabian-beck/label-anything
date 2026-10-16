"""textalloc baseline (C. Kjellson, MIT): greedy candidate search in matplotlib display space.

Translation (see bench/baselines/README.md):

* anchors: the labels' anchor points, in priority order (textalloc processes
  ``text_list`` in input order with ``priority_strategy=None``);
  ``text_scatter_sizes`` = mark radius + ``placement.offset`` and
  ``min_distance = 0`` so the 12 fixed positions touch the mark's offset ring,
* ``x_scatter``/``y_scatter`` + ``scatter_sizes``: every item's mark (radius) and
  the circles of the obstacle classes; raster classes as occupied cells (centre,
  half-size; emulation); rects as their centre (half the shorter side) plus their
  outline as lines,
* ``x_lines``/``y_lines``: polylines (stroke width not representable; the
  0.5 px ``margin`` covers thin strokes), rect and polygon outlines,
* connector lines on (``draw_lines``), ``avoid_label_lines_overlap`` and
  ``avoid_crossing_label_lines`` on (leaders vs labels and leader crossings are
  hard in the problems), ``draw_all=False`` (labels without a free candidate
  are reported unplaced), bounds = the label area, other parameters default
  (``nbr_candidates=200``, ``max_distance=0.2``).

    python -m bench.baselines.textalloc_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse
import time
from collections import defaultdict, deque

from ..common.jsonio import read_json, write_json
from .mpl import Canvas, ensure_matplotlib, fix_extent, px_to_pt
from .results import build_result
from .scene import Note, build_scene, choose_cell

TOOL = "textalloc"
MARGIN_PX = 0.5


def version() -> str | None:
    try:
        from importlib.metadata import version as v

        return v("textalloc")
    except Exception:  # noqa: BLE001 - not installed
        return None


def available() -> str | None:
    """None when the tool can run, else the reason it cannot."""
    try:
        import matplotlib  # noqa: F401
        import textalloc  # noqa: F401
    except ImportError as e:
        return f"{e.name or 'textalloc'} is not installed (pip install -r bench/baselines/requirements.txt)"
    return None


def warmup() -> None:
    """Import the tool and register the fonts once, outside the timed runs."""
    import textalloc  # noqa: F401

    ensure_matplotlib()


def solve(problem: dict, problem_path=None) -> dict:
    import textalloc

    scene = build_scene(problem, problem_path)
    cv = Canvas(scene.width, scene.height, scene.area)
    tool_notes: list[Note] = []
    if scene.obstacles.polylines or scene.obstacles.rects or scene.obstacles.polygons:
        tool_notes.append(Note("emulation", "textalloc-lines", "polylines have no width and rects / polygons are "
                                                               "their outlines (+ rect centres) for textalloc; a "
                                                               "0.5 px margin applies to points, lines and labels"))
    try:
        labels = scene.labels
        xs, ys, texts, sizes_pt, weights, tss = [], [], [], [], [], []
        queue: dict[tuple, deque] = defaultdict(deque)
        for lab in labels:
            xd, yd = cv.to_data(lab.x, lab.y)
            xs.append(xd)
            ys.append(yd)
            texts.append(lab.text)
            sizes_pt.append(px_to_pt(lab.font_size))
            weights.append("bold" if lab.font_weight >= 550 else "normal")
            tss.append(lab.mark_radius + lab.offset)
            queue[(xd, yd, lab.text)].append((lab.w, lab.h))
        sx, sy, ss = [], [], []
        for _iid, shp in scene.marks:
            b = shp.bbox()
            xd, yd = cv.to_data(b.cx, b.cy)
            sx.append(xd)
            sy.append(yd)
            ss.append(0.5 * max(b.w, b.h))
        obs = scene.obstacles
        for x, y, r, _c in obs.circles:
            xd, yd = cv.to_data(x, y)
            sx.append(xd)
            sy.append(yd)
            ss.append(r)
        lx, ly = [], []
        for pts, _w, _c in obs.polylines:
            lx.append([p[0] for p in pts])
            ly.append([cv.H - p[1] for p in pts])
        for x, y, w, h, _c in obs.rects:
            xd, yd = cv.to_data(x + w / 2, y + h / 2)
            sx.append(xd)
            sy.append(yd)
            ss.append(0.5 * min(w, h))
            ring = [(x, y), (x + w, y), (x + w, y + h), (x, y + h), (x, y)]
            lx.append([p[0] for p in ring])
            ly.append([cv.H - p[1] for p in ring])
        for rings, _c in obs.polygons:
            for r in rings:
                ring = list(r) + [r[0]]
                lx.append([p[0] for p in ring])
                ly.append([cv.H - p[1] for p in ring])
        if obs.masks:
            step = choose_cell(obs.masks)
            n0 = len(sx)
            for m in obs.masks:
                for x0, y0, s in m.cells(step):
                    xd, yd = cv.to_data(x0 + s / 2, y0 + s / 2)
                    sx.append(xd)
                    sy.append(yd)
                    ss.append(s / 2)
            tool_notes.append(Note("emulation", "textalloc-raster", f"raster classes as {len(sx) - n0} scatter points "
                                                                    f"(cells of {step:g} px)"))

        ax = cv.ax
        orig_text = ax.text

        def measured_text(x, y, s, *args, **kw):
            # textalloc measures every label once, in input order, with ax.text(x, y, s).get_window_extent()
            t = orig_text(x, y, s, *args, **kw)
            q = queue.get((float(x), float(y), s))
            if q:
                fix_extent(t, *q.popleft())
            return t

        ax.text = measured_text
        a = scene.area
        kw = {}
        if lx:
            kw.update(x_lines=lx, y_lines=ly)
        if sx:
            kw.update(x_scatter=sx, y_scatter=sy, scatter_sizes=ss)
        t0 = time.perf_counter()
        try:
            res_xyz, res_lines, text_objs, _line_objs = textalloc.allocate(
                ax, xs, ys, texts, text_scatter_sizes=tss, textsize=sizes_pt, fontweight=weights,
                margin=MARGIN_PX / a.w, min_distance=0.0, max_distance=0.2, nbr_candidates=200,
                draw_lines=True, draw_all=False, avoid_label_lines_overlap=True, avoid_crossing_label_lines=True,
                priority_strategy=None, xlims=cv.xlims(), ylims=cv.ylims(), **kw) if labels else ([], [], [], [])
        finally:
            del ax.text
        runtime = (time.perf_counter() - t0) * 1000.0
        boxes, ports = {}, {}
        for k, lab in enumerate(labels):
            if res_xyz[k] is None or text_objs[k] is None:
                continue
            xt, yt = float(res_xyz[k][0]), float(res_xyz[k][1])
            ha = text_objs[k].get_horizontalalignment()
            x_ll = xt - {"left": 0.0, "center": 0.5, "right": 1.0}.get(ha, 0.0) * lab.w
            boxes[lab.id] = cv.box_to_canvas(x_ll, yt, lab.w, lab.h)
            ln = res_lines[k]
            if ln is not None:
                ports[lab.id] = cv.to_canvas(float(ln[0][0]), float(ln[1][0]))
    finally:
        cv.close()
    return build_result(scene, boxes, ports, runtime, f"textalloc/{version()}", tool_notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
