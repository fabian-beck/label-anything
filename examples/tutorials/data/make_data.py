"""Data of the tutorials (docs/tutorials/): a scatter chart as PNG and as SVG, its outliers
as CSV and as a problem JSON, and one small raster per raster mode. Deterministic and
standard library only.

    python3 examples/tutorials/data/make_data.py           # (re)write the files
    python3 examples/tutorials/data/make_data.py --check   # verify the committed files

``--check`` compares text files byte for byte and PNGs by their decoded pixels (the
compressed bytes depend on the zlib build).
"""

from __future__ import annotations

import argparse
import json
import math
import random
import struct
import sys
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent

# ---------------------------------------------------------------------------------------
# A tiny anti-aliased RGBA rasterizer and PNG codec
# ---------------------------------------------------------------------------------------


def hex_rgb(c: str) -> tuple[int, int, int]:
    c = c.lstrip("#")
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16)


class Image:
    """RGBA8 pixels with straight alpha; shapes are composited with "source over"."""

    def __init__(self, w: int, h: int, bg: tuple[int, int, int, int] = (255, 255, 255, 255)):
        self.w, self.h = w, h
        self.px = bytearray(bytes(bg) * (w * h))

    def blend(self, x: int, y: int, rgb: tuple[int, int, int], a: float) -> None:
        if a <= 0 or not (0 <= x < self.w and 0 <= y < self.h):
            return
        a = min(a, 1.0)
        i = (y * self.w + x) * 4
        da = self.px[i + 3] / 255
        oa = a + da * (1 - a)
        for c in range(3):
            v = (rgb[c] * a + self.px[i + c] * da * (1 - a)) / oa
            self.px[i + c] = int(v + 0.5)
        self.px[i + 3] = int(oa * 255 + 0.5)

    def fill(self, cov, x0: float, y0: float, x1: float, y1: float, color: str, alpha: float = 1.0, aa: bool = True) -> None:
        """Paint pixels of the box [x0, x1) x [y0, y1) with coverage ``cov(cx, cy)``."""
        rgb = hex_rgb(color)
        for y in range(max(0, int(y0)), min(self.h, int(math.ceil(y1)) + 1)):
            for x in range(max(0, int(x0)), min(self.w, int(math.ceil(x1)) + 1)):
                c = cov(x + 0.5, y + 0.5)
                if not aa:
                    c = 1.0 if c >= 0.5 else 0.0
                self.blend(x, y, rgb, c * alpha)

    def disc(self, cx: float, cy: float, r: float, color: str, alpha: float = 1.0, aa: bool = True) -> None:
        def cov(x: float, y: float) -> float:
            return min(1.0, max(0.0, r + 0.5 - math.hypot(x - cx, y - cy)))

        self.fill(cov, cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1, color, alpha, aa)

    def ellipse(self, cx: float, cy: float, rx: float, ry: float, color: str, alpha: float = 1.0, aa: bool = True) -> None:
        def cov(x: float, y: float) -> float:
            inside = 0
            for sy in range(4):
                for sx in range(4):
                    dx = (x - 0.5 + (2 * sx + 1) / 8 - cx) / rx
                    dy = (y - 0.5 + (2 * sy + 1) / 8 - cy) / ry
                    inside += dx * dx + dy * dy <= 1
            return inside / 16

        self.fill(cov, cx - rx - 1, cy - ry - 1, cx + rx + 1, cy + ry + 1, color, alpha, aa)

    def rect(self, x0: float, y0: float, x1: float, y1: float, color: str, alpha: float = 1.0, aa: bool = True) -> None:
        def cov(x: float, y: float) -> float:
            ox = max(0.0, min(x + 0.5, x1) - max(x - 0.5, x0))
            oy = max(0.0, min(y + 0.5, y1) - max(y - 0.5, y0))
            return ox * oy

        self.fill(cov, x0 - 1, y0 - 1, x1 + 1, y1 + 1, color, alpha, aa)

    def line(self, pts: list[tuple[float, float]], width: float, color: str, alpha: float = 1.0, aa: bool = True) -> None:
        """A polyline of capsules (round joins and caps); pixels take the maximum coverage."""
        hw = width / 2
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        segs = list(zip(pts, pts[1:]))

        def cov(x: float, y: float) -> float:
            d = min(seg_dist(x, y, a, b) for a, b in segs)
            return min(1.0, max(0.0, hw + 0.5 - d))

        self.fill(cov, min(xs) - hw - 1, min(ys) - hw - 1, max(xs) + hw + 1, max(ys) + hw + 1, color, alpha, aa)

    def raw(self) -> bytes:
        return bytes(self.px)

    def png(self) -> bytes:
        rows = b"".join(b"\x00" + bytes(self.px[y * self.w * 4 : (y + 1) * self.w * 4]) for y in range(self.h))

        def chunk(tag: bytes, data: bytes) -> bytes:
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        ihdr = struct.pack(">IIBBBBB", self.w, self.h, 8, 6, 0, 0, 0)
        return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b"")


def seg_dist(x: float, y: float, a: tuple[float, float], b: tuple[float, float]) -> float:
    vx, vy = b[0] - a[0], b[1] - a[1]
    wx, wy = x - a[0], y - a[1]
    vv = vx * vx + vy * vy
    t = 0.0 if vv == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / vv))
    return math.hypot(wx - t * vx, wy - t * vy)


def png_pixels(data: bytes) -> bytes:
    """Decoded RGBA of a PNG written by :meth:`Image.png` (filter 0 on every row)."""
    pos, idat, w, h = 8, b"", 0, 0
    while pos < len(data):
        (n,) = struct.unpack(">I", data[pos : pos + 4])
        tag, body = data[pos + 4 : pos + 8], data[pos + 8 : pos + 8 + n]
        if tag == b"IHDR":
            w, h = struct.unpack(">II", body[:8])
        elif tag == b"IDAT":
            idat += body
        pos += 12 + n
    raw = zlib.decompress(idat)
    stride = w * 4 + 1
    return b"".join(raw[y * stride + 1 : (y + 1) * stride] for y in range(h))


# ---------------------------------------------------------------------------------------
# The scatter chart: 300 classes of a code base, size vs coupling (synthetic)
# ---------------------------------------------------------------------------------------

W, H = 800, 600
PLOT = (70, 40, 770, 540)  # x0, y0, x1, y1 of the plot area
WORDS = ["Invoice", "Session", "Cache", "Parser", "Account", "Stream", "Token", "Layout",
         "Queue", "Index", "Policy", "Socket", "Report", "Ledger", "Widget", "Router",
         "Order", "Price", "Search", "Upload", "Event", "Schema", "Font", "Image",
         "Theme", "Locale", "Backup", "Audit", "Badge", "Cart", "Coupon", "Draft",
         "Feed", "Grid", "Inbox", "Job", "Map", "Note", "Profile", "Ticket"]
ROLES = ["Service", "Manager", "Factory", "Handler", "Store", "Builder", "Client", "View"]
N_POINTS, N_OUTLIERS = 300, 20


def scatter_data() -> tuple[list[tuple[float, float]], list[int], list[str]]:
    """Point positions in canvas px, the indices of the outliers, and a name per point."""
    rng = random.Random(2026)
    cx, cy = 400.0, 300.0
    pts = []
    while len(pts) < N_POINTS:
        u, v = rng.gauss(0, 1), rng.gauss(0, 1)
        if rng.random() < 0.06:  # a few far away
            u, v = u * 2.6, v * 2.6
        x = cx + 110 * u
        y = cy - 70 * (0.75 * u + 0.66 * v)
        if PLOT[0] + 8 < x < PLOT[2] - 8 and PLOT[1] + 8 < y < PLOT[3] - 8:
            pts.append((round(x, 1), round(y, 1)))
    # Mahalanobis-like distance from the center with the generating covariance
    def dist(p: tuple[float, float]) -> float:
        u = (p[0] - cx) / 110
        v = ((cy - p[1]) / 70 - 0.75 * u) / 0.66
        return u * u + v * v

    order = sorted(range(len(pts)), key=lambda i: (-dist(pts[i]), i))
    outliers = sorted(order[:N_OUTLIERS])
    combos = [w + r for w in WORDS for r in ROLES]
    rng.shuffle(combos)
    return pts, outliers, combos[: len(pts)]


def trend_line() -> list[tuple[float, float]]:
    # least squares by hand would be overkill: the generating slope is known
    return [(PLOT[0] + 10, 300 + 0.477 * (400 - PLOT[0] - 10)), (PLOT[2] - 10, 300 - 0.477 * (PLOT[2] - 10 - 400))]


def scatter_png(pts: list[tuple[float, float]], outliers: list[int]) -> Image:
    img = Image(W, H)
    x0, y0, x1, y1 = PLOT
    for k in range(8):  # light grid
        gx = x0 + k * 100
        img.line([(gx, y0), (gx, y1)], 1, "#e6e9ed")
    for k in range(6):
        gy = y1 - k * 100
        img.line([(x0, gy), (x1, gy)], 1, "#e6e9ed")
    img.line([(x0, y1), (x1, y1)], 1.5, "#4a5560")  # axes
    img.line([(x0, y0), (x0, y1)], 1.5, "#4a5560")
    for k in range(8):
        img.line([(x0 + k * 100, y1), (x0 + k * 100, y1 + 6)], 1.5, "#4a5560")
    for k in range(6):
        img.line([(x0 - 6, y1 - k * 100), (x0, y1 - k * 100)], 1.5, "#4a5560")
    img.line(trend_line(), 2, "#d1495b")
    out = set(outliers)
    for i, (x, y) in enumerate(pts):
        img.disc(x, y, 3, "#2f5d8a" if i in out else "#9aa5b1")
    return img


def scatter_svg(pts: list[tuple[float, float]], outliers: list[int], names: list[str]) -> str:
    x0, y0, x1, y1 = PLOT
    out = set(outliers)
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}" font-family="sans-serif">',
         f'  <rect id="background" width="{W}" height="{H}" fill="white"/>',
         f'  <text class="title" x="{x0}" y="26" font-size="16">Classes by size and coupling</text>',
         '  <g class="grid" stroke="#e6e9ed">']
    o += [f'    <line x1="{x0 + k * 100}" y1="{y0}" x2="{x0 + k * 100}" y2="{y1}"/>' for k in range(8)]
    o += [f'    <line x1="{x0}" y1="{y1 - k * 100}" x2="{x1}" y2="{y1 - k * 100}"/>' for k in range(6)]
    o += ['  </g>', '  <g class="axis" stroke="#4a5560" stroke-width="1.5">',
          f'    <line x1="{x0}" y1="{y1}" x2="{x1}" y2="{y1}"/>', f'    <line x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}"/>']
    o += [f'    <line x1="{x0 + k * 100}" y1="{y1}" x2="{x0 + k * 100}" y2="{y1 + 6}"/>' for k in range(8)]
    o += [f'    <line x1="{x0 - 6}" y1="{y1 - k * 100}" x2="{x0}" y2="{y1 - k * 100}"/>' for k in range(6)]
    o += ['  </g>', '  <g class="ticks" font-size="11" fill="#4a5560">']
    o += [f'    <text x="{x0 + k * 100}" y="{y1 + 20}" text-anchor="middle">{k * 100}</text>' for k in range(8)]
    o += [f'    <text x="{x0 - 10}" y="{y1 - k * 100 + 4}" text-anchor="end">{k * 10}</text>' for k in range(6)]
    o += ['  </g>',
          f'  <text class="axis-title" x="{(x0 + x1) // 2}" y="{H - 8}" font-size="12" text-anchor="middle">Lines of code</text>']
    (ax, ay), (bx, by) = trend_line()
    o.append(f'  <path class="trend" d="M{ax:.1f} {ay:.1f} L{bx:.1f} {by:.1f}" fill="none" stroke="#d1495b" stroke-width="2"/>')
    o.append('  <g class="points" fill="#9aa5b1">')
    o += [f'    <circle class="point" cx="{x}" cy="{y}" r="3"/>' for i, (x, y) in enumerate(pts) if i not in out]
    o.append('  </g>')
    o.append('  <g class="outliers" fill="#2f5d8a">')
    o += [f'    <circle class="point outlier" id="o{k}" cx="{pts[i][0]}" cy="{pts[i][1]}" r="3"><title>{names[i]}</title></circle>'
          for k, i in enumerate(outliers)]
    o.append('  </g>')
    o += ['  <g class="legend" transform="translate(600 52)">',
          '    <rect width="150" height="46" fill="white" stroke="#c9ced4"/>',
          '    <circle cx="14" cy="15" r="3" fill="#9aa5b1"/><text x="24" y="19" font-size="11">class</text>',
          '    <circle cx="14" cy="32" r="3" fill="#2f5d8a"/><text x="24" y="36" font-size="11">outlier</text>',
          '  </g>', '</svg>', '']
    return "\n".join(o)


def outliers_csv(pts: list[tuple[float, float]], outliers: list[int], names: list[str]) -> str:
    rows = ["id,x,y,name"] + [f"o{k},{pts[i][0]},{pts[i][1]},{names[i]}" for k, i in enumerate(outliers)]
    return "\n".join(rows) + "\n"


def outliers_problem(pts: list[tuple[float, float]], outliers: list[int], names: list[str]) -> str:
    """The problem the five-line programs build: preset, raster background, one item per
    outlier (one item per line, so that the docs can show the head of the file)."""
    head = ['{', '  "preset": "scatter",', '  "obstacles": { "raster": { "source": "scatter.png" } },', '  "items": [']
    items = [
        f'    {{ "anchor": {{ "type": "point", "x": {pts[i][0]}, "y": {pts[i][1]} }}, "label": {{ "type": "text", "text": "{names[i]}" }} }}'
        for i in outliers
    ]
    return "\n".join(head + [",\n".join(items), "  ]", "}", ""])


def points_csv(pts: list[tuple[float, float]], names: list[str]) -> str:
    rows = ["x,y,name"] + [f"{x},{y},{n}" for (x, y), n in zip(pts, names)]
    return "\n".join(rows) + "\n"


# ---------------------------------------------------------------------------------------
# One raster per raster mode (480 x 320)
# ---------------------------------------------------------------------------------------

RW, RH = 480, 320


def density_png(pts: list[tuple[float, float]]) -> Image:
    """``cost`` mode: a point density, dark = dense (the scatter data scaled to 480 x 320)."""
    img = Image(RW, RH)
    s = RW / W
    sp = [(x * s, y * s) for x, y in pts]
    grid = [[0.0] * RW for _ in range(RH)]
    sigma = 14.0
    for (px, py) in sp:
        for y in range(max(0, int(py - 3 * sigma)), min(RH, int(py + 3 * sigma) + 1)):
            dy = (y + 0.5 - py) ** 2
            row = grid[y]
            for x in range(max(0, int(px - 3 * sigma)), min(RW, int(px + 3 * sigma) + 1)):
                row[x] += math.exp(-((x + 0.5 - px) ** 2 + dy) / (2 * sigma * sigma))
    peak = max(max(r) for r in grid)
    for y in range(RH):
        for x in range(RW):
            v = int(255 - 215 * min(1.0, grid[y][x] / peak) ** 0.8 + 0.5)
            i = (y * RW + x) * 4
            img.px[i : i + 4] = bytes((v, v, v, 255))
    return img


def overlay_png() -> Image:
    """``alpha`` mode: a transparent layer (a route and a callout box) over nothing."""
    img = Image(RW, RH, (0, 0, 0, 0))
    route = [(30, 280), (120, 230), (190, 250), (260, 170), (330, 150), (400, 80), (455, 60)]
    img.line(route, 6, "#e07a1f", 0.85)
    img.rect(300, 220, 460, 300, "#ffffff", 0.95)
    img.rect(300, 220, 460, 223, "#e07a1f")
    for k in range(4):
        img.line([(312, 238 + k * 15), (440 - k * 25, 238 + k * 15)], 4, "#7a8794")
    return img


MAP_COLORS = {"land": "#f2efe9", "water": "#9cc3e6", "park": "#bfe0a8", "road": "#8f8f8f"}


def map_png() -> Image:
    """``classmap`` mode: flat palette colours, no anti-aliasing."""
    img = Image(RW, RH, hex_rgb(MAP_COLORS["land"]) + (255,))
    img.ellipse(360, 90, 70, 45, MAP_COLORS["water"], aa=False)
    river = [(-10, 250), (80, 230), (160, 245), (240, 210), (300, 150), (330, 110)]
    img.line(river, 16, MAP_COLORS["water"], aa=False)
    img.ellipse(110, 110, 60, 38, MAP_COLORS["park"], aa=False)
    img.rect(300, 230, 420, 290, MAP_COLORS["park"], aa=False)
    for road in ([(0, 170), (480, 170)], [(220, 0), (220, 320)], [(0, 40), (150, 40), (260, 300)]):
        img.line(road, 5, MAP_COLORS["road"], aa=False)
    return img


def photo_png() -> Image:
    """``saliency`` mode: a smooth sky (low saliency) over a detailed skyline (high)."""
    img = Image(RW, RH)
    for y in range(RH):  # vertical gradient sky
        t = y / RH
        c = (int(250 - 60 * t), int(214 - 40 * t), int(160 + 50 * t))
        for x in range(RW):
            i = (y * RW + x) * 4
            img.px[i : i + 4] = bytes(c + (255,))
    img.disc(380, 70, 28, "#fff4c2")
    rng = random.Random(7)
    x = 0
    while x < RW:  # buildings with windows
        bw = rng.randint(24, 56)
        top = rng.randint(150, 250)
        img.rect(x, top, x + bw - 2, RH, "#3b3f5c")
        for wy in range(top + 8, RH - 10, 12):
            for wx in range(x + 5, x + bw - 8, 9):
                if rng.random() < 0.55:
                    img.rect(wx, wy, wx + 4, wy + 6, "#ffd36e")
        x += bw
    return img


# ---------------------------------------------------------------------------------------


def outputs() -> dict[str, object]:
    pts, outliers, names = scatter_data()
    return {
        "scatter.png": scatter_png(pts, outliers),
        "scatter.svg": scatter_svg(pts, outliers, names),
        "outliers.csv": outliers_csv(pts, outliers, names),
        "outliers.json": outliers_problem(pts, outliers, names),
        "points.csv": points_csv(pts, names),
        "density.png": density_png(pts),
        "overlay.png": overlay_png(),
        "map.png": map_png(),
        "photo.png": photo_png(),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="verify instead of writing")
    args = ap.parse_args()
    stale = []
    for name, data in outputs().items():
        path = HERE / name
        if args.check:
            if not path.exists():
                stale.append(name)
            elif isinstance(data, Image):
                if png_pixels(path.read_bytes()) != data.raw():
                    stale.append(name)
            elif path.read_text(encoding="utf-8") != data:
                stale.append(name)
        else:
            if isinstance(data, Image):
                path.write_bytes(data.png())
            else:
                path.write_text(str(data), encoding="utf-8", newline="\n")
            print(f"wrote {path.relative_to(HERE.parent.parent.parent)}")
    if stale:
        print("stale tutorial data (run examples/tutorials/data/make_data.py):", ", ".join(stale), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
