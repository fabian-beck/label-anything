#!/usr/bin/env python3
"""Generate conformance/raster: deterministic test images and `raster` cases.

1. Paints the test images (pure Python, see pngenc.py; no Pillow needed) and writes them
   to conformance/raster/images/ (each well below 50 KB).
2. Asks the Rust reference implementation for the expected results
   (`cargo run --release -p label-anything-raster --example raster_oracle`).
3. Writes one JSON file per case to conformance/raster/ (format: README.md there).

Usage (from the repository root):
    python3 tools/raster/make_conformance.py           regenerate everything
    python3 tools/raster/make_conformance.py --check   exit 1 if any file would change

The TypeScript package must reproduce every expected coverage array byte for byte.
"""
import base64
import json
import math
import struct
import subprocess
import sys
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import pngenc as P  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "conformance" / "raster"
IMAGES = OUT / "images"
MAX_IMAGE_BYTES = 50 * 1024
INLINE_COVERAGE_CELLS = 4096


# ---------------------------------------------------------------------------------------
# Deterministic painting (straight-alpha RGBA in 0..255 floats, 4x4 supersampling)
# ---------------------------------------------------------------------------------------

class Lcg:
    """Small deterministic PRNG (numerical recipes LCG)."""

    def __init__(self, seed):
        self.state = seed & 0xFFFFFFFF

    def next(self):
        self.state = (self.state * 1664525 + 1013904223) & 0xFFFFFFFF
        return self.state

    def uniform(self):
        return self.next() / 2**32


class Canvas:
    def __init__(self, w, h, bg):
        self.w, self.h = w, h
        self.px = [[list(map(float, bg)) for _ in range(w)] for _ in range(h)]

    def blend(self, x, y, color, cov):
        r, g, b, a = color
        sa = a / 255.0 * cov
        if sa <= 0:
            return
        d = self.px[y][x]
        da = d[3] / 255.0
        oa = sa + da * (1 - sa)
        for k, c in enumerate((r, g, b)):
            d[k] = (c * sa + d[k] * da * (1 - sa)) / oa if oa > 0 else 0.0
        d[3] = oa * 255.0

    def shape(self, inside, color, bbox=None, ss=4):
        x0, y0, x1, y1 = bbox or (0, 0, self.w, self.h)
        for y in range(max(0, int(math.floor(y0))), min(self.h, int(math.ceil(y1)))):
            for x in range(max(0, int(math.floor(x0))), min(self.w, int(math.ceil(x1)))):
                n = 0
                for sy in range(ss):
                    for sx in range(ss):
                        if inside(x + (sx + 0.5) / ss, y + (sy + 0.5) / ss):
                            n += 1
                if n:
                    self.blend(x, y, color, n / (ss * ss))

    def capsule(self, ax, ay, bx, by, r, color):
        def inside(x, y):
            dx, dy = bx - ax, by - ay
            t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
            ex, ey = x - (ax + t * dx), y - (ay + t * dy)
            return ex * ex + ey * ey <= r * r
        self.shape(inside, color, (min(ax, bx) - r - 1, min(ay, by) - r - 1, max(ax, bx) + r + 1, max(ay, by) + r + 1))

    def disc(self, cx, cy, r, color):
        self.shape(lambda x, y: (x - cx) ** 2 + (y - cy) ** 2 <= r * r, color, (cx - r - 1, cy - r - 1, cx + r + 1, cy + r + 1))

    def rect(self, x0, y0, x1, y1, color):
        self.shape(lambda x, y: x0 <= x < x1 and y0 <= y < y1, color, (x0 - 1, y0 - 1, x1 + 1, y1 + 1))

    def rgba8(self, x, y):
        return tuple(min(255, max(0, int(math.floor(c + 0.5)))) for c in self.px[y][x])

    def rgb8(self, x, y):
        return self.rgba8(x, y)[:3]


def fnv1a32(data: bytes) -> str:
    h = 0x811C9DC5
    for b in data:
        h = ((h ^ b) * 0x01000193) & 0xFFFFFFFF
    return f"{h:08x}"


# ---------------------------------------------------------------------------------------
# Test images
# ---------------------------------------------------------------------------------------

def strokes_canvas():
    c = Canvas(64, 40, (250, 250, 248, 255))
    c.rect(2, 22, 18, 36, (232, 232, 230, 255))  # faint panel: below the ink threshold
    c.rect(44, 2, 60, 12, (180, 180, 180, 255))  # mid grey: ink
    c.capsule(4, 4, 60, 30, 0.6, (60, 60, 70, 255))
    c.capsule(10, 36, 54, 6, 1.25, (30, 30, 30, 255))
    c.disc(20, 14, 6, (40, 90, 200, 255))
    for i, (x, w) in enumerate([(40, 3), (44, 2), (47, 4), (52, 3), (56, 2)]):
        c.rect(x, 30 + (i % 2), x + w, 36, (10, 10, 10, 255))
    return c


def alpha_canvas():
    c = Canvas(48, 32, (255, 0, 255, 0))  # transparent magenta: colour must not leak
    c.rect(4, 4, 20, 14, (220, 30, 30, 255))
    c.disc(30, 12, 8, (20, 160, 60, 100))
    c.capsule(2, 26, 44, 18, 0.9, (0, 0, 0, 255))
    for x in range(48):
        for y in range(28, 32):
            c.px[y][x] = [40.0, 40.0, 160.0, x * 255.0 / 47]
    return c


MAP_PALETTE = [
    (245, 240, 225),  # 0 background
    (120, 170, 220),  # 1 water
    (220, 60, 50),  # 2 roads
    (120, 190, 110),  # 3 parks
    (20, 20, 20),  # 4 text
    (222, 62, 52),  # 5 roads, slightly different
    (150, 60, 170),  # 6 unmatched purple
    (128, 128, 128),  # 7 grey (ignored)
    (120, 170, 220),  # 8 water, half transparent
    (0, 0, 0),  # 9 fully transparent
]
MAP_TRNS = bytes([255] * 8 + [128, 0])


def map_index(x, y):
    if (x - 30) ** 2 + (y - 22) ** 2 < 10:
        return 9
    if 12 <= y <= 15 and x < 38:
        return 1 if x % 9 else 8
    if abs(x - y - 2) <= 1:
        return 2 if (x // 4) % 2 else 5
    if 26 <= x <= 36 and 2 <= y <= 9:
        return 3
    if 3 <= x <= 9 and 22 <= y <= 27 and (x + y) % 3:
        return 4
    if 32 <= x <= 38 and 24 <= y <= 28:
        return 6
    if 2 <= x <= 6 and 2 <= y <= 6:
        return 7
    return 0


def photo_canvas():
    rng = Lcg(2026)
    c = Canvas(64, 48, (0, 0, 0, 255))
    for y in range(48):
        for x in range(64):
            n = (rng.uniform() - 0.5) * 36
            c.px[y][x] = [
                min(255.0, max(0.0, 90 + 2.2 * x + n)),
                min(255.0, max(0.0, 60 + 3.1 * y + 0.7 * n)),
                min(255.0, max(0.0, 200 - 1.5 * x - y + n)),
                255.0,
            ]
    c.disc(40, 20, 9, (250, 240, 200, 255))
    c.rect(6, 30, 22, 44, (20, 30, 20, 255))
    c.capsule(0, 47, 63, 33, 1.0, (255, 255, 255, 255))
    return c


def small_rgb(x, y):
    return ((x * 37 + y * 11) % 256, (x * 5 + y * 71) % 256, (x * y * 13 + 40) % 256)


def gray16_value(x, y):
    # Rounding boundaries of (v + 128) div 257 on row 0, a gradient elsewhere.
    if y == 0:
        k = x // 3 + 1
        return min(65535, 257 * k + 127 + x % 3)
    return (x * 2731 + y * 4099) % 65536


def build_images():
    imgs = {}
    sc = strokes_canvas()
    imgs["strokes-rgb8.png"] = P.encode(64, 40, 2, 8, sc.rgb8)
    ac = alpha_canvas()
    imgs["alpha-rgba8.png"] = P.encode(48, 32, 6, 8, ac.rgba8, filters=(4, 4, 1, 2, 3, 0))
    imgs["map-p4.png"] = P.encode(40, 30, 3, 4, lambda x, y: (map_index(x, y),), palette=MAP_PALETTE, trns=MAP_TRNS)
    pc = photo_canvas()
    imgs["photo-rgb8.png"] = P.encode(64, 48, 2, 8, pc.rgb8, filters=(1, 2, 3, 4))
    # Palette and low bit depths.
    imgs["p1-odd-width.png"] = P.encode(17, 9, 3, 1, lambda x, y: (1 if (x * x + y * 3) % 7 < 3 else 0,),
                                        palette=[(250, 250, 250), (30, 40, 50)])
    imgs["p2-interlaced.png"] = P.encode(19, 13, 3, 2, lambda x, y: ((x // 3 + y // 2) % 4,),
                                         palette=[(255, 255, 255), (200, 30, 30), (30, 30, 200), (0, 0, 0)],
                                         trns=b"\xff\x80", interlace=True)
    imgs["p8-out-of-range.png"] = P.encode(12, 6, 3, 8, lambda x, y: ((x + 2 * y) % 8,),
                                           palette=[(255, 255, 255), (250, 0, 0), (0, 250, 0), (0, 0, 250), (90, 90, 90)],
                                           trns=b"\xff\xc0\x40")
    imgs["g1.png"] = P.encode(9, 5, 0, 1, lambda x, y: ((x + y) % 3 == 0 and 1 or 0,))
    imgs["g2.png"] = P.encode(11, 6, 0, 2, lambda x, y: ((x + y) % 4,))
    imgs["g4-trns.png"] = P.encode(13, 7, 0, 4, lambda x, y: ((3 * x + y) % 16,), trns=P.trns_gray(5))
    imgs["g8.png"] = P.encode(16, 8, 0, 8, lambda x, y: ((x * 17 + y * 29) % 256,))
    imgs["g16-trns.png"] = P.encode(24, 12, 0, 16, lambda x, y: (gray16_value(x, y),), trns=P.trns_gray(gray16_value(5, 3)))
    imgs["ga8.png"] = P.encode(10, 10, 4, 8, lambda x, y: ((x * 25) % 256, (y * 28) % 256))
    imgs["ga16.png"] = P.encode(10, 10, 4, 16, lambda x, y: ((x * 6553 + 127) % 65536, (y * 7281 + 128) % 65536))
    rgb16 = lambda x, y: ((x * 3277 + 128) % 65536, (y * 6000 + 64) % 65536, ((x + y) * 1999) % 65536)  # noqa: E731
    imgs["rgb16-trns.png"] = P.encode(20, 10, 2, 16, rgb16, trns=P.trns_rgb(*rgb16(7, 4)))
    imgs["rgb8-trns.png"] = P.encode(14, 6, 2, 8, small_rgb, trns=P.trns_rgb(*small_rgb(3, 2)))
    imgs["rgba16.png"] = P.encode(16, 12, 6, 16, lambda x, y: (x * 4000 + 255, y * 5000 + 129, 30000, (x + y) * 2400 + 1))
    imgs["rgba8-interlaced.png"] = P.encode(37, 23, 6, 8, lambda x, y: (*small_rgb(x, y), (x * 7 + y * 13) % 256),
                                            interlace=True)
    imgs["interlaced-3x2.png"] = P.encode(3, 2, 2, 8, small_rgb, interlace=True)
    imgs["interlaced-1x1.png"] = P.encode(1, 1, 0, 8, lambda x, y: (77,), interlace=True)
    imgs["g16-interlaced.png"] = P.encode(13, 9, 0, 16, lambda x, y: (gray16_value(x, y),), interlace=True)
    # The same pixels with different deflate block types and chunk layouts.
    variant = lambda **kw: P.encode(30, 20, 2, 8, small_rgb, **kw)  # noqa: E731
    imgs["deflate-dynamic.png"] = variant()
    imgs["deflate-stored.png"] = variant(deflate_kind="stored", parts=4)
    imgs["deflate-fixed.png"] = variant(deflate_kind="fixed")
    imgs["deflate-mixed.png"] = variant(deflate_kind="mixed", parts=5)
    imgs["chunks-split-ancillary.png"] = variant(
        idat_size=7,
        before_plte=[(b"gAMA", struct.pack(">I", 45455)), (b"sRGB", b"\x00"), (b"laNy", b"unknown ancillary")],
        before_idat=[(b"pHYs", struct.pack(">IIB", 2835, 2835, 1)), (b"tEXt", b"Comment\x00bad crc", 0x12345678),
                     (b"tRNS", b"\x00\x01")],  # too short for RGB: ignored
        after_idat=[(b"tEXt", b"After\x00idat"), (b"zzZz", b"ignored")],
    )
    # Background estimation.
    def bg_tie(x, y):
        border = x in (0, 5) or y in (0, 3)
        if border:
            return (200, 40, 40) if (x + y) % 2 else (40, 40, 200)
        return (10, 200, 10)
    imgs["bg-tie.png"] = P.encode(6, 4, 2, 8, bg_tie)

    def bg_alpha(x, y):
        border = x in (0, 7) or y in (0, 5)
        if not border:
            return (0, 0, 0, 255)
        i = (y * 8 + x) % 11
        if i < 3:
            return (90, 120, 150, 200)  # counted (3 pixels per 11)
        if i < 5:
            return (250, 10, 10, 128)  # counted, alpha exactly 128
        if i < 8:
            return (10, 250, 10, 127)  # skipped
        return (10, 10, 250, 0)  # skipped
    imgs["bg-alpha-border.png"] = P.encode(8, 6, 6, 8, bg_alpha)
    imgs["bg-transparent.png"] = P.encode(4, 4, 6, 8, lambda x, y: (200, 0, 0, 255) if 0 < x < 3 and 0 < y < 3 else (0, 200, 0, 100))
    # Corrupt and limit cases.
    base = P.encode_chunks(8, 6, 2, 8, small_rgb)
    ihdr, idat = base[0], base[1]
    imgs["corrupt-signature.png"] = P.serialize(base, signature=b"\x89PNH\r\n\x1a\n")
    imgs["corrupt-ihdr-crc.png"] = P.serialize([(ihdr[0], ihdr[1], P.crc(*ihdr) ^ 1)] + base[1:])
    imgs["corrupt-idat-crc.png"] = P.serialize([ihdr, (idat[0], idat[1], P.crc(*idat) ^ 0x100)] + base[2:])
    imgs["corrupt-truncated.png"] = P.serialize(base)[: 8 + 25 + 8 + len(idat[1]) // 2]
    imgs["corrupt-no-iend.png"] = P.serialize(base[:-1])
    imgs["corrupt-zlib-header.png"] = P.serialize([ihdr, (b"IDAT", b"\x78\x9a" + idat[1][2:])] + base[2:])
    raw = P.raw_scanlines(8, 6, 2, 8, small_rgb, filters=(0, 1, 5))
    imgs["corrupt-filter-type.png"] = P.serialize([ihdr, (b"IDAT", zlib.compress(raw))] + base[2:])
    imgs["corrupt-deflate-block.png"] = P.serialize([ihdr, (b"IDAT", b"\x78\x01\x07\x00\x00")] + base[2:])
    short = zlib.compress(P.raw_scanlines(8, 5, 2, 8, small_rgb))
    imgs["corrupt-missing-rows.png"] = P.serialize([ihdr, (b"IDAT", short)] + base[2:])
    pal = P.encode_chunks(4, 4, 3, 8, lambda x, y: ((x + y) % 2,), palette=[(0, 0, 0), (255, 255, 255)])
    imgs["corrupt-plte-length.png"] = P.serialize([pal[0], (b"PLTE", b"\x00\x00\x00\xff")] + pal[2:])
    imgs["corrupt-no-plte.png"] = P.serialize([pal[0]] + pal[2:])
    imgs["corrupt-zero-width.png"] = P.serialize([(b"IHDR", struct.pack(">IIBBBBB", 0, 6, 8, 2, 0, 0, 0))] + base[1:])
    imgs["corrupt-bit-depth.png"] = P.serialize([(b"IHDR", struct.pack(">IIBBBBB", 8, 6, 4, 2, 0, 0, 0))] + base[1:])
    imgs["corrupt-no-idat.png"] = P.serialize([ihdr, base[-1]])
    imgs["corrupt-unknown-critical.png"] = P.serialize([ihdr, (b"CRIT", b"\x00")] + base[1:])
    imgs["limit-exceeded.png"] = P.serialize([(b"IHDR", struct.pack(">IIBBBBB", 20000, 20000, 8, 2, 0, 0, 0))] + base[1:])
    return imgs


# ---------------------------------------------------------------------------------------
# Cases
# ---------------------------------------------------------------------------------------

def ink(background=None, threshold=0.12, dilate=1):
    return {"kind": "ink", "background": background, "threshold": threshold, "dilate": dilate}


def alpha(threshold=0.1):
    return {"kind": "alpha", "threshold": threshold}


def cost(invert=False):
    return {"kind": "cost", "invert": invert}


def saliency():
    return {"kind": "saliency"}


def classmap(palette, tolerance=0.08, unmatched_ink=True, background=None, ink_threshold=0.12):
    return {"kind": "classmap", "palette": palette, "tolerance": tolerance, "unmatched_ink": unmatched_ink,
            "background": background, "ink_threshold": ink_threshold}


def run(name, mode, grid, scale=1, offset=(0, 0), cls=None):
    cols, rows, cell = grid[:3]
    origin = grid[3] if len(grid) > 3 else (0, 0)
    r = {"name": name, "mode": mode}
    if mode["kind"] != "classmap":
        r["class"] = cls or {"ink": "ink", "alpha": "ink", "cost": "cost", "saliency": "salient"}[mode["kind"]]
    r["placement"] = {"scale": scale, "offset": list(offset)}
    r["grid"] = {"origin": list(origin), "cell": cell, "cols": cols, "rows": rows}
    return r


def case(stem, name, image, runs=(), **extra):
    c = {"kind": "raster", "name": name}
    if image is not None:
        c["image"] = image
    c.update(extra)
    if runs:
        c["runs"] = list(runs)
    return stem, c


def file_image(n):
    return {"file": f"images/{n}"}


MAP_CLASSES = [["#78aadc", "water"], ["#dc3c32", "roads"], ["#78be6e", "parks"], ["#141414", "text"], ["#808080", "ignore"]]


def rgba_inline(w, h, pixels):
    return {"rgba": {"width": w, "height": h, "data": base64.b64encode(bytes(v for p in pixels for v in p)).decode()}}


def build_cases(imgs):
    cases = []
    add = cases.append
    add(case("ink-strokes", "ink: anti-aliased strokes; scales 1, 2, 0.5, 3; offsets; dilation 0-2; non-integer cells",
             file_image("strokes-rgb8.png"), [
                 run("defaults (auto background, threshold 0.12, dilate 1), cell 2", ink(), (32, 20, 2)),
                 run("dilate 0, cell 1.5, grid larger than the raster", ink(dilate=0), (43, 27, 1.5)),
                 run("HiDPI scale 2, explicit background, threshold 0.3, dilate 2, fractional offset",
                     ink("#fafaf8", 0.3, 2), (40, 22, 1), 2, (3.25, -1.5)),
                 run("scale 0.5 (pixels larger than cells), negative offset, cell 3", ink(dilate=1), (40, 30, 3), 0.5, (-7, 5)),
                 run("scale 3, cell 0.75, grid origin (-1, -1)", ink(threshold=0.05, dilate=0), (40, 30, 0.75, (-1, -1)), 3),
                 run("alpha on an opaque image", alpha(), (32, 20, 2)),
             ]))
    add(case("cost-saliency", "cost and saliency: strokes and a photo-like image",
             file_image("photo-rgb8.png"), [
                 run("cost, cell 2", cost(), (32, 24, 2)),
                 run("cost inverted, scale 1.5, cell 2.5, offset (1, 2)", cost(True), (28, 22, 2.5), 1.5, (1, 2)),
                 run("saliency, cell 2", saliency(), (32, 24, 2)),
                 run("saliency, scale 0.5, cell 3, origin (2, 2)", saliency(), (44, 33, 3, (2, 2)), 0.5),
                 run("saliency, cell 0.5 (checksum + samples)", saliency(), (128, 96, 0.5)),
                 run("ink, threshold 0.05", ink(threshold=0.05, dilate=1), (32, 24, 2)),
             ]))
    add(case("cost-strokes", "cost and saliency on near-white line art",
             file_image("strokes-rgb8.png"), [
                 run("cost", cost(), (32, 20, 2)),
                 run("saliency", saliency(), (32, 20, 2)),
             ]))
    add(case("alpha-transparency", "alpha and ink with transparency (straight alpha, colour of transparent pixels ignored)",
             file_image("alpha-rgba8.png"), [
                 run("alpha 0.1, cell 2", alpha(0.1), (24, 16, 2)),
                 run("alpha 0.5, scale 2, cell 1, offset (0.5, 0.5)", alpha(0.5), (25, 17, 1), 2, (0.5, 0.5)),
                 run("ink, auto background from the (mostly transparent) border", ink(), (24, 16, 2)),
                 run("ink over an explicit black background", ink("#000000", 0.12, 0), (24, 16, 2)),
                 run("cost over white", cost(), (24, 16, 2)),
                 run("saliency", saliency(), (24, 16, 2)),
                 run("classmap red/green", classmap([["#dc1e1e", "roads"], ["#14a03c", "parks"]], 0.1), (24, 16, 2)),
             ]))
    add(case("classmap-map", "classmap on a 4-bit palette map with tRNS (partially and fully transparent entries)",
             file_image("map-p4.png"), [
                 run("map classes, 'ignore' entry, unmatched -> ink", classmap(MAP_CLASSES), (20, 15, 2)),
                 run("unmatched ignored, tolerance 0.3, scale 2, offset (1, 1), cell 1",
                     classmap(MAP_CLASSES, 0.3, False), (22, 17, 1), 2, (1, 1)),
                 run("explicit background, ink threshold 0.5", classmap(MAP_CLASSES, 0.08, True, "#f5f0e1", 0.5), (20, 15, 2)),
                 run("ink on the palette image, dilate 3, cell 1", ink(dilate=3), (40, 30, 1)),
                 run("alpha 0.5 from tRNS", alpha(0.5), (20, 15, 2)),
             ]))
    add(case("classmap-ties", "classmap tolerance ties: identical palette colours go to the first entry",
             file_image("map-p4.png"), [
                 run("#dc3c32 listed twice: roads first", classmap([["#dc3c32", "roads"], ["#dc3c32", "rivers"], ["#de3e34", "streets"]]),
                     (20, 15, 2)),
                 run("#dc3c32 listed twice: rivers first", classmap([["#dc3c32", "rivers"], ["#dc3c32", "roads"], ["#de3e34", "streets"]]),
                     (20, 15, 2)),
                 run("duplicate colour never wins, a near colour loses to the exact one, 'ink' as a palette class",
                     classmap([["#141414", "ink"], ["#808080", "grey"], ["#888", "grey2"], ["#808080", "grey3"]], 0.03), (20, 15, 2)),
                 run("tolerance 0: exact palette colours only", classmap(MAP_CLASSES, 0.0), (20, 15, 2)),
                 run("everything ignored", classmap([["#78aadc", "ignore"]], 1.0, False), (20, 15, 2)),
             ]))
    add(case("background-tie", "background estimation: equal border counts -> smallest quantized colour",
             file_image("bg-tie.png"), [run("ink with the estimated background", ink(dilate=0), (6, 4, 1))]))
    add(case("background-alpha", "background estimation skips border pixels with alpha < 128",
             file_image("bg-alpha-border.png"), [run("ink with the estimated background", ink(dilate=0), (8, 6, 1))]))
    add(case("background-white", "background estimation without opaque border pixels -> white",
             file_image("bg-transparent.png"), [run("ink", ink(dilate=0), (4, 4, 1))]))
    decode_only = [
        ("p1-odd-width.png", "1-bit palette, odd width"),
        ("p2-interlaced.png", "2-bit palette, Adam7, tRNS"),
        ("p8-out-of-range.png", "8-bit palette, indices beyond PLTE (opaque black), short tRNS"),
        ("g1.png", "1-bit grey"),
        ("g2.png", "2-bit grey"),
        ("g4-trns.png", "4-bit grey with tRNS"),
        ("g8.png", "8-bit grey"),
        ("g16-trns.png", "16-bit grey with tRNS and (v + 128) div 257 rounding boundaries"),
        ("ga8.png", "8-bit grey + alpha"),
        ("ga16.png", "16-bit grey + alpha"),
        ("rgb8-trns.png", "8-bit RGB with tRNS"),
        ("rgb16-trns.png", "16-bit RGB with tRNS"),
        ("rgba16.png", "16-bit RGBA"),
        ("rgba8-interlaced.png", "8-bit RGBA, Adam7"),
        ("interlaced-3x2.png", "Adam7 with empty passes (3x2)"),
        ("interlaced-1x1.png", "Adam7 1x1"),
        ("g16-interlaced.png", "16-bit grey, Adam7"),
    ]
    for f, what in decode_only:
        stem = "decode-" + f[:-4]
        add(case(stem, f"decode: {what}", file_image(f), [
            run("ink, cell 1", ink(dilate=0), (8, 8, 1)),
            run("cost, scale 2, cell 1", cost(), (6, 6, 1), 2),
            run("alpha 0.5, cell 2", alpha(0.5), (6, 6, 2)),
        ]))
    for f in ["deflate-dynamic.png", "deflate-stored.png", "deflate-fixed.png", "deflate-mixed.png", "chunks-split-ancillary.png"]:
        add(case("decode-" + f[:-4], f"decode: {f[:-4]} (identical pixels in every variant)", file_image(f),
                 [run("ink", ink(dilate=0), (15, 10, 2))]))
    errors = [
        ("corrupt-signature.png", "unknown signature"),
        ("corrupt-ihdr-crc.png", "IHDR CRC mismatch"),
        ("corrupt-idat-crc.png", "IDAT CRC mismatch"),
        ("corrupt-truncated.png", "file truncated inside IDAT"),
        ("corrupt-no-iend.png", "file ends right after the last IDAT chunk"),
        ("corrupt-zlib-header.png", "bad zlib header"),
        ("corrupt-filter-type.png", "filter type 5"),
        ("corrupt-deflate-block.png", "deflate block type 3"),
        ("corrupt-missing-rows.png", "image data ends early"),
        ("corrupt-plte-length.png", "PLTE length not a multiple of 3"),
        ("corrupt-no-plte.png", "indexed image without PLTE"),
        ("corrupt-zero-width.png", "zero width"),
        ("corrupt-bit-depth.png", "bit depth 4 for RGB"),
        ("corrupt-no-idat.png", "IEND without IDAT"),
        ("corrupt-unknown-critical.png", "unknown critical chunk"),
        ("limit-exceeded.png", "20000 x 20000 RGB exceeds the 512 MiB limit"),
    ]
    for f, what in errors:
        add(case("error-" + f[:-4], f"decode error: {what}", file_image(f)))
    tiny = imgs["interlaced-3x2.png"]
    add(case("source-data-url", "data: URL (base64)", {"source": "data:image/png;base64," + base64.b64encode(tiny).decode()},
             [run("cost", cost(), (3, 2, 1))]))
    add(case("source-data-url-percent", "data: URL (percent-encoded, upper-case prefix)",
             {"source": "  DATA:image/png," + "".join(f"%{b:02X}" if b < 0x21 or b > 0x7e or chr(b) in "%,#" else chr(b) for b in tiny)},
             [run("cost", cost(), (3, 2, 1))]))
    b64 = base64.b64encode(tiny).decode()
    add(case("source-bare-base64", "bare base64 with line breaks, URL-safe alphabet, no padding",
             {"base64": "\n".join(b64[i:i + 16] for i in range(0, len(b64), 16)).replace("+", "-").replace("/", "_").rstrip("=")},
             [run("cost", cost(), (3, 2, 1))]))
    add(case("error-data-url", "invalid data: URL (no comma)", {"source": "data:image/png;base64"}))
    add(case("error-base64", "invalid base64", {"base64": "iVBORw0KGgo$"}))
    add(case("error-rgba-length", "raw RGBA with the wrong length", {"rgba": {"width": 2, "height": 2, "data": "AAAAAAAA"}}))
    raw_px = [
        (255, 255, 255, 255), (0, 0, 0, 255), (255, 0, 0, 128), (0, 255, 0, 64), (0, 0, 255, 0),
        (10, 20, 30, 255), (200, 200, 200, 255), (128, 128, 128, 1), (255, 255, 0, 254), (0, 255, 255, 127),
        (90, 60, 30, 255), (255, 255, 255, 0), (30, 30, 30, 200), (240, 240, 240, 255), (0, 0, 0, 0),
    ]
    add(case("raw-rgba", "raw RGBA (rgba.data base64): every mode, odd sizes",
             rgba_inline(5, 3, raw_px), [
                 run("ink, explicit white background", ink("#ffffff", 0.12, 0), (5, 3, 1)),
                 run("ink, scale 2, dilate 1", ink(None, 0.12, 1), (3, 2, 1), 2),
                 run("alpha 0.25", alpha(0.25), (5, 3, 1)),
                 run("cost", cost(), (5, 3, 1)),
                 run("cost inverted, cell 2", cost(True), (3, 2, 2)),
                 run("saliency", saliency(), (5, 3, 1)),
                 run("classmap", classmap([["#ff0000", "red"], ["#0a141e", "dark"]], 0.2), (5, 3, 1)),
             ]))
    geo_px = [((x * 50) % 256, (y * 80) % 256, 100, 255) for y in range(4) for x in range(6)]
    add(case("geometry", "placement and grid edge cases", rgba_inline(6, 4, geo_px), [
        run("raster entirely outside the grid", cost(), (4, 4, 1), 1, (100, 100)),
        run("raster partially left of and above the grid", cost(), (6, 4, 1), 1, (-2.5, -1.25)),
        run("one cell covering everything", cost(), (1, 1, 50, (-10, -10))),
        run("huge cell: tiny coverage quantizes to 1", alpha(), (2, 2, 1000)),
        run("zero columns", cost(), (0, 3, 1)),
        run("scale 0 is invalid: zero coverage", cost(), (3, 3, 1), 0),
        run("negative scale is invalid: zero coverage", alpha(), (3, 3, 1), -1),
        run("scale 1/3", cost(), (20, 14, 1), 0.3333333333333333, (0.1, 0.2)),
        run("scale 7, cell 0.3, origin 0.1", cost(), (20, 14, 0.3, (0.1, 0.1)), 7),
        run("cell 0.1 at origin (0.05, 0.05)", alpha(), (64, 44, 0.1, (0.05, 0.05))),
        run("classmap without classes", classmap([], 0.1, False), (6, 4, 1)),
        run("dilation larger than the grid", ink("#000000", 0.0, 50), (6, 4, 1)),
    ]))
    colors = [[0, 0, 0], [255, 255, 255], [255, 0, 0], [0, 255, 0], [0, 0, 255], [128, 128, 128], [1, 1, 1],
              [10, 11, 12], [254, 254, 254], [250, 250, 248], [120, 170, 220], [220, 60, 50], [99, 7, 201]]
    rng = Lcg(7)
    colors += [[rng.next() >> 24, rng.next() >> 24, rng.next() >> 24] for _ in range(20)]
    hexes = ["#000", "#fff", "#FfF", "#1a2B3c", "#808080", "#abc", "", "#", "#ab", "#abcd", "#abcde", "#abcdef0",
             "#ggg", " #abc", "#abc ", "abc", "#12345g"]
    b64s = ["", "TWFu", "TWE=", "TQ==", "TQ", " T W\nF u\r\n", "-_-_", "+/+/", "T", "TQ=", "TQ===", "TQ==TQ==",
            "TWFu=", "TW*u", "TWFuT", "é", "AA\u000cAA"]
    add(case("colors", "OKLab conversion, hex colours and base64 (exact values)", None,
             oklab=[{"rgb": c} for c in colors], hex=[{"input": h} for h in hexes], base64=[{"input": s} for s in b64s]))
    return cases


# ---------------------------------------------------------------------------------------
# Oracle and output
# ---------------------------------------------------------------------------------------

def check_numbers(value, where):
    """Case inputs must parse exactly with serde_json's default (non-`float_roundtrip`) float
    parser: an integer significand below 2^53 and a decimal exponent of at most 22."""
    if isinstance(value, dict):
        for k, v in value.items():
            check_numbers(v, f"{where}/{k}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            check_numbers(v, f"{where}/{i}")
    elif isinstance(value, float):
        text = repr(value)
        mantissa, _, exp = text.lower().partition("e")
        digits = mantissa.replace("-", "").replace(".", "").lstrip("0") or "0"
        frac = len(mantissa.partition(".")[2]) if "." in mantissa else 0
        exponent = (int(exp) if exp else 0) - frac
        assert int(digits) < 2**53 and abs(exponent) <= 22, f"{where}: {text} does not parse exactly everywhere"


def call_oracle(cases):
    request = {"dir": str(OUT), "cases": [c for _, c in cases]}
    cmd = ["cargo", "run", "--quiet", "--release", "-p", "label-anything-raster", "--example", "raster_oracle"]
    res = subprocess.run(cmd, cwd=ROOT / "rust", input=json.dumps(request), capture_output=True, text=True)
    if res.returncode != 0:
        sys.stderr.write(res.stderr)
        raise SystemExit("raster_oracle failed")
    return json.loads(res.stdout)["cases"]


def samples(cov, cols, rows):
    """A few deterministic cells: corners, centre, first non-zero and maximum."""
    picks = [(0, 0), (cols - 1, 0), (0, rows - 1), (cols - 1, rows - 1), (cols // 2, rows // 2)]
    nz = next((i for i, v in enumerate(cov) if v), None)
    if nz is not None:
        picks.append((nz % cols, nz // cols))
        m = max(range(len(cov)), key=lambda i: (cov[i], -i))
        picks.append((m % cols, m // cols))
    out = []
    for x, y in picks:
        cell = [x, y, cov[y * cols + x]]
        if cell not in out:
            out.append(cell)
    return out


def finish(stem, c, result):
    out = {"kind": c["kind"], "name": c["name"]}
    if c.get("image") is not None:
        out["image"] = c["image"]
        out["decode"] = result["decode"] if "error" in result["decode"] else {
            "width": result["decode"]["width"], "height": result["decode"]["height"],
            "rgba_fnv1a32": result["decode"]["rgba_fnv1a32"]}
        if result.get("background") is not None:
            out["background"] = result["background"]
    if "runs" in c:
        if "error" in result["decode"]:
            raise SystemExit(f"{stem}: runs on an image that fails to decode")
        out["runs"] = []
        for r, got in zip(c["runs"], result["runs"]):
            g = r["grid"]
            expect = []
            for e in got:
                cov = base64.b64decode(e["coverage"])
                assert len(cov) == g["cols"] * g["rows"], (stem, r["name"])
                x = {"class": e["class"], "fnv1a32": fnv1a32(cov), "sum": sum(cov), "nonzero": sum(1 for v in cov if v)}
                if len(cov) <= INLINE_COVERAGE_CELLS:
                    x["coverage"] = e["coverage"]
                else:
                    x["samples"] = samples(cov, g["cols"], g["rows"])
                expect.append(x)
            out["runs"].append(dict(r, expect=expect))
    for key in ("oklab", "hex", "base64"):
        if key in c:
            items = []
            for item, got in zip(c[key], result[key]):
                d = dict(item)
                if key == "oklab":
                    d["lab"] = got
                    d["lab_bits"] = [struct.pack(">d", v).hex() for v in got]
                elif key == "hex":
                    d["rgb"] = got
                else:
                    d.update(got)
                items.append(d)
            out[key] = items
    return out


def render(obj) -> str:
    """JSON with one run / list entry per line group, stable and diff-friendly."""
    return json.dumps(obj, indent=2, ensure_ascii=False) + "\n"


def main() -> int:
    check = "--check" in sys.argv[1:]
    imgs = build_images()
    for name, data in imgs.items():
        assert len(data) <= MAX_IMAGE_BYTES, (name, len(data))
    files = {IMAGES / n: d for n, d in imgs.items()}
    if not check:
        IMAGES.mkdir(parents=True, exist_ok=True)
        for path, data in files.items():
            if not path.exists() or path.read_bytes() != data:
                path.write_bytes(data)
    else:
        stale = [p for p, d in files.items() if not p.exists() or p.read_bytes() != d]
        if stale:
            for p in stale:
                print(f"stale: {p.relative_to(ROOT)}", file=sys.stderr)
            return 1
    cases = build_cases(imgs)
    for stem, c in cases:
        check_numbers(c, stem)
    results = call_oracle(cases)
    variants = {r["decode"].get("rgba_fnv1a32") for (stem, _), r in zip(cases, results)
                if stem.startswith("decode-deflate") or stem == "decode-chunks-split-ancillary"}
    assert len(variants) == 1, f"deflate/chunk variants decode differently: {variants}"
    written = {}
    for (stem, c), r in zip(cases, results):
        written[OUT / f"{stem}.json"] = render(finish(stem, c, r))
    stale = False
    for path, text in written.items():
        old = path.read_text(encoding="utf-8") if path.exists() else None
        if old != text:
            stale = True
            if check:
                print(f"stale: {path.relative_to(ROOT)}", file=sys.stderr)
            else:
                path.write_text(text, encoding="utf-8", newline="\n")
    known = set(written) | {OUT / "README.md"}
    extra = [p for p in OUT.glob("*.json") if p not in known]
    for p in extra:
        print(f"{'stale' if check else 'removing'}: {p.relative_to(ROOT)}", file=sys.stderr)
        if not check:
            p.unlink()
    extra_images = [p for p in IMAGES.glob("*") if p not in files]
    for p in extra_images:
        print(f"{'stale' if check else 'removing'}: {p.relative_to(ROOT)}", file=sys.stderr)
        if not check:
            p.unlink()
    if check:
        return 1 if (stale or extra or extra_images) else 0
    print(f"make_conformance: {len(written)} cases, {len(files)} images in {OUT.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
