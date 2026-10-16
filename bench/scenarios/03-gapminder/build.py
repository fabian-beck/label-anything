"""Build scenario 03: Gapminder-style bubble chart (vega-datasets gapminder.json).

x = fertility (babies per woman), y = life expectancy (years); bubble area ∝
population (radius = 60 px · sqrt(pop / max pop of the year), at least 2 px, so
radii vary ≈ 30×). Items are ``circle`` marks with the bubble radius; big
bubbles can hold their label inside.

Configs:
* ``y2005-vector`` (quick)  40 most populous countries + 6 regression outliers, other bubbles and
                            the chart as vector layers, ``placement.internal: "prefer"``,
* ``y2005-svg``             same items on an SVG chart with a large year watermark (soft) and legend,
* ``y1955-all-vector``      all 62 countries of 1955 labeled, default internal policy (``auto``).
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch  # noqa: E402
from bench.common.scenario import Axes, Writer, base_problem, merge_avoid, png_bytes, svg_source  # noqa: E402
from bench.common.scene import Scene  # noqa: E402

SCENARIO = "03-gapminder"
SOURCES = ["vega-datasets-3.2.1"]
W, H = 960.0, 640.0
PLOT = (70.0, 30.0, W - 20.0, H - 60.0)
REGIONS = {0: "South Asia", 1: "Europe & Central Asia", 2: "Sub-Saharan Africa", 3: "America",
           4: "East Asia & Pacific", 5: "Middle East & North Africa"}
COLORS = {0: "#4e79a7", 1: "#f28e2b", 2: "#e15759", 3: "#76b7b2", 4: "#59a14f", 5: "#edc948"}


def load(year: int) -> list[dict]:
    tgz = fetch.ensure("vega-datasets-3.2.1", verbose=False)
    rows = json.loads(fetch.read_tar_member(tgz, "package/data/gapminder.json"))
    out = [r for r in rows if r["year"] == year]
    out.sort(key=lambda r: (-r["pop"], r["country"]))
    return out


def radius(pop: float, pmax: float) -> float:
    return round(max(2.0, 60.0 * math.sqrt(pop / pmax)), 3)


def outliers(rows, n: int, exclude: set[str]) -> list[str]:
    xs = [r["fertility"] for r in rows]
    ys = [r["life_expect"] for r in rows]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    b = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sum((x - mx) ** 2 for x in xs)
    a = my - b * mx
    res = sorted(rows, key=lambda r: (-abs(r["life_expect"] - (a + b * r["fertility"])), r["country"]))
    return [r["country"] for r in res if r["country"] not in exclude][:n]


def chart(rows, year, labeled: set[str], watermark: bool) -> tuple[Axes, Scene]:
    ax = Axes(*PLOT, (0.8, 8.4), (30.0, 86.0))
    sc = Scene(W, H, background="#ffffff")
    if watermark:
        sc.text((PLOT[0] + PLOT[2]) / 2, (PLOT[1] + PLOT[3]) / 2 + 60, str(year), "watermark", "watermark",
                size=170, anchor="middle", fill="#f0f0f0", weight=700)
    ax.decorate(sc, xlabel="Fertility (babies per woman)", ylabel="Life expectancy (years)", size=10.0)
    pmax = rows[0]["pop"]
    for r in rows:  # largest first so small bubbles stay visible
        if r["country"] in labeled:
            continue
        x, y = ax.px(r["fertility"], r["life_expect"])
        sc.circle(x, y, radius(r["pop"], pmax), "bubble", "bubbles", fill=COLORS[r["cluster"]], opacity=0.55,
                  stroke="#ffffff", stroke_width=0.5)
    if watermark:
        lx, ly = PLOT[2] - 190, PLOT[1] + 14
        for k in range(6):
            sc.rect(lx, ly + 15 * k - 8, 9, 9, "swatch", "legend", fill=COLORS[k])
            sc.text(lx + 14, ly + 15 * k, REGIONS[k], "legendtext", "text", size=10, fill="#333333")
    return ax, sc


def items_for(rows, ax, labeled: set[str], big_prefer: bool = False) -> list[dict]:
    pmax = rows[0]["pop"]
    out = []
    for r in rows:
        if r["country"] not in labeled:
            continue
        x, y = ax.px(r["fertility"], r["life_expect"])
        it = {"id": r["country"], "anchor": {"type": "point", "x": round(x, 3), "y": round(y, 3),
                                             "mark": {"shape": "circle", "r": radius(r["pop"], pmax)}},
              "label": {"type": "text", "text": r["country"]},
              "attrs": {"pop": r["pop"], "life_expect": r["life_expect"], "fertility": r["fertility"],
                        "region": REGIONS[r["cluster"]]}}
        out.append(it)
    return out


def problem(items, obstacles, internal: str | None) -> dict:
    p = base_problem(W, H, "scatter", font_size=11.0)
    p["items"] = items
    p["priority"] = {"terms": [{"attr": "pop", "transform": "log1p", "normalize": "minmax"}]}
    p["obstacles"] = obstacles
    if internal:
        p["placement"] = {"internal": internal, "models": ["internal", "adjacent", "slider", "distant"]}
    return p


def main() -> None:
    wr = Writer(SCENARIO, "Gapminder bubble chart", SOURCES,
                notes="62 countries (vega-datasets gapminder.json), bubble area proportional to population.")
    rows = load(2005)
    top = {r["country"] for r in rows[:40]}
    labeled = top | set(outliers(rows, 6, top))
    ax, sc = chart(rows, 2005, labeled, watermark=False)
    p = problem(items_for(rows, ax, labeled), {"vector": sc.vector_layers()}, "prefer")
    merge_avoid(p, {"grid": 0.2, "bubbles": 0.5}, {"grid": 0.1, "bubbles": 0.3})
    wr.config("y2005-vector", p, quick=True, png=png_bytes(sc.png()),
              description="2005: 46 labeled bubbles (40 largest + 6 outliers); internal labels preferred.")
    ax, sc = chart(rows, 2005, labeled, watermark=True)
    p = problem(items_for(rows, ax, labeled), {"svg": svg_source(sc)}, "prefer")
    merge_avoid(p, {"grid": 0.2, "bubbles": 0.5, "watermark": 0.05, "legend": "hard"},
                {"grid": 0.1, "bubbles": 0.3, "watermark": 0.0}, ignore_background=True)
    wr.config("y2005-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="2005 on an SVG chart with a year watermark (soft) and a region legend (hard).")
    rows = load(1955)
    labeled = {r["country"] for r in rows}
    ax, sc = chart(rows, 1955, labeled, watermark=False)
    p = problem(items_for(rows, ax, labeled), {"vector": sc.vector_layers()}, None)
    merge_avoid(p, {"grid": 0.2}, {"grid": 0.1})
    wr.config("y1955-all-vector", p, png=png_bytes(sc.png()),
              description="1955: all 62 countries labeled; default internal policy (auto).")
    wr.finish()


if __name__ == "__main__":
    main()
