"""Third-party label placement baselines of the benchmark (brief §8.3).

Each adapter translates a scenario problem into the tool's native input, runs
the tool and converts its output back into a result.v1 document, so the same
evaluator and renderer score every solver. Methods, parameters and emulations:
bench/baselines/README.md.

=============  ==============================================  ===============================
solver name    tool                                            toolchain
=============  ==============================================  ===============================
textalloc      textalloc (Python, matplotlib)                  bench/baselines/requirements.txt
adjusttext     adjustText ≥ 1.0 (Python, matplotlib)           bench/baselines/requirements.txt
vega-label     Vega's label transform, headless (Node)         npm ci --prefix bench/baselines
ggrepel        ggplot2 + ggrepel, positions after grid.force   Rscript + bench/baselines/install-r.sh
d3fc           d3fc-label-layout removeOverlaps(greedy) (Node) npm ci --prefix bench/baselines
echarts        ECharts scatter labels, hideOverlap (Node, SSR) npm ci --prefix bench/baselines
d3-labeler     D3-Labeler simulated annealing (Node, vendored) bench/baselines/vendor/d3-labeler
=============  ==============================================  ===============================

    python -m bench.baselines NAME problem.json -o result.json
"""
from __future__ import annotations

import importlib
from dataclasses import dataclass


class Unsupported(Exception):
    """The tool cannot run this problem at all (reported as "n/a" with the reason, not as an error)."""


@dataclass(frozen=True)
class Baseline:
    name: str
    module: str
    toolchain: str

    def load(self):
        return importlib.import_module(self.module)

    def check(self) -> str | None:
        """None when the toolchain is present, else the reason the baseline must be skipped."""
        try:
            mod = self.load()
        except ImportError as e:  # pragma: no cover - the adapters import lazily
            return f"cannot import {self.module}: {e}"
        return mod.available()

    def solve(self, problem: dict, problem_path=None, options: dict | None = None) -> dict:
        """``options``: ``soft`` (``hard``: soft classes are avoided like hard ones, the default; ``ignore``:
        they are left out) and the adapter's own sequence options."""
        return self.load().solve(problem, problem_path, options)

    def sequence_options(self, frames, soft: str = "hard") -> dict:
        """Options for every frame of a sequence (``(problem, path)`` pairs): ``soft`` and, when the adapter
        plans them, its own (adjustText: one budget for the whole sequence); may raise ``Unsupported``."""
        mod = self.load()
        return mod.sequence_options(frames, soft) if hasattr(mod, "sequence_options") else {"soft": soft}

    def version(self) -> str | None:
        return self.load().version()

    @property
    def uses_obstacles(self) -> bool:
        """Whether the tool is told the obstacle classes (otherwise the soft emulations give the same result)."""
        return getattr(self.load(), "OBSTACLES", True)


BASELINES: dict[str, Baseline] = {
    "textalloc": Baseline("textalloc", "bench.baselines.textalloc_baseline",
                          "Python: matplotlib + textalloc (pip install -r bench/baselines/requirements.txt)"),
    "adjusttext": Baseline("adjusttext", "bench.baselines.adjusttext_baseline",
                           "Python: matplotlib + adjustText ≥ 1.0 (pip install -r bench/baselines/requirements.txt)"),
    "vega-label": Baseline("vega-label", "bench.baselines.vega_label_baseline",
                           "Node ≥ 20 + vega + canvas (npm ci --prefix bench/baselines)"),
    "ggrepel": Baseline("ggrepel", "bench.baselines.ggrepel_baseline",
                        "R: Rscript + ggplot2 + ggrepel + jsonlite (bench/baselines/install-r.sh)"),
    "d3fc": Baseline("d3fc", "bench.baselines.d3fc_baseline",
                     "Node ≥ 20 + @d3fc/d3fc-label-layout (npm ci --prefix bench/baselines)"),
    "echarts": Baseline("echarts", "bench.baselines.echarts_baseline",
                        "Node ≥ 20 + echarts (npm ci --prefix bench/baselines)"),
    "d3-labeler": Baseline("d3-labeler", "bench.baselines.d3_labeler_baseline",
                           "Node ≥ 20 + the vendored labeler.js (bench/baselines/vendor/d3-labeler)"),
}
