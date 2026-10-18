"""The example of the documentation's home page: the world's economies as a bubble chart,
labeled by the CLI.

    bench/.venv/bin/python examples/showcase/make_showcase.py --cli rust/target/release/label-anything

Every country of Natural Earth (public domain, 2019 estimates; the playground's
``world.json``) with at least 100,000 people is a bubble: GDP per person across, population
up, the bubble's area its GDP, its colour its continent. The chart is an SVG
(``economies-chart.svg``) that the problem (``economies.json``) hands the engine as its
background, classified with CSS selectors: grid lines may be covered, axes, their text and
the legend may not. Every country has a label, in the order of its GDP:

* the largest economies are set larger and bold (font classes) and inside their bubble
  where they fit (internal labels on the true circle);
* the others touch their bubble's outline, or sit out on a leader where it is crowded;
* a name that does not fit is shortened (``United States of America`` → ``United States``
  → ``USA``: alternatives, then the ISO code);
* what still does not fit is left out, the smallest economies first (strict priority),
  and labels may cover the bubbles of smaller economies at a cost.

The script writes the chart, the problem, and the figure: the chart with the labels and
leaders of the result, the text set in an embedded subset of Noto Sans
(``docs/assets/figures/economies.svg``; it needs the benchmark's Python environment for the
fonts: fontTools). Solves are deterministic, so unchanged inputs give an unchanged figure.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path
from xml.sax.saxutils import escape

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
WORLD = ROOT / "ts" / "packages" / "playground" / "data" / "world.json"
FIGURE = ROOT / "docs" / "assets" / "figures" / "economies.svg"

W, H = 960, 600
PLOT = (78, 16, 944, 548)  # x0, y0, x1, y1 of the plot area
X_DOMAIN = (math.log10(200), math.log10(160_000))  # GDP per person, US$
Y_DOMAIN = (math.log10(80_000), math.log10(3e9))  # people
R_MAX = 50  # the bubble of the largest economy

CONTINENTS = {
    "Africa": "#59a14f",
    "Asia": "#e15759",
    "Europe": "#4e79a7",
    "North America": "#f28e2b",
    "South America": "#d4a72c",
    "Oceania": "#b07aa1",
}
# shorter names before the ISO code, where the full name is long
SHORT = {
    "USA": ["United States"],
    "COD": ["DR Congo"],
    "CAF": ["Central African Rep."],
    "BIH": ["Bosnia"],
    "ARE": ["UAE"],
    "GBR": ["UK"],
}
TEXT = "#1f2328"
MUTED = "#5f6670"


def sx(v: float) -> float:
    x0, _, x1, _ = PLOT
    return x0 + (math.log10(v) - X_DOMAIN[0]) / (X_DOMAIN[1] - X_DOMAIN[0]) * (x1 - x0)


def sy(v: float) -> float:
    _, y0, _, y1 = PLOT
    return y1 - (math.log10(v) - Y_DOMAIN[0]) / (Y_DOMAIN[1] - Y_DOMAIN[0]) * (y1 - y0)


def f(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".")


def countries() -> list[dict]:
    data = json.loads(WORLD.read_text(encoding="utf-8"))["countries"]
    out = [c for c in data if c["continent"] in CONTINENTS and (c["pop"] or 0) >= 100_000 and (c["gdp"] or 0) > 0]
    gmax = max(c["gdp"] for c in out)
    for c in out:
        c["x"] = sx(c["gdp"] * 1e6 / c["pop"])
        c["y"] = sy(c["pop"])
        c["r"] = max(2.0, R_MAX * math.sqrt(c["gdp"] / gmax))
    # the largest bubbles first, so that the smaller ones are drawn over them
    return sorted(out, key=lambda c: -c["gdp"])


def chart(cs: list[dict]) -> str:
    """The chart as a host draws it: grid, axes, bubbles, legend."""
    x0, y0, x1, y1 = PLOT
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         f'<rect id="background" width="{W}" height="{H}" fill="#ffffff"/>']
    o.append('<g class="grid" stroke="#e6e8eb" stroke-width="1">')
    xt = [200, 500, 1000, 2000, 5000, 10_000, 20_000, 50_000, 100_000]
    yt = [100_000, 1e6, 1e7, 1e8, 1e9]
    for v in xt:
        o.append(f'<line x1="{f(sx(v))}" y1="{y0}" x2="{f(sx(v))}" y2="{y1}"/>')
    for v in yt:
        o.append(f'<line x1="{x0}" y1="{f(sy(v))}" x2="{x1}" y2="{f(sy(v))}"/>')
    o.append("</g>")
    o.append(f'<g class="axis" fill="{MUTED}" font-size="11" stroke="none">')
    o.append(f'<line x1="{x0}" y1="{y1}" x2="{x1}" y2="{y1}" stroke="#9aa1a9"/>')
    o.append(f'<line x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}" stroke="#9aa1a9"/>')
    for v in xt:
        t = f"${v // 1000}k" if v >= 1000 else f"${v}"
        o.append(f'<text x="{f(sx(v))}" y="{y1 + 16}" text-anchor="middle">{t}</text>')
    for v in yt:
        t = {1e5: "100k", 1e6: "1M", 1e7: "10M", 1e8: "100M", 1e9: "1B"}[v]
        o.append(f'<text x="{x0 - 6}" y="{f(sy(v) + 4)}" text-anchor="end">{t}</text>')
    o.append(f'<text x="{f((x0 + x1) / 2)}" y="{y1 + 38}" text-anchor="middle" fill="{TEXT}" font-size="12">'
             "GDP per person (US$, log scale)</text>")
    o.append(f'<text transform="translate({x0 - 44} {f((y0 + y1) / 2)}) rotate(-90)" text-anchor="middle" '
             f'fill="{TEXT}" font-size="12">Population (log scale)</text>')
    o.append("</g>")
    o.append('<g class="bubbles" stroke="#ffffff" stroke-width="0.8">')
    for c in cs:
        o.append(f'<circle class="bubble" id="{c["id"]}" cx="{f(c["x"])}" cy="{f(c["y"])}" r="{f(c["r"])}" '
                 f'fill="{CONTINENTS[c["continent"]]}" fill-opacity="0.78"/>')
    o.append("</g>")
    # the legend, top left, where no country is
    lx, ly = x0 + 14, y0 + 12
    o.append(f'<g class="legend" font-size="11" fill="{TEXT}">')
    o.append(f'<rect x="{lx - 8}" y="{ly - 8}" width="118" height="{len(CONTINENTS) * 16 + 30}" rx="4" '
             'fill="#ffffff" stroke="#e6e8eb"/>')
    for i, (name, col) in enumerate(CONTINENTS.items()):
        y = ly + 6 + i * 16
        o.append(f'<circle cx="{lx + 5}" cy="{y}" r="5" fill="{col}" fill-opacity="0.78"/>')
        o.append(f'<text x="{lx + 15}" y="{y + 4}">{escape(name)}</text>')
    o.append(f'<text x="{lx}" y="{ly + 6 + len(CONTINENTS) * 16 + 4}" fill="{MUTED}" font-size="10">'
             "Area: GDP</text>")
    o.append("</g>")
    o.append("</svg>")
    return "\n".join(o) + "\n"


def problem(cs: list[dict]) -> dict:
    items = []
    for c in cs:
        alts = SHORT.get(c["id"], []) + [c["id"]]
        items.append({
            "id": c["id"],
            "anchor": {"type": "point", "x": round(c["x"], 2), "y": round(c["y"], 2),
                       "mark": {"shape": "circle", "r": round(c["r"], 2)}},
            "label": {"type": "text", "text": c["name"], "alternatives": [a for a in alts if a != c["name"]]},
            "priority": c["gdp"],
            # a label inside its bubble where it fits
            **({"placement": {"internal": "prefer"}} if c["r"] >= 15 else {}),
        })
    return {
        "version": "1",
        "canvas": {"width": W, "height": H, "padding": 2},
        "defaults": {"font": {"size": 11.5}},
        "obstacles": {
            "svg": {
                "path": "economies-chart.svg",
                "classes": [
                    {"selector": "#background", "class": "ignore"},
                    {"selector": ".grid line", "class": "grid"},
                    {"selector": ".legend *", "class": "legend"},
                    {"selector": ".axis *", "class": "axes"},
                    # the bubbles are the items' marks
                    {"selector": "circle.bubble", "class": "ignore"},
                ],
            }
        },
        "items": items,
        "avoid": {
            "label": {"grid": "ignore", "axes": "hard", "legend": "hard", "lower_items": 1.5},
            "leader": {"grid": "ignore", "axes": "hard", "legend": "hard", "lower_items": 0.5},
        },
        "placement": {"models": ["adjacent", "slider", "internal", "distant"], "max_distance": "6em"},
        "leaders": {"style": "straight", "max_length": "9em"},
        "priority": {
            "font_classes": [{"first": 8, "scale": 1.25, "weight": "bold"}, {"first": 30, "scale": 1.0},
                             {"scale": 0.85}],
        },
        "degrade": ["alternatives", "distant", "omit"],
        "solver": {"seed": 1},
    }


def figure(chart_svg: str, result: dict) -> str:
    """The chart with the labels and leaders of the result, its text in embedded Noto Sans."""
    sys.path.insert(0, str(ROOT))
    import re

    from bench.render import _font_face, _glyph_text
    from bench.common import text as textmod

    placed = [p for p in result["placements"] if p.get("placed")]
    chars: dict[int, set[str]] = {}
    for p in placed:
        t = p["text"]
        w = 700 if textmod.resolve_weight(t.get("font_weight", 400)) >= 550 else 400
        chars.setdefault(w, set()).update("".join(t["lines"]))
    for m in re.finditer(r"<text\b[^>]*>([^<]*)</text>", chart_svg):
        chars.setdefault(400, set()).update(m.group(1).replace("&amp;", "&"))
    faces = "".join(_font_face(w, "".join(sorted(cs))) for w, cs in sorted(chars.items()))
    body = chart_svg.split(">", 1)[1].rsplit("</svg>", 1)[0]
    o = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{W}" height="{H}" viewBox="0 0 {W} {H}">',
         "<title>The world's economies: population against GDP per person, every country a bubble "
         "sized by its GDP, labeled by Label Anything</title>",
         f"<style>{faces}text{{font-family:'LA Noto Sans',sans-serif;white-space:pre}}"
         ".labels text{stroke:#ffffff;stroke-width:2.6px;stroke-linejoin:round;paint-order:stroke}"
         ".labels .inside text{stroke:none}</style>",
         body]
    o.append(f'<g class="leaders" fill="none" stroke="{MUTED}" stroke-width="0.8">')
    for p in placed:
        for L in ([p["leader"]] if p.get("leader") else []) + list(p.get("leaders") or []):
            o.append('<polyline points="' + " ".join(f"{f(x)},{f(y)}" for x, y in L["points"]) + '"/>')
    o.append("</g>")
    o.append('<g class="labels">')
    for p in placed:
        b = p["box"]
        inside = p.get("model") == "internal"
        o.append('<g class="inside">' if inside else "<g>")
        o += _glyph_text(b["x"], b["y"], p["text"], color="#ffffff" if inside else TEXT)
        o.append("</g>")
    o.append("</g>")
    o.append("</svg>")
    return "\n".join(o) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--cli", required=True, help="the label-anything executable")
    args = ap.parse_args()
    cs = countries()
    chart_svg = chart(cs)
    (HERE / "economies-chart.svg").write_text(chart_svg, encoding="utf-8")
    prob = problem(cs)
    (HERE / "economies.json").write_text(json.dumps(prob, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "result.json"
        subprocess.run([str(Path(args.cli).resolve()), "place", str(HERE / "economies.json"), "-o", str(out)],
                       check=True)
        result = json.loads(out.read_text(encoding="utf-8"))
    FIGURE.write_text(figure(chart_svg, result), encoding="utf-8")
    s = result["stats"]
    omitted = [p["id"] for p in result["placements"] if not p.get("placed")]
    print(f"{FIGURE.relative_to(ROOT)}: {s['placed']} of {s['total']} labels placed, "
          f"{s.get('hard_violations', 0)} hard violations; first omitted: {', '.join(omitted[:8])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
