"""Repository paths used by the benchmark."""
from __future__ import annotations

from pathlib import Path

BENCH = Path(__file__).resolve().parents[1]
REPO = BENCH.parent
SPEC = REPO / "spec"
FONTS = REPO / "fonts"
SCENARIOS = BENCH / "scenarios"
DATA = BENCH / "data"          # fetched third-party data (gitignored)
OUT = BENCH / "out"            # generated problems, truths, backgrounds (gitignored)
PROBLEMS = OUT / "problems"
REPORT = REPO / "bench-report"  # runner output (gitignored)


def scenario_out(scenario: str) -> Path:
    """Output directory of one scenario's problems (created on demand)."""
    p = PROBLEMS / scenario
    p.mkdir(parents=True, exist_ok=True)
    return p


def data_dir(name: str) -> Path:
    """Directory for one fetched source (created on demand)."""
    p = DATA / name
    p.mkdir(parents=True, exist_ok=True)
    return p
