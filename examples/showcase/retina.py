"""A photograph: the parts of the eye's fundus, labeled in the margins.

A fundus photograph (M. Häggström, CC0; the playground's ``pictures/retina.jpg``) with its
parts outlined (``pictures.json``, CC0), as an anatomy atlas would label it: the names
stacked in columns in the margins (the ``boundary`` model), a leader from each name to a
dot inside its part. The photograph is the problem's raster background (``saliency``): the
leaders keep off its detail where they can.
"""

from __future__ import annotations

import base64
import json
import math

from common import FIGURES, PLAYGROUND_DATA, compose, f, report, solve, write_problem

NAME = "retina"
W, H = 960, 600
SIZE = 560  # the photograph
OX, OY = (W - SIZE) / 2, (H - SIZE) / 2  # where it is
SKIP = {"notch"}  # the camera's, not the eye's
TEXT = "#1f2328"


# parts whose dot goes outside another part they contain (the disc's rim, not its cup)
HOLES = {"disc": ["cup"], "macula": ["fovea"]}


def pole(poly: list[list[float]], holes: list[list[list[float]]] = ()) -> tuple[float, float]:
    """The point inside a polygon (outside its holes) farthest from its edges (a grid search)."""
    xs = [p[0] for p in poly]
    ys = [p[1] for p in poly]
    rings = [poly, *holes]

    def within(ring, x, y):
        c = False
        for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
            if (y1 > y) != (y2 > y) and x < x1 + (y - y1) * (x2 - x1) / (y2 - y1):
                c = not c
        return c

    def inside(x, y):
        return within(poly, x, y) and not any(within(h, x, y) for h in holes)

    def dist(x, y):
        best = math.inf
        for ring in rings:
            for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
                dx, dy = x2 - x1, y2 - y1
                t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy or 1)))
                best = min(best, math.hypot(x - x1 - t * dx, y - y1 - t * dy))
        return best

    best, at = -1.0, (sum(xs) / len(xs), sum(ys) / len(ys))
    step = max(max(xs) - min(xs), max(ys) - min(ys)) / 40
    for i in range(41):
        for j in range(41):
            x, y = min(xs) + i * step, min(ys) + j * step
            if inside(x, y) and dist(x, y) > best:
                best, at = dist(x, y), (x, y)
    return at


def picture() -> tuple[str, list[dict]]:
    data = json.loads((PLAYGROUND_DATA / "pictures" / "pictures.json").read_text(encoding="utf-8"))
    pic = next(p for p in data["pictures"] if p["id"] == "retina")
    scale = SIZE / pic["size"][0]
    jpg = base64.b64encode((PLAYGROUND_DATA / "pictures" / pic["file"]).read_bytes()).decode("ascii")
    cx, cy, r = OX + SIZE / 2, OY + SIZE / 2, SIZE / 2 - 4
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         f'<rect id="background" width="{W}" height="{H}" fill="#ffffff"/>',
         f'<clipPath id="fundus"><circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}"/></clipPath>',
         f'<image x="{f(OX)}" y="{f(OY)}" width="{SIZE}" height="{SIZE}" clip-path="url(#fundus)" '
         f'href="data:image/jpeg;base64,{jpg}"/>',
         f'<circle cx="{f(cx)}" cy="{f(cy)}" r="{f(r)}" fill="none" stroke="#d0d4d9" stroke-width="1"/>',
         "</svg>"]
    polys = {q["id"]: [[OX + x * scale, OY + y * scale] for x, y in q["polygon"]] for q in pic["parts"]}
    parts = [{"id": q["id"], "label": q["label"], "at": pole(polys[q["id"]], [polys[h] for h in HOLES.get(q["id"], [])])}
             for q in pic["parts"] if q["id"] not in SKIP]
    return "\n".join(o) + "\n", parts


def problem(parts: list[dict]) -> dict:
    return {
        "version": "1",
        "canvas": {"width": W, "height": H, "padding": 10},
        "defaults": {"font": {"size": 13}},
        "obstacles": {
            "raster": {"source": "../../ts/packages/playground/data/pictures/retina.jpg", "mode": "saliency",
                       "scale": 1, "offset": [OX, OY]},
        },
        "items": [{
            "id": p["id"],
            "anchor": {"type": "point", "x": round(p["at"][0], 1), "y": round(p["at"][1], 1),
                       "mark": {"shape": "circle", "r": 3}},
            "label": {"type": "text", "text": p["label"]},
        } for p in parts],
        "placement": {"models": ["boundary"], "boundary": {"sides": ["left", "right"], "align": "stack",
                                                           "margin": 16, "gap": 10}},
        "leaders": {"style": "straight"},
        "solver": {"seed": 1},
    }


def make(cli: str) -> str:
    pic, parts = picture()
    prob = problem(parts)
    result = solve(cli, write_problem(NAME, prob))
    dots = "".join(f'<circle cx="{f(it["anchor"]["x"])}" cy="{f(it["anchor"]["y"])}" r="3"/>' for it in prob["items"])
    svg = compose(W, H, "A fundus photograph with its parts labeled in the margins by Label Anything",
                  pic.split(">", 1)[1].rsplit("</svg>", 1)[0], result,
                  label_color=lambda p: TEXT,
                  leaders='fill="none" stroke="#1f2328" stroke-width="1"',
                  leaders_under='fill="none" stroke="#ffffff" stroke-width="3" stroke-opacity="0.8"',
                  extra=f'<g class="dots" fill="#ffffff" stroke="#1f2328" stroke-width="1.2">{dots}</g>')
    (FIGURES / f"{NAME}.svg").write_text(svg, encoding="utf-8")
    return report(NAME, result)
