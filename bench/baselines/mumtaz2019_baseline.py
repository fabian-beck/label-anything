"""Mumtaz et al. (2019) baseline: cost-based greedy labeling of scatterplot outliers, reimplemented.

H. Mumtaz, M. van Garderen, F. Beck, D. Weiskopf: *Label Placement for Outliers in
Scatterplots*. EuroVis 2019 short paper, doi:10.2312/evs.20191161. The paper publishes no code;
this is a reimplementation from its text (§3), with the unstated constants chosen here and listed
below. It places one label after the other (priority order) and never moves a placed one. For each
label it evaluates a cost at the positions of a radial grid around the point and takes the
cheapest:

* **search** (§3.2): the label's centre on circles around the point, the radius growing by 30 %
  per ring, 100 angles per ring, 20 rings. *Unstated:* the first radius, here 1/8 of the label
  height (the outermost ring is then 18 label heights out), and which point of the label sits on
  the circle, here its centre (Figure 2 leaves it open);
* **cost** (§3.1, Table 1), a weighted sum of four terms:
  ``C_overlap`` the outliers M (the labeled items' marks, the own one included), the non-outliers
  N\\M (obstacle points) and the placed labels the label covers; ``C_buffer`` the other outliers in
  the label buffer (30 % of the label height around the box) and the outliers, non-outliers and
  placed labels in the leader buffer (here as wide as the label buffer on each side of the leader);
  ``C_distance`` the leader length (point to the box edge on the line to the box centre, px);
  ``C_position`` a label on the inner side of its point (toward the chart centre) on each axis —
  labels go *outward* — and a label outside the chart area. *Unstated:* the weights, here
  ordered as the paper says (overlaps before buffers before leader length):
  ``WEIGHTS`` below;
* **leaders** (§3.1): from the point to the box, on the line to the box centre, drawn when the gap
  exceeds the label buffer.

What the paper does not have is not added: no omission (every label is placed), no leader–leader
or label–leader terms beyond the leader buffer's, no hard constraints (the chart area is a cost).
The benchmark's problems have more than points: polylines, rects, polygons and raster cells reach
the cost as non-outlier points sampled every 4 px (emulation), and those of hard classes weigh
like outliers (the paper tailors weights to the scenario, §5). Item marks count as circles of
their bounding radius. The points under a label are counted on summed-area tables of their
centres (a 1 px grid); the leader-buffer terms, exact, only for candidates that can still win.

    python -m bench.baselines.mumtaz2019_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse
import math
import time

import numpy as np

from ..common import spec
from ..common.geom import Box, GridIndex
from ..common.jsonio import read_json, write_json
from .results import build_result
from .scene import Note, build_scene, choose_cell, polygon_points, ray_exit, sample_polyline

TOOL = "mumtaz2019"
VERSION = "1"
RINGS = 20             # §3.2: 20 iterations
ANGLES = 100           # §3.2: 100 angle steps per radius
GROWTH = 1.3           # §3.2: radius + 30 % per iteration
FIRST_RADIUS = 1 / 8   # unstated: × label height
BUFFER = 0.3           # §3.1: label buffer = 30 % of the label height (leader buffer: the same, unstated)
SAMPLE = 4.0           # px between the points that stand for lines and areas (emulation)
MAX_LABELS = 5000      # beyond this the Python reimplementation takes several minutes ("n/a")

# Unstated in the paper; ordered as §5 says: overlaps first, then buffers, then leader length.
WEIGHTS = {
    "overlap_outlier": 1000.0,   # C_overlap: outliers M covered by the label (the own point included)
    "overlap_point": 100.0,      # C_overlap: non-outliers N\M covered by the label
    "overlap_label": 1000.0,     # C_overlap: placed labels covered by the label
    "buffer_outlier": 100.0,     # C_buffer: other outliers in the label buffer
    "leader_outlier": 300.0,     # C_buffer: other outliers in the leader buffer
    "leader_point": 30.0,        # C_buffer: non-outliers in the leader buffer
    "leader_label": 300.0,       # C_buffer: placed labels meeting the leader buffer
    "distance": 1.0,             # C_distance: per px of leader
    "position": 15.0,            # C_position: per axis on which the label lies toward the chart centre
    "outside": 10000.0,          # C_position: label (partly) outside the chart area
}


def version() -> str | None:
    return VERSION


def available() -> str | None:
    return None  # numpy and scipy, as the benchmark itself


def _points(scene, a_label) -> tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray, list[Note]]:
    """Non-outlier points N\\M: centres, radii and whether their class is hard (weighs like an outlier)."""
    obs = scene.obstacles
    xs, ys, rs, hard = [], [], [], []
    notes: list[Note] = []

    def add(x, y, r, cls):
        xs.append(x)
        ys.append(y)
        rs.append(r)
        hard.append(spec.is_hard(a_label, cls))

    for x, y, r, cls in obs.circles:
        add(x, y, r, cls)
    for pts, width, cls in obs.polylines:
        for x, y in sample_polyline(pts, SAMPLE):
            add(x, y, max(0.5 * width, 0.5), cls)
    for x, y, w, h, cls in obs.rects:
        for px, py in polygon_points([[(x, y), (x + w, y), (x + w, y + h), (x, y + h)]], SAMPLE):
            add(px, py, 0.5 * SAMPLE, cls)
    for rings, cls in obs.polygons:
        for px, py in polygon_points(rings, SAMPLE):
            add(px, py, 0.5 * SAMPLE, cls)
    if obs.masks:
        step = choose_cell(obs.masks)
        for m in obs.masks:
            for x, y, s in m.cells(step):
                add(x + 0.5 * s, y + 0.5 * s, 0.5 * s, m.cls)
    if obs.polylines or obs.rects or obs.polygons or obs.masks:
        notes.append(Note("emulation", "mumtaz2019-points", "the method knows points only: lines, rects, polygons "
                                                             f"and raster cells are non-outlier points every "
                                                             f"{SAMPLE:g} px"))
    if any(hard):
        notes.append(Note("emulation", "mumtaz2019-hard", "points of hard classes weigh like outliers (the "
                                                          "paper tailors the weights to the scenario)"))
    return np.asarray(xs, float), np.asarray(ys, float), np.asarray(rs, float), np.asarray(hard, bool), notes


def _covers(x0, y0, x1, y1, px, py, pr):
    """[candidate, point]: the disk (px, py, pr) meets the box (x0, y0, x1, y1) (open: touching is not covering)."""
    dx = np.maximum(np.maximum(x0[:, None] - px[None, :], px[None, :] - x1[:, None]), 0.0)
    dy = np.maximum(np.maximum(y0[:, None] - py[None, :], py[None, :] - y1[:, None]), 0.0)
    return dx * dx + dy * dy < pr[None, :] ** 2


def _seg_dist(ax, ay, bx, by, px, py):
    """[candidate, point]: distance of each point from each segment a→b."""
    vx, vy = (bx - ax)[:, None], (by - ay)[:, None]
    wx, wy = px[None, :] - ax[:, None], py[None, :] - ay[:, None]
    ll = vx * vx + vy * vy
    t = np.where(ll > 1e-12, np.clip((wx * vx + wy * vy) / np.where(ll > 1e-12, ll, 1.0), 0.0, 1.0), 0.0)
    ex, ey = wx - t * vx, wy - t * vy
    return np.sqrt(ex * ex + ey * ey)


def _seg_box_near(ax, ay, bx, by, boxes: np.ndarray, d: float) -> np.ndarray:
    """[segment, box]: the segment a→b comes within ``d`` of the box (rows x0, y0, x1, y1): it meets
    the box grown by ``d`` (Liang–Barsky)."""
    x0, y0 = boxes[None, :, 0] - d, boxes[None, :, 1] - d
    x1, y1 = boxes[None, :, 2] + d, boxes[None, :, 3] + d
    ax, ay, bx, by = ax[:, None], ay[:, None], bx[:, None], by[:, None]
    dx, dy = bx - ax, by - ay
    t0 = np.zeros(np.broadcast(ax, x0).shape)
    t1 = np.ones_like(t0)
    ok = np.ones(t0.shape, bool)
    for p, q in ((-dx, ax - x0), (dx, x1 - ax), (-dy, ay - y0), (dy, y1 - ay)):
        p, q = np.broadcast_to(p, t0.shape), np.broadcast_to(q, t0.shape)
        par = np.abs(p) < 1e-12
        ok &= ~(par & (q < 0))
        r = np.where(par, 0.0, q / np.where(par, 1.0, p))
        t0 = np.where(~par & (p < 0), np.maximum(t0, r), t0)
        t1 = np.where(~par & (p > 0), np.minimum(t1, r), t1)
    return ok & (t0 <= t1)


class _Counts:
    """Weighted numbers of the disks that meet boxes, by summed-area tables of the disk centres on a
    grid of ``cell`` px (1 px for canvases up to 4096 px), one table per radius (to 0.5 px): a disk
    counts when its centre's cell lies within the box grown by its radius. Radii with fewer than
    ``MIN_TABLE`` disks are tested exactly against the disks near the label."""

    MIN_TABLE = 64

    def __init__(self, x: np.ndarray, y: np.ndarray, r: np.ndarray, wt: np.ndarray, reach: float):
        from scipy.spatial import cKDTree

        self.tables = []
        n = len(x)
        rb = np.round(r * 2.0) / 2.0
        keys, counts = np.unique(rb, return_counts=True) if n else (np.zeros(0), np.zeros(0))
        big = keys[counts >= self.MIN_TABLE]
        self.ox = float(x.min()) - reach - 2.0 if n else 0.0
        self.oy = float(y.min()) - reach - 2.0 if n else 0.0
        w = (float(x.max()) + reach + 2.0 - self.ox) if n else 1.0
        h = (float(y.max()) + reach + 2.0 - self.oy) if n else 1.0
        self.cell = max(1.0, max(w, h) / 4096.0)
        self.cols, self.rows = int(math.ceil(w / self.cell)) + 1, int(math.ceil(h / self.cell)) + 1
        for k in big:
            sel = rb == k
            ix = np.clip(((x[sel] - self.ox) / self.cell).astype(np.int64), 0, self.cols - 1)
            iy = np.clip(((y[sel] - self.oy) / self.cell).astype(np.int64), 0, self.rows - 1)
            sat = np.zeros((self.rows + 1, self.cols + 1))
            np.add.at(sat, (iy + 1, ix + 1), wt[sel])
            self.tables.append((float(k), sat.cumsum(axis=0).cumsum(axis=1)))
        rest = ~np.isin(rb, big)
        self.rx, self.ry, self.rr, self.rw = x[rest], y[rest], r[rest], wt[rest]
        self.tree = cKDTree(np.c_[self.rx, self.ry]) if len(self.rx) else None
        self.rmax = float(self.rr.max()) if len(self.rr) else 0.0

    def _range(self, lo, hi, grow, origin, size):
        a = np.clip(np.floor((lo - grow - origin) / self.cell).astype(np.int64), 0, size)
        b = np.clip(np.floor((hi + grow - origin) / self.cell).astype(np.int64) + 1, 0, size)
        return a, np.maximum(a, b)

    def count(self, x0, y0, x1, y1, grow: float, centre, reach: float) -> np.ndarray:
        out = np.zeros(len(x0))
        for rad, sat in self.tables:
            a0, a1 = self._range(x0, x1, grow + rad, self.ox, self.cols)
            b0, b1 = self._range(y0, y1, grow + rad, self.oy, self.rows)
            out += sat[b1, a1] - sat[b0, a1] - sat[b1, a0] + sat[b0, a0]
        if self.tree is not None:
            near = np.asarray(self.tree.query_ball_point(centre, reach + grow + self.rmax), dtype=np.int64)
            if len(near):
                hit = _covers(x0 - grow, y0 - grow, x1 + grow, y1 + grow, self.rx[near], self.ry[near], self.rr[near])
                out += hit.astype(float) @ self.rw[near]
        return out

    def counts_point(self, x0, y0, x1, y1, grow: float, px: float, py: float, r: float) -> np.ndarray:
        """Whether :meth:`count` counts the disk (px, py, r), per box (the same rule)."""
        rad = round(r * 2.0) / 2.0
        if any(abs(rad - k) < 1e-9 for k, _ in self.tables):
            ix = min(max(int((px - self.ox) / self.cell), 0), self.cols - 1)
            iy = min(max(int((py - self.oy) / self.cell), 0), self.rows - 1)
            a0, a1 = self._range(x0, x1, grow + rad, self.ox, self.cols)
            b0, b1 = self._range(y0, y1, grow + rad, self.oy, self.rows)
            return (a0 <= ix) & (ix < a1) & (b0 <= iy) & (iy < b1)
        return _covers(x0 - grow, y0 - grow, x1 + grow, y1 + grow, np.array([px]), np.array([py]), np.array([r]))[:, 0]


def solve(problem: dict, problem_path=None, options: dict | None = None) -> dict:
    """``options``: ``soft`` (``hard`` or ``ignore``), how soft classes reach the method (``build_scene``)."""
    from scipy.spatial import cKDTree

    from . import Unsupported

    scene = build_scene(problem, problem_path, soft=(options or {}).get("soft", "hard"))
    if len(scene.labels) > MAX_LABELS:
        raise Unsupported(f"{len(scene.labels):,} labels: the reimplementation takes about 25 ms per label "
                          f"in dense problems (at most {MAX_LABELS:,} labels)")
    t0 = time.perf_counter()
    w = WEIGHTS
    a_label = scene.problem.opts.get("avoid", {}).get("label", {})
    px, py, pr, phard, notes = _points(scene, a_label)
    notes.append(Note("unsupported", "mumtaz2019-omission", "the method never omits a label"))
    p_wl = np.where(phard, w["overlap_outlier"], w["overlap_point"])
    p_wb = np.where(phard, w["leader_outlier"], w["leader_point"])
    ptree = cKDTree(np.c_[px, py]) if len(px) else None
    # outliers M: every item's mark, as a circle of its bounding radius
    lab_by_id = {lab.id: lab for lab in scene.labels}
    mark_index = {iid: k for k, (iid, _) in enumerate(scene.marks)}
    mx, my, mr = [], [], []
    for iid, shp in scene.marks:
        b = shp.bbox()
        mx.append(b.cx)
        my.append(b.cy)
        mr.append(lab_by_id[iid].mark_radius if iid in lab_by_id else 0.5 * max(b.w, b.h))
    mx, my, mr = np.asarray(mx, float), np.asarray(my, float), np.asarray(mr, float)
    mtree = cKDTree(np.c_[mx, my]) if len(mx) else None
    max_h = max((lab.h for lab in scene.labels), default=0.0)
    max_w = max((lab.w for lab in scene.labels), default=0.0)
    far = FIRST_RADIUS * max_h * GROWTH ** (RINGS - 1) + math.hypot(max_w, max_h) + max_h
    m_counts = _Counts(mx, my, mr, np.ones(len(mx)), far)
    p_counts = _Counts(px, py, pr, p_wl, far)
    area = scene.area
    ccx, ccy = area.cx, area.cy           # chart centre: "left half", "right half", "top", "bottom"
    angles = 2.0 * math.pi * np.arange(ANGLES) / ANGLES
    cos_a, sin_a = np.cos(angles), np.sin(angles)

    placed = GridIndex(32.0)
    placed_boxes: list[Box] = []
    boxes: dict[str, Box] = {}
    ports: dict[str, tuple[float, float] | None] = {}
    max_pr = float(pr.max()) if len(pr) else 0.0
    max_mr = float(mr.max()) if len(mr) else 0.0

    for lab in scene.labels:
        x, y, lw, lh = lab.x, lab.y, lab.w, lab.h
        own = mark_index[lab.id]
        buf = BUFFER * lh
        radii = FIRST_RADIUS * lh * GROWTH ** np.arange(RINGS)
        cx = (x + radii[:, None] * cos_a[None, :]).ravel()
        cy = (y - radii[:, None] * sin_a[None, :]).ravel()
        x0, x1 = cx - 0.5 * lw, cx + 0.5 * lw
        y0, y1 = cy - 0.5 * lh, cy + 0.5 * lh
        reach = float(radii[-1]) + math.hypot(lw, lh) / 2 + buf
        # leader: from the point to the box edge on the line to the box centre (no leader when the box covers it)
        inside = (x0 <= x) & (x <= x1) & (y0 <= y) & (y <= y1)
        dx, dy = x - cx, y - cy
        tx = np.where(np.abs(dx) > 1e-12, (0.5 * lw) / np.maximum(np.abs(dx), 1e-12), np.inf)
        ty = np.where(np.abs(dy) > 1e-12, (0.5 * lh) / np.maximum(np.abs(dy), 1e-12), np.inf)
        t = np.minimum(np.minimum(tx, ty), 1.0)
        qx, qy = cx + t * dx, cy + t * dy                       # port on the box
        dist = np.where(inside, 0.0, np.hypot(x - qx, y - qy))  # C_distance
        # C_overlap and the label buffer: outliers (own included in the overlap, excluded from the buffer)
        cost = np.zeros(cx.shape)
        if len(mx):
            cov = m_counts.count(x0, y0, x1, y1, 0.0, [x, y], reach)
            grown = m_counts.count(x0, y0, x1, y1, buf, [x, y], reach)
            own_ring = m_counts.counts_point(x0, y0, x1, y1, buf, mx[own], my[own], mr[own]) & \
                ~m_counts.counts_point(x0, y0, x1, y1, 0.0, mx[own], my[own], mr[own])
            cost += w["overlap_outlier"] * cov + w["buffer_outlier"] * (grown - cov - own_ring)
        if len(px):
            cost += p_counts.count(x0, y0, x1, y1, 0.0, [x, y], reach)
        # placed labels covered
        reach_box = Box(x - reach, y - reach, x + reach, y + reach)
        near_l = np.array([[placed_boxes[k].x0, placed_boxes[k].y0, placed_boxes[k].x1, placed_boxes[k].y1]
                           for k in placed.query(reach_box)]).reshape(-1, 4)
        if len(near_l):
            ov = ((np.minimum(x1[:, None], near_l[None, :, 2]) - np.maximum(x0[:, None], near_l[None, :, 0]) > 0)
                  & (np.minimum(y1[:, None], near_l[None, :, 3]) - np.maximum(y0[:, None], near_l[None, :, 1]) > 0))
            cost += w["overlap_label"] * ov.sum(axis=1)
        cost += w["distance"] * dist
        # C_position: outward on each axis (canvas y down), inside the chart area
        cost += w["position"] * (((x < ccx) & (cx > x)) | ((x >= ccx) & (cx < x)))
        cost += w["position"] * (((y < ccy) & (cy > y)) | ((y >= ccy) & (cy < y)))
        outside = (x0 < area.x0) | (x1 > area.x1) | (y0 < area.y0) | (y1 > area.y1)
        cost += w["outside"] * outside
        # leader-buffer terms (≥ 0) only where they can still change the choice: candidates in cost order
        order = np.lexsort((np.arange(cost.size), cost))
        best, best_k = math.inf, -1
        has_leader = ~inside & (dist > 0.0)
        near = np.asarray(mtree.query_ball_point([x, y], reach + max_mr), dtype=np.int64) \
            if mtree is not None else np.zeros(0, np.int64)
        near_p = np.zeros(0, np.int64)
        near_p_done = False
        for s in range(0, order.size, 64):
            chunk = order[s:s + 64]
            if cost[chunk[0]] >= best:
                break
            extra = np.zeros(chunk.size)
            lc = chunk[has_leader[chunk]]
            if lc.size:
                sel = has_leader[chunk]
                ax_, ay_ = np.full(lc.size, x), np.full(lc.size, y)
                bx_, by_ = qx[lc], qy[lc]
                e = np.zeros(lc.size)
                # only the points near the chunk's leaders
                lx0, lx1 = min(x, float(bx_.min())) - buf, max(x, float(bx_.max())) + buf
                ly0, ly1 = min(y, float(by_.min())) - buf, max(y, float(by_.max())) + buf
                if len(near):
                    others = near[(near != own) & (mx[near] + mr[near] > lx0) & (mx[near] - mr[near] < lx1)
                                  & (my[near] + mr[near] > ly0) & (my[near] - mr[near] < ly1)]
                    if others.size:
                        dd = _seg_dist(ax_, ay_, bx_, by_, mx[others], my[others])
                        e += w["leader_outlier"] * (dd < buf + mr[others][None, :]).sum(axis=1)
                if not near_p_done and ptree is not None:
                    near_p = np.asarray(ptree.query_ball_point([x, y], reach + max_pr), dtype=np.int64)
                    near_p_done = True
                if near_p.size:
                    loc = near_p[(px[near_p] + pr[near_p] > lx0) & (px[near_p] - pr[near_p] < lx1)
                                 & (py[near_p] + pr[near_p] > ly0) & (py[near_p] - pr[near_p] < ly1)]
                    if loc.size:
                        dd = _seg_dist(ax_, ay_, bx_, by_, px[loc], py[loc])
                        e += (dd < buf + pr[loc][None, :]).astype(float) @ p_wb[loc]
                if len(near_l):
                    nl = near_l[(near_l[:, 2] > lx0) & (near_l[:, 0] < lx1) & (near_l[:, 3] > ly0) & (near_l[:, 1] < ly1)]
                    if len(nl):
                        e += w["leader_label"] * _seg_box_near(ax_, ay_, bx_, by_, nl, buf).sum(axis=1)
                extra[sel] = e
            tot = cost[chunk] + extra
            j = int(np.argmin(tot))
            if tot[j] < best:
                best, best_k = float(tot[j]), int(chunk[j])
        k = best_k
        box = Box(float(x0[k]), float(y0[k]), float(x1[k]), float(y1[k]))
        placed.insert(len(placed_boxes), box)
        placed_boxes.append(box)
        boxes[lab.id] = box
        gap = float(dist[k]) - lab.mark_radius
        ports[lab.id] = (float(qx[k]), float(qy[k])) if not inside[k] and gap > buf else None
    runtime = (time.perf_counter() - t0) * 1000.0
    for lab in scene.labels:  # the port the leader ends at, exactly on the box
        if ports.get(lab.id) is not None:
            b = boxes[lab.id]
            ports[lab.id] = ray_exit(b, (b.cx, b.cy), (lab.x, lab.y))
    return build_result(scene, boxes, ports, runtime, f"{TOOL}/{VERSION}", notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--soft", choices=("hard", "ignore"), default="hard")
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem, {"soft": a.soft}), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
