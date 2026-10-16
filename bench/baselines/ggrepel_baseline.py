"""ggrepel baseline (K. Slowikowski, GPL-3; R): ``geom_text_repel``, positions read after ``grid.force()``.

ggrepel computes the repelled positions at draw time (``makeContent``), so the
adapter renders the plot on a device of fixed size and reads the final text grob
positions back (method: bench/baselines/ggrepel.R). Translation:

* rows: the labels in priority order (anchor, text, font size, a point size
  matching the mark radius), then the obstacle points with empty labels — every
  item's mark that is not labeled, obstacle circles (their radius), rects, polygon
  outlines and interiors, polylines (sampled points; emulation), raster cells
  (cell centres; emulation). Samples are spaced by half the smallest label
  height (a label crossing a line overlaps about two samples, which matters for
  ``max.overlaps``), coarser (doubling) when more than ``POINT_BUDGET`` points
  would result; obstacle circles are never thinned,
* composite labels: the text part prefixed with spaces as wide as the icon part
  (emulation), so the text extent covers the whole label box,
* font: the bundled Noto Sans, registered for the R process through a private
  fontconfig file (``FONTCONFIG_FILE``),
* reported box: the problem's label box centred on ggrepel's text position
  (hjust = vjust = 0.5); ``box.padding`` is chosen so that ggrepel's own box
  contains it. A segment drawn by ggrepel becomes a leader from the mark to the
  point where the segment enters the reported box.

    python -m bench.baselines.ggrepel_baseline problem.json -o result.json
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

from ..common import paths
from ..common import text as textmod
from ..common.geom import Box
from ..common.jsonio import read_json, write_json
from .results import build_result
from .scene import Note, Scene, build_scene, nearest_on_box, polygon_points, sample_polyline, segment_entry

TOOL = "ggrepel"
HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "ggrepel.R"
PINS = {"ggrepel": "0.9.5", "ggplot2": "3.4.4", "jsonlite": "1.8.8"}   # bench/baselines/install-r.sh
RES = 288          # device dpi: 4 device px per canvas px
SEED = 1
MAX_ITER = 10000   # ggrepel's default
MAX_TIME = 60.0    # s; generous so that MAX_ITER binds (ggrepel's default is 0.5 s)
MAX_OVERLAPS = 10  # ggrepel's default
POINT_BUDGET = 8000
TIMEOUT = 1800.0
FAMILY = "Noto Sans"
_VERSIONS: dict | None = None


def _rscript() -> str | None:
    return shutil.which("Rscript")


def _installed_versions() -> dict | None:
    global _VERSIONS
    if _VERSIONS is None:
        rs = _rscript()
        if rs is None:
            return None
        code = ("for (p in c('ggrepel','ggplot2','jsonlite')) cat(p, if (requireNamespace(p, quietly=TRUE)) "
                "as.character(packageVersion(p)) else 'missing', '\\n')")
        try:
            r = subprocess.run([rs, "-e", code], capture_output=True, text=True, timeout=120)
        except (OSError, subprocess.SubprocessError):
            return None
        _VERSIONS = dict(line.split() for line in r.stdout.splitlines() if len(line.split()) == 2)
    return _VERSIONS


def version() -> str | None:
    v = _installed_versions() or {}
    return v.get("ggrepel")


def available() -> str | None:
    if _rscript() is None:
        return "Rscript is not on PATH (install R, then bench/baselines/install-r.sh)"
    v = _installed_versions()
    if v is None:
        return "cannot run Rscript"
    missing = [p for p in PINS if v.get(p, "missing") == "missing"]
    if missing:
        return "R packages missing: " + ", ".join(missing) + " (bench/baselines/install-r.sh)"
    return None


def _fontconfig(tmp: Path) -> tuple[Path, str | None]:
    """A fontconfig file that adds the bundled Noto Sans; returns it and the file fc-match resolves."""
    fdir = tmp / "fonts"
    fdir.mkdir()
    for f in ("NotoSans-Regular.ttf", "NotoSans-Bold.ttf"):
        shutil.copyfile(paths.FONTS / f, fdir / f)
    conf = tmp / "fonts.conf"
    conf.write_text('<?xml version="1.0"?>\n<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">\n'
                    "<fontconfig>\n  <include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>\n"
                    f"  <dir>{fdir}</dir>\n  <cachedir>{tmp / 'fc-cache'}</cachedir>\n</fontconfig>\n",
                    encoding="utf-8")
    matched = None
    fc = shutil.which("fc-match")
    if fc:
        try:
            matched = subprocess.run([fc, "-f", "%{file}", FAMILY], capture_output=True, text=True, timeout=60,
                                     env={**os.environ, "FONTCONFIG_FILE": str(conf)}).stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            matched = None
    return conf, matched


def _label_text(lab) -> str:
    """Text handed to ggrepel; composites get leading spaces as wide as their non-text parts."""
    spec = lab.item.label
    if spec.kind != "composite":
        return lab.text
    f = textmod.font(lab.font_weight)
    tw = f.width(lab.text, lab.font_size)
    space = max(f.width(" ", lab.font_size), 1e-6)
    extra = (lab.w - 2 * spec.padding) - tw
    return " " * max(0, int(round(extra / space))) + lab.text


def scene_json(scene: Scene) -> tuple[dict, list[Note]]:
    H = scene.height
    notes: list[Note] = []
    labels = [{"id": lab.id, "x": lab.x, "y": H - lab.y, "text": _label_text(lab), "size": lab.font_size,
               "face": 2 if lab.font_weight >= 550 else 1, "w": lab.w, "h": lab.h, "r": lab.mark_radius}
              for lab in scene.labels]
    labeled = {lab.id for lab in scene.labels}
    fixed: list[tuple[float, float, float]] = []
    for iid, shp in scene.marks:
        if iid not in labeled:
            b = shp.bbox()
            fixed.append((b.cx, b.cy, 0.5 * max(b.w, b.h)))
    obs = scene.obstacles
    fixed += [(x, y, r) for x, y, r, _c in obs.circles]
    base = max(2.0, 0.5 * min((lab.h for lab in scene.labels), default=4.0))
    step = base
    pts: list[tuple[float, float, float]] = []
    for step in (base, 2 * base, 4 * base, 8 * base):
        pts = []
        for pl, w, _c in obs.polylines:
            pts += [(x, y, w / 2) for x, y in sample_polyline(pl, step)]
        for x, y, w, h, _c in obs.rects:
            pts += [(px, py, step / 2) for px, py in polygon_points([[(x, y), (x + w, y), (x + w, y + h),
                                                                       (x, y + h)]], step)]
        for rings, _c in obs.polygons:
            pts += [(px, py, step / 2) for px, py in polygon_points(rings, step)]
        cell = max(4.0, 2.0 * step)
        for m in obs.masks:
            pts += [(x0 + s / 2, y0 + s / 2, s / 2) for x0, y0, s in m.cells(cell)]
        if len(pts) <= POINT_BUDGET:
            break
    if pts:
        notes.append(Note("emulation", "ggrepel-points", f"{len(pts)} obstacle points sampled every {step:g} px "
                                                         "from lines, rect / polygon areas and raster cells "
                                                         "(ggrepel repels from data points only)"))
    points = [{"x": x, "y": H - y, "r": r} for x, y, r in fixed + pts]
    a = scene.area
    off = scene.labels[0].offset if scene.labels else 0.0
    return ({"width": scene.width, "height": H, "res": RES, "family": FAMILY,
             "area": [a.x0, H - a.y1, a.x1, H - a.y0], "labels": labels, "points": points, "seed": SEED,
             "max_iter": MAX_ITER, "max_time": MAX_TIME, "max_overlaps": MAX_OVERLAPS, "point_padding": off},
            notes)


def solve(problem: dict, problem_path=None) -> dict:
    scene = build_scene(problem, problem_path)
    js, notes = scene_json(scene)
    H = scene.height
    with tempfile.TemporaryDirectory(prefix="la-ggrepel-") as d:
        tmp = Path(d)
        conf, matched = _fontconfig(tmp)
        if matched is not None and Path(matched).name not in ("NotoSans-Regular.ttf", "NotoSans-Bold.ttf"):
            notes.append(Note("emulation", "ggrepel-font", f"fontconfig resolved {FAMILY!r} to {matched}"))
        sp, op = tmp / "scene.json", tmp / "out.json"
        sp.write_text(json.dumps(js), encoding="utf-8")
        env = {**os.environ, "FONTCONFIG_FILE": str(conf), "R_DEFAULT_DEVICE": "png"}
        r = subprocess.run([_rscript() or "Rscript", "--vanilla", str(SCRIPT), str(sp), str(op)], capture_output=True,
                           text=True, timeout=TIMEOUT, env=env, cwd=d)
        if r.returncode != 0:
            raise RuntimeError(f"ggrepel.R failed ({r.returncode}): {r.stderr.strip()[-800:]}")
        out = json.loads(op.read_text(encoding="utf-8"))
    boxes, ports = {}, {}
    segs = {int(s["i"]): s for s in out.get("segments", [])}
    for e in out.get("labels", []):
        i = int(e["i"])
        if not 1 <= i <= len(scene.labels):
            continue
        lab = scene.labels[i - 1]
        cx, cy = float(e["x"]), H - float(e["y"])
        box = Box(cx - lab.w / 2, cy - lab.h / 2, cx + lab.w / 2, cy + lab.h / 2)
        boxes[lab.id] = box
        s = segs.get(i)
        if s is not None:
            text_end = (float(s["x1"]), H - float(s["y1"]))
            point_end = (float(s["x2"]), H - float(s["y2"]))
            ports[lab.id] = segment_entry(box, point_end, text_end) or nearest_on_box(box, text_end)
    v = out.get("versions", {})
    for pkg, pin in PINS.items():
        if v.get(pkg) and v[pkg] != pin:
            notes.append(Note("emulation", f"ggrepel-version:{pkg}", f"{pkg} {v[pkg]} installed, benchmark pins "
                                                                     f"{pin}"))
    if out.get("runtime_ms", 0.0) >= 0.95 * MAX_TIME * 1000.0:
        notes.append(Note("emulation", "ggrepel-time", f"max.time ({MAX_TIME:g} s) reached before max.iter: the "
                                                       "result depends on machine speed"))
    notes.append(Note("emulation", "ggrepel-box", f"box.padding = {out.get('box_padding', 0):.2f} px (smallest value "
                                                  "whose ggrepel boxes contain every label box)"))
    impl = f"ggrepel/{v.get('ggrepel')} (ggplot2 {v.get('ggplot2')}, R {v.get('R')})"
    return build_result(scene, boxes, ports, float(out.get("runtime_ms", 0.0)), impl, notes)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("problem")
    ap.add_argument("-o", "--out", required=True)
    a = ap.parse_args(argv)
    write_json(a.out, solve(read_json(a.problem), a.problem), nd=3)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
