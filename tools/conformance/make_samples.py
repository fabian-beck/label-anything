#!/usr/bin/env python3
"""Writes conformance/problems/*.json and conformance/validate/*.json.

The JSON files are the canonical test inputs; this script documents how they were made
(and builds the tiny PNG used by raster-ink.json). Run: python3 tools/conformance/make_samples.py
"""
import base64
import json
import math
import struct
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PROB = ROOT / "conformance" / "problems"
VAL = ROOT / "conformance" / "validate"


def png_rgba(w, h, pixel):
    raw = b"".join(b"\x00" + b"".join(bytes(pixel(x, y)) for x in range(w)) for y in range(h))

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def pt(i, x, y, text, **kw):
    item = {"id": i, "anchor": {"type": "point", "x": x, "y": y}, "label": {"type": "text", "text": text}}
    item.update(kw)
    return item


def lcg(seed):
    s = seed
    while True:
        s = (s * 1103515245 + 12345) % (2 ** 31)
        yield s / 2 ** 31


def scatter_points(n, seed, w=800, h=600, margin=40):
    r = lcg(seed)
    return [[round(margin + next(r) * (w - 2 * margin), 1), round(margin + next(r) * (h - 2 * margin), 1)] for _ in range(n)]


problems = {}

problems["minimal"] = {
    "items": [pt("a", 100, 100, "Alpha"), pt("b", 108, 104, "Beta"), pt("c", 300, 220, "Gamma")]
}

bg = scatter_points(300, 7)
problems["scatter-basic"] = {
    "version": "1",
    "canvas": {"width": 800, "height": 600},
    "preset": "scatter",
    "items": [pt(f"p{i}", x, y, f"Point {i}") for i, (x, y) in enumerate(scatter_points(20, 3))],
    "obstacles": {"vector": [{"class": "points", "points": bg, "r": 2.5}]},
}

out = scatter_points(12, 11)
problems["outliers-hard"] = {
    "canvas": {"width": 800, "height": 600},
    "items": [pt(f"o{i}", x, y, f"Outlier {i}", anchor={"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": 3}}) for i, (x, y) in enumerate(out)],
    "obstacles": {"vector": [
        {"class": "points", "points": scatter_points(500, 5), "r": 2},
        {"class": "outliers", "circles": [[x + 30, y + 10, 3] for x, y in scatter_points(10, 13)]},
        {"class": "axes", "rects": [[30, 560, 740, 1], [30, 20, 1, 540]]},
    ]},
    "avoid": {"label": {"outliers": "hard", "points": 0.3, "axes": "hard"}, "leader": {"outliers": "hard"}},
}

problems["shapes-nodes"] = {
    "canvas": {"width": 600, "height": 400},
    "preset": "graph",
    "items": [
        {"id": "server-a", "anchor": {"type": "point", "x": 120, "y": 100, "mark": {"shape": "rect", "w": 80, "h": 30, "corner_radius": 6}},
         "label": {"type": "text", "text": "Server A"}},
        {"id": "db", "anchor": {"type": "point", "x": 320, "y": 110, "mark": {"shape": "ellipse", "rx": 50, "ry": 22}},
         "label": {"type": "text", "text": "Database"}},
        {"id": "rot", "anchor": {"type": "point", "x": 470, "y": 260, "mark": {"shape": "rect", "w": 40, "h": 20, "rotation": 30}},
         "label": {"type": "text", "text": "Rotated node"}},
        {"id": "tiny", "anchor": {"type": "point", "x": 200, "y": 300, "mark": {"shape": "circle", "r": 4}},
         "label": {"type": "text", "text": "Tiny node with a long name"}},
    ],
    "obstacles": {"vector": [{"class": "lines", "polylines": [[[120, 100], [320, 110]], [[320, 110], [470, 260]], [[200, 300], [120, 100]]], "width": 1.5}]},
}

problems["bubbles"] = {
    "canvas": {"width": 700, "height": 500},
    "items": [
        {"id": f"c{i}", "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "circle", "r": r}},
         "label": {"type": "text", "text": name}, "attrs": {"pop": pop}}
        for i, (x, y, r, name, pop) in enumerate([
            (200, 250, 80, "China", 1400), (420, 220, 75, "India", 1380), (560, 380, 28, "USA", 330),
            (600, 120, 20, "Indonesia", 270), (120, 420, 12, "Brazil", 210), (330, 430, 6, "Iceland", 0.37),
            (650, 450, 4, "Malta", 0.5), (90, 90, 9, "Chile", 19),
        ])
    ],
    "placement": {"internal": "auto"},
    "priority": {"terms": [{"attr": "pop", "transform": "log1p"}]},
}

problems["icons-composite"] = {
    "canvas": {"width": 500, "height": 300},
    "items": [
        {"id": "SEA", "anchor": {"type": "point", "x": 120, "y": 40}, "label": {"type": "icon", "width": 16, "height": 16, "shape": "rect"}},
        {"id": "n17", "anchor": {"type": "point", "x": 300, "y": 150, "mark": {"shape": "rect", "w": 30, "h": 18, "corner_radius": 4}},
         "label": {"type": "composite", "direction": "row", "gap": 3, "parts": [{"type": "icon", "width": 12, "height": 12}, {"type": "text", "text": "Server A"}]}},
        {"id": "spark", "anchor": {"type": "point", "x": 200, "y": 220}, "label": {"type": "box", "width": 60, "height": 14, "shape": "rounded:3"}},
        {"id": "pin", "anchor": {"type": "point", "x": 420, "y": 120, "mark": {"shape": "icon", "w": 14, "h": 20, "tip": [7, 20]}},
         "label": {"type": "text", "text": "Café Central"}},
    ],
}

problems["long-names"] = {
    "canvas": {"width": 640, "height": 480},
    "defaults": {"font": {"size": 11}},
    "items": [
        pt("Foo.java", 320, 200, "org.example.very.long.ClassName", label={"type": "text", "text": "org.example.very.long.ClassName",
           "alternatives": ["ClassName", "CN"], "wrap": {"max_width": "12em", "max_lines": 2}, "truncate": "middle"}),
        pt("Bar.java", 330, 210, "org.apache.commons.lang3.builder.ReflectionToStringBuilder",
           label={"type": "text", "text": "org.apache.commons.lang3.builder.ReflectionToStringBuilder", "wrap": {"max_width": "10em", "max_lines": 3}, "truncate": "end"}),
        pt("gene", 100, 100, "HALLMARK_EPITHELIAL_MESENCHYMAL_TRANSITION",
           label={"type": "text", "text": "HALLMARK_EPITHELIAL_MESENCHYMAL_TRANSITION", "wrap": {"max_width": 90, "max_lines": 3}}),
        pt("paper", 500, 400, "A Very Long Paper Title That Goes On and On: The Sequel", label={"type": "text", "text": "A Very Long Paper Title That Goes On and On: The Sequel"}),
    ],
}

pts = scatter_points(30, 21)
problems["priority-attrs"] = {
    "canvas": {"width": 800, "height": 600},
    "items": [pt(f"c{i}", x, y, f"Class{i}", attrs={"cbo": (i * 7) % 50, "category": "core" if i % 3 == 0 else "util"}) for i, (x, y) in enumerate(pts)],
    "priority": {
        "terms": [{"attr": "cbo", "transform": "log1p", "weight": 0.5}, {"builtin": "label_size", "weight": -0.2}, {"builtin": "outlierness", "k": 5}],
        "tiers": [{"where": "attrs.category == 'core'", "tier": 1}],
        "omission": "strict",
    },
}

problems["priority-prefix"] = {
    "canvas": {"width": 400, "height": 300},
    "items": [pt(f"t{i}", 200 + (i % 5) * 4, 150 + (i // 5) * 4, f"Top item {i}", priority=100 - i) for i in range(20)],
    "priority": {"omission": "prefix", "budget": {"max_labels": 10}},
}

problems["weighted-coverage"] = {
    "canvas": {"width": 600, "height": 400},
    "items": [pt(f"w{i}", x, y, f"City {i}", attrs={"traffic": (i * 37) % 100, "region": ["north", "south", "east"][i % 3]})
              for i, (x, y) in enumerate(scatter_points(40, 31, 600, 400))],
    "priority": {"terms": [{"attr": "traffic", "normalize": "minmax"}], "omission": "weighted",
                 "coverage": {"by": "attrs.region", "min_per_group": 2}, "ties": "anchor_x"},
}

problems["leaders-angles"] = {
    "canvas": {"width": 500, "height": 400},
    "items": [pt(f"d{i}", 250 + 6 * math.cos(i), 200 + 6 * math.sin(i), f"Dense label {i}") for i in range(10)],
    "placement": {"models": ["adjacent", "slider", "distant"], "max_distance": "10em"},
    "leaders": {"style": "angles", "angles": [0, 45, 90, 135, 180, 225, 270, 315], "port": "side-center", "clearance": 3},
}

problems["elbow-boundary"] = {
    "canvas": {"width": 700, "height": 400},
    "preset": "illustration",
    "items": [pt(f"part{i}", 250 + 40 * (i % 4), 100 + 50 * (i // 4), f"Part {i}: component") for i in range(8)],
    "leaders": {"style": "elbow", "port": "side-center"},
    "placement": {"models": ["boundary"], "boundary": {"sides": ["left", "right"], "align": "stack", "gap": 4, "margin": 8}},
}

svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" viewBox="0 0 400 300">'
       '<rect width="400" height="300" fill="white"/>'
       '<g class="points">' + "".join(f'<circle cx="{x}" cy="{y}" r="2"/>' for x, y in scatter_points(60, 41, 400, 300)) + '</g>'
       '<circle class="outlier" cx="350" cy="40" r="4" fill="red"/>'
       '<path class="trend" d="M20 280 C 120 200 250 150 380 30" fill="none" stroke="black" stroke-width="1.5"/>'
       '<text x="10" y="20" font-size="12">Title</text></svg>')
problems["svg-background"] = {
    "canvas": {"width": 400, "height": 300},
    "items": [pt("o1", 350, 40, "Outlier", anchor={"type": "point", "x": 350, "y": 40, "mark": {"shape": "circle", "r": 4}}),
              pt("m", 200, 150, "Middle")],
    "obstacles": {"svg": {"source": svg, "classes": [
        {"selector": "circle.outlier", "class": "outliers"}, {"selector": "circle", "class": "points"},
        {"selector": "path.trend", "class": "lines"}, {"selector": "text", "class": "text"},
        {"selector": "rect", "class": "ignore"}, {"selector": "*", "class": "ink"}]}},
    "avoid": {"label": {"outliers": "hard", "points": 0.3, "lines": 1.0, "text": "hard"}},
}

png = png_rgba(40, 30, lambda x, y: (20, 20, 20, 255) if (x - 20) ** 2 + (y - 15) ** 2 < 36 or 2 <= y <= 3 else (255, 255, 255, 255))
problems["raster-ink"] = {
    "canvas": {"width": 80, "height": 60},
    "items": [pt("r", 40, 30, "Blob")],
    "obstacles": {"raster": {"source": "data:image/png;base64," + base64.b64encode(png).decode(), "mode": "ink", "scale": 0.5,
                             "ink": {"background": "auto", "threshold": 0.12, "dilate": 1}}},
    "avoid": {"label": {"ink": 0.5}},
}

problems["area-anchor"] = {
    "canvas": {"width": 500, "height": 400},
    "preset": "map",
    "items": [
        {"id": "lake", "anchor": {"type": "area", "polygon": [[100, 100], [300, 80], [380, 200], [260, 300], [120, 260]]},
         "label": {"type": "text", "text": "Lake Constance"}},
        {"id": "pond", "anchor": {"type": "area", "polygon": [[420, 330], [440, 325], [445, 345], [425, 350]]},
         "label": {"type": "text", "text": "Small pond"}},
    ],
}

problems["y-up-transform"] = {
    "canvas": {"width": 400, "height": 300},
    "transform": [40, 0, 0, 30, 0, 0],
    "y_axis": "up",
    "items": [pt(f"v{i}", i, (i * i) % 9 + 0.5, f"({i})") for i in range(10)],
    "obstacles": {"vector": [{"class": "lines", "polylines": [[[i, (i * i) % 9 + 0.5] for i in range(10)]], "width": 1}]},
}

problems["region"] = {
    "canvas": {"width": 600, "height": 400, "padding": 2, "region": [50, 20, 520, 340]},
    "items": [pt(f"e{i}", 55 + i * 50, 25 + (i % 2) * 330, f"Edge {i}") for i in range(10)],
    "obstacles": {"vector": [{"class": "axes", "rects": [[50, 360, 520, 1], [50, 20, 1, 340]]}]},
    "avoid": {"label": {"axes": "hard"}, "leader": {"axes": "ignore"}},
}

problems["groups-keepwith"] = {
    "canvas": {"width": 400, "height": 300},
    "items": [
        pt("g1", 200, 150, "Coincident A", group="dup"), pt("g2", 200.2, 150.1, "Coincident B", group="dup"),
        pt("k1", 100, 80, "Pair left", keep_with="pair"), pt("k2", 130, 80, "Pair right", keep_with="pair"),
        pt("x", 300, 220, "Solo", keep_with=["k1"]),
    ],
}

problems["warm-start"] = {
    "canvas": {"width": 300, "height": 200},
    "items": [pt("a", 100, 100, "Alpha"), pt("b", 150, 100, "Beta")],
    "warm_start": {"placements": [{"id": "a", "placed": True, "box": {"x": 80, "y": 76, "w": 40, "h": 20}},
                                  {"id": "b", "placed": False}]},
    "weights": {"stability": 2.0},
}

problems["units"] = {
    "canvas": {"width": "800" and 800, "height": 600, "padding": "0.5em"},
    "defaults": {"font": {"family": "default", "size": 14, "weight": "bold", "line_height": 1.3}, "padding": "2pt", "buffer": "0.25em"},
    "items": [pt("u1", 400, 300, "Units everywhere", label={"type": "text", "text": "Units everywhere", "font": {"size": 10, "weight": 400}, "padding": "1px"}),
              pt("u2", 420, 310, "Bold label")],
    "placement": {"offset": "3px", "max_distance": "6em"},
    "leaders": {"min_length": "4pt", "max_length": "12em", "anchor_gap": "0.1em", "clearance": "2px"},
}

problems["presets-map"] = {
    "canvas": {"width": 600, "height": 400},
    "preset": "map",
    "items": [
        {"id": f"poi{i}", "anchor": {"type": "point", "x": x, "y": y, "mark": {"shape": "icon", "w": 12, "h": 16, "tip": [6, 16]}},
         "label": {"type": "composite", "parts": [{"type": "icon", "width": 10, "height": 10}, {"type": "text", "text": name}]},
         "attrs": {"rank": i}}
        for i, ((x, y), name) in enumerate(zip(scatter_points(8, 51, 600, 400), ["Museum", "Café", "Station", "Park", "Library", "Bakery", "Zoo", "Bridge"]))
    ],
    "obstacles": {"vector": [{"class": "lines", "polylines": [[[0, 200], [600, 210]], [[300, 0], [310, 400]]], "width": 4}]},
    "priority": {"terms": [{"attr": "rank", "transform": "neg"}]},
}

problems["polygon-path-marks"] = {
    "canvas": {"width": 500, "height": 400},
    "items": [
        {"id": "poly", "anchor": {"type": "point", "x": 150, "y": 150, "mark": {"shape": "polygon", "relative": True,
                 "points": [[-40, -30], [40, -30], [40, 30], [0, 0], [-40, 30]]}}, "label": {"type": "text", "text": "Concave"}},
        {"id": "path", "anchor": {"type": "point", "x": 350, "y": 150, "mark": {"shape": "path", "relative": True,
                 "d": "M -30 0 A 30 20 0 1 1 30 0 L 0 40 Z"}}, "label": {"type": "text", "text": "Path mark"}},
        {"id": "svgnode", "svg_id": "node7", "anchor": {"type": "point", "x": 250, "y": 300, "mark": {"shape": "from_svg", "svg_id": "node7"}},
         "label": {"type": "text", "text": "From SVG"}},
    ],
    "obstacles": {"svg": {"source": '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="400"><rect id="node7" x="220" y="285" width="60" height="30" rx="5"/></svg>',
                          "auto_mark_items": True, "classes": [{"selector": "*", "class": "ink"}]}},
}

problems["many-points"] = {
    "canvas": {"width": 800, "height": 600},
    "items": [pt(f"m{i}", x, y, f"L{i}") for i, (x, y) in enumerate(scatter_points(200, 61))],
    "obstacles": {"vector": [{"class": "points", "points": scatter_points(2000, 63), "r": 1.5}]},
    "solver": {"strategy": "greedy", "seed": 7},
}

problems["unbounded"] = {
    "items": [pt("n1", -50, -20, "Negative coords"), pt("n2", 5000, 3000, "Far away")],
    "output": {"debug_svg": True, "cost_breakdown": True},
}

# ----------------------------------------------------------------------------------------
invalid = {
    "duplicate-ids": ({"items": [pt("a", 1, 1, "A"), pt("a", 2, 2, "B")]}, [("/items/1/id", "duplicate_id")], []),
    "missing-anchor-y": ({"items": [{"anchor": {"type": "point", "x": 1}, "label": {"type": "text", "text": "A"}}]}, [("/items/0/anchor/y", "required")], []),
    "unknown-property": ({"items": [], "solverr": {}}, [("/solverr", "unknown_property")], []),
    "bad-unit": ({"items": [], "placement": {"offset": "3 px"}}, [("/placement/offset", "unit")], []),
    "negative-length": ({"items": [], "placement": {"offset": -2}}, [("/placement/offset", "range")], []),
    "bad-enum": ({"items": [], "leaders": {"style": "zigzag"}}, [("/leaders/style", "enum")], []),
    "svg-source-and-path": ({"items": [], "obstacles": {"svg": {"source": "<svg/>", "path": "a.svg"}}}, [("/obstacles/svg", "exclusive")], []),
    "line-anchor": ({"items": [{"anchor": {"type": "line", "points": [[0, 0], [1, 1]]}, "label": {"type": "text", "text": "A"}}]}, [("/items/0/anchor/type", "unsupported")], []),
    "keep-with-unknown": ({"items": [pt("a", 1, 1, "A", keep_with=["zz"])]}, [("/items/0/keep_with/0", "unknown_ref")], []),
    "type-error": ({"items": [{"anchor": {"type": "point", "x": "1", "y": 2}, "label": {"type": "text", "text": "A"}}]}, [("/items/0/anchor/x", "type")], []),
    "canvas-range": ({"canvas": {"width": 0, "height": 10}, "items": []}, [("/canvas/width", "range")], []),
    "unknown-class-warning": ({"items": [], "avoid": {"label": {"outlierz": "hard"}}}, [], [("/avoid/label/outlierz", "unknown_class")]),
    "y-up-no-canvas": ({"items": [], "y_axis": "up"}, [("/canvas", "required")], []),
    "mark-extra-prop": ({"items": [{"anchor": {"type": "point", "x": 1, "y": 1, "mark": {"shape": "circle", "r": 2, "rx": 3}}, "label": {"type": "text", "text": "A"}}]},
                        [("/items/0/anchor/mark/rx", "unknown_property")], []),
    "icon-missing-height": ({"items": [{"anchor": {"type": "point", "x": 1, "y": 1}, "label": {"type": "icon", "width": 3}}]}, [("/items/0/label/height", "required")], []),
    "text-label-no-text": ({"items": [{"anchor": {"type": "point", "x": 1, "y": 1}, "label": {"type": "text"}}]}, [("/items/0/label/text", "required")], []),
    "bad-degrade-step": ({"items": [], "degrade": ["wrap", "shrink:2"]}, [("/degrade/1", "pattern")], []),
    "duplicate-implicit-id": ({"items": [pt("1", 1, 1, "A"), {"anchor": {"type": "point", "x": 1, "y": 1}, "label": {"type": "text", "text": "B"}}]}, [("/items/1", "duplicate_id")], []),
    "version-const": ({"version": "2", "items": []}, [("/version", "const")], []),
    "raster-no-source": ({"items": [], "obstacles": {"raster": {"mode": "ink"}}}, [("/obstacles/raster", "exclusive")], []),
}


def main():
    PROB.mkdir(parents=True, exist_ok=True)
    VAL.mkdir(parents=True, exist_ok=True)
    for name, p in problems.items():
        (PROB / f"{name}.json").write_text(json.dumps(p, indent=2, ensure_ascii=False) + "\n")
    for name, (p, errs, warns) in invalid.items():
        case = {"kind": "validate", "name": name, "problem": p,
                "expect": {"valid": not errs, "errors": [{"pointer": a, "code": b} for a, b in errs],
                           "warnings": [{"pointer": a, "code": b} for a, b in warns]}}
        (VAL / f"{name}.json").write_text(json.dumps(case, indent=2, ensure_ascii=False) + "\n")
    # every sample problem must be valid
    case = {"kind": "validate", "name": "all sample problems are valid", "problem_files": sorted(f"../problems/{n}.json" for n in problems),
            "expect": {"valid": True, "errors": []}}
    (VAL / "samples-valid.json").write_text(json.dumps(case, indent=2) + "\n")
    print(len(problems), "problems,", len(invalid), "invalid cases")


if __name__ == "__main__":
    main()
