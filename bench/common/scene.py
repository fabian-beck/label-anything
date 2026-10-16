"""Scene builder for scenario backgrounds.

One list of drawing primitives (in canvas px) produces, consistently:

* ``svg()``: SVG markup (classes on every element) and ``svg_rules()``, the
  ``obstacles.svg.classes`` rules mapping SVG classes to obstacle classes,
* ``truth()``: the exact geometry of every obstacle class (for truth.json):
  fills → polygons / circles / rects, strokes → polylines with the stroke width,
  text → its bounding rectangle measured with the bundled font,
* ``vector_layers()``: the same obstacles as ``obstacles.vector`` layers,
* ``png()``: a raster preview / raster background (Pillow, 2× supersampled).

Only straight-segment geometry is emitted (paths use M/L/Z), so the truth is exact.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from xml.sax.saxutils import escape, quoteattr

from PIL import Image, ImageDraw, ImageFont

from . import text as textmod


IGNORED = "background"  # obstacle class for drawn elements that must not interact with labels


def _f(v: float) -> str:
    s = f"{v:.2f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


@dataclass
class Prim:
    kind: str                 # circle | rect | polyline | polygon | text
    svg_class: str
    obstacle: str | None      # obstacle class, or None / "ignore"
    data: dict
    fill: str | None = None
    stroke: str | None = None
    stroke_width: float = 0.0
    opacity: float = 1.0


@dataclass
class Scene:
    width: float
    height: float
    background: str | None = "#ffffff"
    prims: list[Prim] = field(default_factory=list)

    # -- primitives ---------------------------------------------------------
    def circle(self, x, y, r, svg_class, obstacle, fill="#888888", stroke=None, stroke_width=0.0, opacity=1.0):
        self.prims.append(Prim("circle", svg_class, obstacle, {"x": x, "y": y, "r": r}, fill, stroke,
                               stroke_width, opacity))

    def rect(self, x, y, w, h, svg_class, obstacle, fill="#cccccc", stroke=None, stroke_width=0.0, opacity=1.0):
        self.prims.append(Prim("rect", svg_class, obstacle, {"x": x, "y": y, "w": w, "h": h}, fill, stroke,
                               stroke_width, opacity))

    def polyline(self, pts, svg_class, obstacle, stroke="#888888", width=1.0, opacity=1.0, dash=None):
        if len(pts) < 2:
            return
        self.prims.append(Prim("polyline", svg_class, obstacle, {"points": [tuple(p) for p in pts], "dash": dash},
                               None, stroke, width, opacity))

    def polygon(self, rings, svg_class, obstacle, fill="#dddddd", stroke=None, stroke_width=0.0, opacity=1.0):
        rings = [[tuple(p) for p in r] for r in rings if len(r) >= 3]
        if rings:
            self.prims.append(Prim("polygon", svg_class, obstacle, {"rings": rings}, fill, stroke, stroke_width,
                                   opacity))

    def text(self, x, y, s, svg_class, obstacle, size=11.0, anchor="start", fill="#333333", weight=400,
             rotate=0.0):
        """Text at baseline (x, y); anchor start|middle|end. Records its bounding box."""
        f = textmod.font(weight)
        w = f.width(s, size)
        x0 = x - (w / 2 if anchor == "middle" else w if anchor == "end" else 0.0)
        bbox = (x0, y - f.ascent(size), w, f.ascent(size) + f.descent(size))
        if rotate:
            # rotation by -90 (vertical axis titles) around (x, y)
            bx, by, bw, bh = bbox
            corners = [(bx, by), (bx + bw, by), (bx + bw, by + bh), (bx, by + bh)]
            c, sn = math.cos(math.radians(rotate)), math.sin(math.radians(rotate))
            rc = [(x + c * (px - x) - sn * (py - y), y + sn * (px - x) + c * (py - y)) for px, py in corners]
            xs, ys = [p[0] for p in rc], [p[1] for p in rc]
            bbox = (min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys))
        self.prims.append(Prim("text", svg_class, obstacle, {"x": x, "y": y, "s": s, "size": size, "anchor": anchor,
                                                              "weight": weight, "bbox": bbox, "rotate": rotate},
                               fill))

    # -- outputs ------------------------------------------------------------
    def svg_rules(self) -> list[dict]:
        """``obstacles.svg.classes`` rules. Elements without an obstacle class map to the class
        ``background`` (made ``ignore`` through ``avoid``): the literal ``"ignore"`` cannot be used
        in v1 problems because the schema's ``oneOf [className, "ignore"]`` matches it twice."""
        seen: dict[str, str] = {"bg": IGNORED} if self.background else {}
        for p in self.prims:
            ob = p.obstacle if p.obstacle and p.obstacle != "ignore" else IGNORED
            if p.svg_class in seen and seen[p.svg_class] != ob:
                raise ValueError(f"svg class {p.svg_class} maps to two obstacle classes")
            seen[p.svg_class] = ob
        return [{"selector": f".{c}", "class": ob} for c, ob in sorted(seen.items())]

    def svg(self) -> str:
        W, H = self.width, self.height
        out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{_f(W)}" height="{_f(H)}" '
               f'viewBox="0 0 {_f(W)} {_f(H)}">']
        if self.background:
            out.append(f'<rect class="bg" x="0" y="0" width="{_f(W)}" height="{_f(H)}" fill="{self.background}"/>')
        for p in self.prims:
            op = f' opacity="{_f(p.opacity)}"' if p.opacity < 1 else ""
            st = (f' stroke="{p.stroke}" stroke-width="{_f(p.stroke_width)}"' if p.stroke and p.stroke_width > 0
                  else "")
            cls = f'class="{p.svg_class}"'
            d = p.data
            if p.kind == "circle":
                out.append(f'<circle {cls} cx="{_f(d["x"])}" cy="{_f(d["y"])}" r="{_f(d["r"])}" '
                           f'fill="{p.fill or "none"}"{st}{op}/>')
            elif p.kind == "rect":
                out.append(f'<rect {cls} x="{_f(d["x"])}" y="{_f(d["y"])}" width="{_f(d["w"])}" '
                           f'height="{_f(d["h"])}" fill="{p.fill or "none"}"{st}{op}/>')
            elif p.kind == "polyline":
                dash = f' stroke-dasharray="{d["dash"]}"' if d.get("dash") else ""
                pts = " ".join(f"{_f(x)},{_f(y)}" for x, y in d["points"])
                out.append(f'<polyline {cls} points="{pts}" fill="none" stroke="{p.stroke}" '
                           f'stroke-width="{_f(p.stroke_width)}"{dash}{op}/>')
            elif p.kind == "polygon":
                dd = " ".join("M" + " L".join(f"{_f(x)} {_f(y)}" for x, y in r) + " Z" for r in d["rings"])
                out.append(f'<path {cls} d="{dd}" fill="{p.fill or "none"}" fill-rule="evenodd"{st}{op}/>')
            elif p.kind == "text":
                anchor = {"start": "start", "middle": "middle", "end": "end"}[d["anchor"]]
                tr = (f' transform="rotate({_f(d["rotate"])} {_f(d["x"])} {_f(d["y"])})"' if d["rotate"] else "")
                out.append(f'<text {cls} x="{_f(d["x"])}" y="{_f(d["y"])}" font-family="Noto Sans" '
                           f'font-size="{_f(d["size"])}" font-weight="{d["weight"]}" text-anchor="{anchor}" '
                           f'fill="{p.fill}"{tr}>{escape(d["s"])}</text>')
        out.append("</svg>")
        return "\n".join(out) + "\n"

    def truth(self) -> dict:
        classes: dict[str, dict] = {}

        def entry(c):
            return classes.setdefault(c, {"circles": [], "rects": [], "polylines": [], "polygons": []})

        for p in self.prims:
            if not p.obstacle or p.obstacle == "ignore":
                continue
            e = entry(p.obstacle)
            d = p.data
            stroke = p.stroke and p.stroke_width > 0
            if p.kind == "circle":
                if p.fill and p.fill != "none":
                    e["circles"].append([d["x"], d["y"], d["r"] + (p.stroke_width / 2 if stroke else 0.0)])
                elif stroke:
                    e["circles"].append([d["x"], d["y"], d["r"] + p.stroke_width / 2])
            elif p.kind == "rect":
                if p.fill and p.fill != "none":
                    e["rects"].append([d["x"], d["y"], d["w"], d["h"]])
                if stroke:
                    x, y, w, h = d["x"], d["y"], d["w"], d["h"]
                    e["polylines"].append({"points": [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]],
                                           "width": p.stroke_width})
            elif p.kind == "polyline":
                e["polylines"].append({"points": [list(q) for q in d["points"]], "width": p.stroke_width})
            elif p.kind == "polygon":
                if p.fill and p.fill != "none":
                    e["polygons"].append({"rings": [[list(q) for q in r] for r in d["rings"]],
                                          "fill_rule": "evenodd"})
                if stroke:
                    for r in d["rings"]:
                        e["polylines"].append({"points": [list(q) for q in r] + [list(r[0])],
                                               "width": p.stroke_width})
            elif p.kind == "text":
                e["rects"].append(list(d["bbox"]))
        for e in classes.values():
            for k in [k for k, v in e.items() if not v]:
                del e[k]
        return {"version": 1, "canvas": [self.width, self.height], "classes": classes}

    def vector_layers(self) -> list[dict]:
        """The scene's obstacles as ``obstacles.vector`` layers (one per class and stroke width)."""
        layers: dict[tuple, dict] = {}
        for cls, e in sorted(self.truth()["classes"].items()):
            if e.get("circles"):
                layers[(cls, "c")] = {"class": cls, "circles": e["circles"]}
            if e.get("rects"):
                layers[(cls, "r")] = {"class": cls, "rects": e["rects"]}
            for pl in e.get("polylines", []):
                key = (cls, "l", pl["width"])
                layers.setdefault(key, {"class": cls, "polylines": [], "width": pl["width"]})["polylines"].append(
                    pl["points"])
            for pg in e.get("polygons", []):
                key = (cls, "p")
                lay = layers.setdefault(key, {"class": cls, "polygons": [], "fill_rule": "evenodd"})
                lay["polygons"].extend(pg["rings"])
        return [layers[k] for k in sorted(layers, key=lambda k: tuple(str(x) for x in k))]

    def png(self, scale: float = 1.0, supersample: int = 2) -> Image.Image:
        s = scale * supersample
        W, H = int(math.ceil(self.width * s)), int(math.ceil(self.height * s))
        img = Image.new("RGBA", (W, H), _rgba(self.background or "#ffffff"))
        # consecutive primitives with the same opacity share one layer (composited once per run)
        layer, layer_opacity = None, 1.0

        def flush():
            nonlocal layer
            if layer is not None:
                a = layer.getchannel("A").point(lambda v, o=layer_opacity: int(v * o))
                layer.putalpha(a)
                img.alpha_composite(layer)
                layer = None

        for p in self.prims:
            if p.opacity < 1:
                if layer is None or layer_opacity != p.opacity:
                    flush()
                    layer, layer_opacity = Image.new("RGBA", (W, H), (0, 0, 0, 0)), p.opacity
            else:
                flush()
            dr = ImageDraw.Draw(layer if layer is not None else img)
            d = p.data
            fill = _rgba(p.fill) if p.fill and p.fill != "none" else None
            stroke = _rgba(p.stroke) if p.stroke and p.stroke_width > 0 else None
            sw = max(1, int(round(p.stroke_width * s))) if stroke else 0
            if p.kind == "circle":
                r = d["r"] * s
                dr.ellipse([d["x"] * s - r, d["y"] * s - r, d["x"] * s + r, d["y"] * s + r], fill=fill,
                           outline=stroke, width=sw)
            elif p.kind == "rect":
                dr.rectangle([d["x"] * s, d["y"] * s, (d["x"] + d["w"]) * s, (d["y"] + d["h"]) * s], fill=fill,
                             outline=stroke, width=sw)
            elif p.kind == "polyline":
                pts = [(x * s, y * s) for x, y in d["points"]]
                if d.get("dash"):
                    _dashed(dr, pts, _rgba(p.stroke), sw, [float(v) * s for v in d["dash"].split()])
                else:
                    dr.line(pts, fill=_rgba(p.stroke), width=max(1, int(round(p.stroke_width * s))), joint="curve")
            elif p.kind == "polygon":
                if fill:
                    _fill_evenodd(img if layer is None else layer, d["rings"], s, fill)
                if stroke:
                    for r in d["rings"]:
                        dr.line([(x * s, y * s) for x, y in r] + [(r[0][0] * s, r[0][1] * s)], fill=stroke,
                                width=sw, joint="curve")
            elif p.kind == "text":
                fnt = ImageFont.truetype(textmod.font_file(d["weight"]), size=d["size"] * s)
                anchor = {"start": "ls", "middle": "ms", "end": "rs"}[d["anchor"]]
                if d["rotate"]:
                    tw = int(textmod.font(d["weight"]).width(d["s"], d["size"]) * s) + 4
                    th = int(d["size"] * 1.6 * s)
                    tl = Image.new("RGBA", (tw, th), (0, 0, 0, 0))
                    ImageDraw.Draw(tl).text((0, th * 0.75), d["s"], font=fnt, fill=_rgba(p.fill), anchor="ls")
                    tl = tl.rotate(-d["rotate"], expand=True)
                    bx, by, bw, bh = d["bbox"]
                    img.alpha_composite(tl, (int(bx * s), int(by * s)))
                else:
                    dr.text((d["x"] * s, d["y"] * s), d["s"], font=fnt, fill=_rgba(p.fill), anchor=anchor)
        flush()
        if supersample > 1:
            img = img.resize((int(math.ceil(self.width * scale)), int(math.ceil(self.height * scale))),
                             Image.LANCZOS)
        return img.convert("RGB")


def _rgba(c: str, a: int = 255):
    c = c.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), a)


def _fill_evenodd(img: Image.Image, rings, s: float, fill) -> None:
    if len(rings) == 1:
        ImageDraw.Draw(img).polygon([(x * s, y * s) for x, y in rings[0]], fill=fill)
        return
    xs = [x for r in rings for x, _ in r]
    ys = [y for r in rings for _, y in r]
    x0, y0 = int(math.floor(min(xs) * s)), int(math.floor(min(ys) * s))
    x1, y1 = int(math.ceil(max(xs) * s)) + 1, int(math.ceil(max(ys) * s)) + 1
    mask = Image.new("1", (max(1, x1 - x0), max(1, y1 - y0)), 0)
    for r in rings:  # XOR each ring into the mask = even-odd
        m = Image.new("1", mask.size, 0)
        ImageDraw.Draw(m).polygon([(x * s - x0, y * s - y0) for x, y in r], fill=1)
        from PIL import ImageChops
        mask = ImageChops.logical_xor(mask, m)
    solid = Image.new("RGBA", mask.size, fill)
    img.paste(solid, (x0, y0), mask)


def _dashed(dr, pts, color, width, pattern):
    on = True
    k = 0
    rem = pattern[0]
    for i in range(len(pts) - 1):
        (ax, ay), (bx, by) = pts[i], pts[i + 1]
        L = math.hypot(bx - ax, by - ay)
        pos = 0.0
        while pos < L:
            step = min(rem, L - pos)
            if on:
                t0, t1 = pos / L, (pos + step) / L
                dr.line([(ax + (bx - ax) * t0, ay + (by - ay) * t0), (ax + (bx - ax) * t1, ay + (by - ay) * t1)],
                        fill=color, width=width)
            pos += step
            rem -= step
            if rem <= 1e-9:
                on = not on
                k = (k + 1) % len(pattern)
                rem = pattern[k]


def quote(s: str) -> str:
    return quoteattr(s)
