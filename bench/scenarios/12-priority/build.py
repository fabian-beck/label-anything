"""Build scenario 12: priority showcase on scenarios 01 and 05.

Every item of both datasets is labeled, far more than fit, so the priority
function and the omission semantics decide what is shown:

* datasets: ``metrics`` (all 1,206 React Native classes, FQCN labels, CBO vs RFC
  scatterplot of scenario 01) and ``airports`` (all served airports, city
  labels, world map of scenario 05),
* priority types: ``attr`` (RFC / routes, log1p), ``outlier`` (built-in
  ``{"builtin": "outlierness", "k": 5}``), ``coverage`` (attribute priority plus
  ``priority.coverage``: at least one label per area of the code base / per country),
* omission modes: ``strict``, ``prefix``, ``weighted``.

18 problems named ``<dataset>-<type>-<mode>``; quick suite: ``metrics-attr-strict``.

Two more on the Europe map of scenario 05 (``europe-attr-strict``, ``europe-attr-prefix``): the
250 busiest airports in the window are items with city labels, every other airport a context dot
(soft ``points``); priority = routes.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.scenario import Writer, base_problem, png_bytes  # noqa: E402
from bench.scenarios import load_module  # noqa: E402

M = load_module("01", "metrics")
B1 = load_module("01", "build")
A = load_module("05", "airports")
B5 = load_module("05", "build")
SCENARIO = "12-priority"
MODES = ["strict", "prefix", "weighted"]


def metrics_items():
    ms = M.load_metrics()
    ax, pts, _xt, _yt = B1.chart(ms, lambda m: m.cbo, lambda m: m.rfc, "CBO", "RFC")
    outl = M.knn_outlierness(pts, 5)
    return B1.make_items(ms, pts, outl, range(len(ms)))


def airport_items():
    aps = [a for a in A.load_airports() if A.WORLD.lat1 + 0.5 <= a.lat <= A.WORLD.lat0 - 0.5]
    ids = B5.unique_ids(aps)
    return B5.items_for(aps, A.WORLD, lambda a: a.city, ids)


PRIORITIES = {
    "metrics": {
        "attr": {"terms": [{"attr": "rfc", "transform": "log1p"}]},
        "outlier": {"terms": [{"builtin": "outlierness", "k": 5}]},
        "coverage": {"terms": [{"attr": "rfc", "transform": "log1p"}],
                     "coverage": {"by": "attrs.area", "min_per_group": 1}},
    },
    "airports": {
        "attr": {"terms": [{"attr": "routes", "transform": "log1p"}]},
        "outlier": {"terms": [{"builtin": "outlierness", "k": 5}]},
        "coverage": {"terms": [{"attr": "routes", "transform": "log1p"}],
                     "coverage": {"by": "attrs.country", "min_per_group": 1}},
    },
}


def europe_problems(wr: Writer) -> None:
    """The 250 busiest airports of scenario 05's Europe window, the others as context dots."""
    eu = B5.Equirect(-12.0, 32.0, 61.0, 35.0, 1320.0, 780.0)
    aps = [a for a in A.load_airports() if B5.in_window(a, eu, eu.width, eu.height)]
    ids = B5.unique_ids(aps)
    cities: dict[str, int] = {}
    for a in aps[:250]:
        cities[a.city] = cities.get(a.city, 0) + 1

    def label(a):
        return a.city if cities[a.city] == 1 else f"{a.city} ({a.code})"

    for mode in ("strict", "prefix"):
        p, sc = B5.hubs_problem(eu, aps, 0, 250, label, ids, 9.0, None, 10.0, 0.4)
        p["priority"]["omission"] = mode
        wr.config(f"europe-attr-{mode}", p, truth=sc.truth(), svg=sc.svg(), png=png_bytes(sc.png()),
                  description=f"Europe: the 250 busiest airports and unlabeled context points; priority by "
                              f"attribute, {mode} omission.")


def main() -> None:
    wr = Writer(SCENARIO, "Priority types and omission modes", M.SOURCES + A.SOURCES,
                notes="All items labeled; priority terms x omission modes decide the placed set.")
    datasets = {
        "metrics": (metrics_items(), (B1.W, B1.H), "scatter", 10.0),
        "airports": (airport_items(), (A.WORLD.width, A.WORLD.height), "map", 9.0),
    }
    for ds, (items, (W, H), preset, font) in datasets.items():
        for ptype, prio in PRIORITIES[ds].items():
            for mode in MODES:
                p = base_problem(W, H, preset, font_size=font)
                p["items"] = items
                p["priority"] = dict(prio, omission=mode)
                name = f"{ds}-{ptype}-{mode}"
                wr.config(name, p, quick=(name == "metrics-attr-strict"),
                          description=f"{ds}: {len(items):,} items; priority type {ptype}, {mode} omission.")
    europe_problems(wr)
    wr.finish()


if __name__ == "__main__":
    main()
