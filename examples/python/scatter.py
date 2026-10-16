"""Label the outliers of a scatter plot with Label Anything (matplotlib).

    pip install "label-anything[matplotlib]"
    python examples/python/scatter.py [--out DIR]

Plots classes of a (synthetic) code base by size and coupling, labels the most
interesting ones (outliers first, then high coupling, short labels preferred) and writes

* ``scatter.png``: the labeled figure;
* ``debug.svg``: the engine's debug overlay (marks, obstacles, label boxes, leaders).

The figure is rendered without its texts as the raster background, so labels avoid the
points, the trend line and the legend; titles and tick labels stay outside the axes.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

import label_anything as la  # noqa: E402
from label_anything.matplotlib import label_points  # noqa: E402

PACKAGES = ["billing", "core", "io", "net", "ui", "auth", "report", "sync"]
WORDS = ["Invoice", "Session", "Cache", "Parser", "Account", "Stream", "Token", "Layout", "Queue", "Index", "Policy", "Socket"]
ROLES = ["Service", "Manager", "Factory", "Handler", "Store", "Builder", "Client", "View"]


def class_names(rng: np.random.Generator, n: int) -> list[la.Text]:
    """Unique qualified class names, with the bare class name as the shorter fallback."""
    combos = [(p, w, r) for p in PACKAGES for w in WORDS for r in ROLES]
    out = []
    for k in rng.permutation(len(combos))[:n]:
        pkg, word, role = combos[k]
        out.append(la.Text(f"{pkg}.{word}{role}", alternatives=[f"{word}{role}"]))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--out", type=Path, default=Path.cwd(), help="output directory (default: current)")
    parser.add_argument("--labels", type=int, default=20, help="maximum number of labels")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    rng = np.random.default_rng(42)
    n = 350
    loc = rng.lognormal(5.2, 0.9, n)  # lines of code
    cbo = np.round(1.8 * np.log(loc) + rng.gamma(2.0, 1.6, n)).astype(int)  # coupling
    names = class_names(rng, n)

    fig, ax = plt.subplots(figsize=(8, 5.5), dpi=100)
    ax.scatter(loc, cbo, s=16, color="#8a96a3", alpha=0.85, linewidths=0, label="class")
    trend = np.polyfit(np.log(loc), cbo, 1)
    xs = np.geomspace(loc.min(), loc.max(), 50)
    ax.plot(xs, np.polyval(trend, np.log(xs)), color="#d1495b", linewidth=1.5, label="trend")
    ax.set_xscale("log")
    ax.set_xlabel("Lines of code")
    ax.set_ylabel("Coupling between objects (CBO)")
    ax.set_title("Classes by size and coupling — outliers labeled by Label Anything")
    ax.legend(loc="upper left", frameon=False)

    labels = label_points(
        ax,
        loc,
        cbo,
        names,
        attrs={"cbo": cbo},
        priority=la.Priority.outlierness(k=5)
        + 0.5 * la.Priority.attr("cbo", "log1p")
        - 0.2 * la.Priority.label_size(),
        max_labels=args.labels,
        # keep names on one line at full size: fall back to the short name, then a leader
        degrade=["alternatives", "distant", "evict_lower", "omit"],
        leaders=la.Leaders(style="straight", max_length="7em"),
        fontsize=8,
        text_kw={"color": "#1d2733"},
        leader_kw={"color": "#5c6773", "linewidth": 0.6},
    )
    res = labels.result
    st = res.stats
    print(f"placed {st['placed']} of {st['total']} labels, hard violations: {st['hard_violations']}, "
          f"{st['runtime_ms']:.0f} ms")
    with_leaders = sum(1 for p in res.placed if p.leader is not None)
    shortened = sum(1 for p in res.placed if p.text and p.text.get("used", "original") != "original")
    print(f"{with_leaders} with leaders, {shortened} shortened to the class name")
    print("first omitted (lowest priority first):", ", ".join(res.omission_order[:5]), "...")

    png = args.out / "scatter.png"
    fig.savefig(png, dpi=150)
    svg = args.out / "debug.svg"
    res.to_svg(svg)
    print(f"wrote {png} and {svg}")


if __name__ == "__main__":
    main()
