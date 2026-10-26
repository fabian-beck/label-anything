"""Build scenario 09: line charts with labels at the series ends (vega-datasets).

Each series is a ``lines`` obstacle (its polyline, stroke 1.5 px); the item is the
series' last data point (circle r = 2.5, in the series' color: ``attrs.color``) labeled with
the series name. End values crowd (several series end at nearly the same value), so labels
need slider positions or leaders.

Configs:
* ``unemployment-14-vector`` (quick)  unemployment rate by industry 2000–2010 (14 series), vector layers,
                                      positions restricted to right / top-right / bottom-right, distant allowed,
* ``stocks-5-svg``                    five stock prices 2000–2010 on an SVG chart, labels "SYMBOL $price",
* ``life-62-boundary``                life expectancy 1955–2005 of 62 countries (gapminder), one color per
                                      region (as in scenario 03, with a legend), labels in the right margin
                                      (``boundary`` model, stacked) with straight leaders.
"""
from __future__ import annotations

import csv
import datetime as dt
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common import fetch  # noqa: E402
from bench.common.scenario import Axes, Writer, base_problem, merge_avoid, png_bytes, svg_source  # noqa: E402
from bench.common.scene import Scene  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

SCENARIO = "09-line-end-labels"
SOURCES = ["vega-datasets-3.2.1"]
TGZ = None
COLORS = ["#4e79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948", "#b07aa1", "#ff9da7", "#9c755f",
          "#bab0ac", "#86bcb6", "#d37295", "#8cd17d", "#a0cbe8"]


def member(name: str) -> bytes:
    return fetch.read_tar_member(fetch.ensure("vega-datasets-3.2.1", verbose=False), f"package/data/{name}")


def months(y: int, m: int) -> float:
    return y + (m - 1) / 12.0


def year_ticks(lo: float, hi: float, step: int) -> list[float]:
    return [float(y) for y in range(int(lo) + (step - int(lo) % step) % step, int(hi) + 1, step) if lo <= y <= hi]


def palette(series) -> dict[str, str]:
    """One color per series, in name order."""
    return {name: COLORS[k % len(COLORS)] for k, name in enumerate(sorted(series))}


def chart(series: dict[str, list[tuple[float, float]]], W, H, plot, ydom, xlabel, ylabel, colors, xstep=2):
    xs = [x for pts in series.values() for x, _ in pts]
    ax = Axes(*plot, (min(xs), max(xs)), ydom)
    sc = Scene(W, H, background="#ffffff")
    ax.decorate(sc, xlabel=xlabel, ylabel=ylabel, xticks=year_ticks(min(xs), max(xs), xstep),
                tick_fmt=lambda v: f"{v:g}", size=10.0)
    for name, pts in sorted(series.items()):
        sc.polyline([ax.px(x, y) for x, y in pts], "series", "lines", stroke=colors[name], width=1.5)
    return ax, sc


def end_items(series, ax, label_fn, colors) -> list[dict]:
    items = []
    for name, pts in sorted(series.items()):
        x, y = ax.px(*pts[-1])
        items.append({"id": name, "anchor": {"type": "point", "x": round(x, 3), "y": round(y, 3),
                                             "mark": {"shape": "circle", "r": 2.5}},
                      "label": {"type": "text", "text": label_fn(name, pts)},
                      "attrs": {"last": pts[-1][1], "color": colors[name]}})
    return items


def main() -> None:
    wr = Writer(SCENARIO, "Line chart end labels", SOURCES,
                notes="vega-datasets: unemployment-across-industries.json (BLS), stocks.csv, gapminder.json.")
    # 1. unemployment by industry
    u = json.loads(member("unemployment-across-industries.json"))
    series: dict[str, list] = {}
    for r in sorted(u, key=lambda r: (r["series"], r["year"], r["month"])):
        series.setdefault(r["series"], []).append((months(r["year"], r["month"]), float(r["rate"])))
    W, H = 960.0, 560.0
    colors = palette(series)
    ax, sc = chart(series, W, H, (60.0, 20.0, 740.0, H - 60.0), (0.0, 30.0), "Year", "Unemployment rate (%)",
                   colors)
    p = base_problem(W, H, "scatter", font_size=10.0)
    p["items"] = end_items(series, ax, lambda n, pts: n, colors)
    p["obstacles"] = {"vector": sc.vector_layers()}
    p["placement"] = {"position_order": ["right", "top-right", "bottom-right"],
                      "models": ["adjacent", "slider", "distant"]}
    p["priority"] = {"terms": [{"attr": "last"}]}
    merge_avoid(p, {"lines": 2.0, "grid": 0.2}, {"lines": 0.5, "grid": 0.1})
    wr.config("unemployment-14-vector", p, quick=True, svg=sc.svg(), png=png_bytes(sc.png()),
              description="14 industries; labels at the series ends (positions to the right only; distant labels "
                          "allowed).")
    # 2. stocks on an SVG chart
    rows = list(csv.DictReader(io.StringIO(member("stocks.csv").decode("utf-8"))))
    series = {}
    for r in rows:
        d = dt.datetime.strptime(r["date"], "%b %d %Y")
        series.setdefault(r["symbol"], []).append((months(d.year, d.month), float(r["price"])))
    for k in series:
        series[k].sort()
    W, H = 900.0, 520.0
    colors = palette(series)
    ax, sc = chart(series, W, H, (60.0, 20.0, 760.0, H - 60.0), (0.0, 800.0), "Year", "Price (USD)", colors)
    p = base_problem(W, H, "scatter", font_size=11.0)
    p["items"] = end_items(series, ax, lambda n, pts: f"{n} ${pts[-1][1]:.2f}", colors)
    p["obstacles"] = {"svg": svg_source(sc)}
    p["placement"] = {"position_order": ["right", "top-right", "bottom-right", "top", "bottom"]}
    merge_avoid(p, {"lines": 2.0, "grid": 0.2}, {"lines": 0.5, "grid": 0.1}, ignore_background=True)
    wr.config("stocks-5-svg", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
              description="Five stock series on an SVG chart, labels with the last price.")
    # 3. life expectancy of 62 countries, boundary labels; lines in the colors of their regions
    g = json.loads(member("gapminder.json"))
    series = {}
    region = {}
    for r in sorted(g, key=lambda r: (r["country"], r["year"])):
        series.setdefault(r["country"], []).append((float(r["year"]), float(r["life_expect"])))
        region[r["country"]] = r["cluster"]
    G03 = load_module("03", "build")
    colors = {name: G03.COLORS[region[name]] for name in series}
    W, H = 900.0, 1000.0
    ax, sc = chart(series, W, H, (60.0, 20.0, 640.0, H - 60.0), (20.0, 85.0), "Year", "Life expectancy (years)",
                   colors, xstep=10)
    lx, ly = 440.0, 820.0
    for k in sorted(G03.REGIONS):
        sc.rect(lx, ly + 15 * k - 8, 9, 9, "swatch", "legend", fill=G03.COLORS[k])
        sc.text(lx + 14, ly + 15 * k, G03.REGIONS[k], "legendtext", "text", size=10, fill="#333333")
    p = base_problem(W, H, "scatter", font_size=10.0)
    p["items"] = end_items(series, ax, lambda n, pts: n, colors)
    for it in p["items"]:
        it["attrs"]["region"] = G03.REGIONS[region[it["id"]]]
    p["obstacles"] = {"vector": sc.vector_layers()}
    p["placement"] = {"models": ["adjacent", "boundary"], "position_order": ["right"],
                      "boundary": {"sides": ["right"], "align": "stack", "gap": 1, "margin": 6}}
    p["leaders"] = {"style": "straight", "port": "side-center"}
    merge_avoid(p, {"lines": 2.0, "grid": 0.2}, {"lines": 0.3, "grid": 0.05})
    wr.config("life-62-boundary", p, svg=sc.svg(), png=png_bytes(sc.png()),
              description="62 life-expectancy series; end labels stacked in the right margin (boundary model).")
    wr.finish()


if __name__ == "__main__":
    main()
