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
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.scenario import Writer, base_problem  # noqa: E402
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


def main() -> None:
    wr = Writer(SCENARIO, "Priority and omission showcase", M.SOURCES + A.SOURCES,
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
                          description=f"{ds}: {len(items)} items, priority '{ptype}', omission '{mode}'.")
    wr.finish()


if __name__ == "__main__":
    main()
