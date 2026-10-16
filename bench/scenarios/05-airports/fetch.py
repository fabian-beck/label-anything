"""Fetch scenario 05 data: OpenFlights airports/routes (ODbL) and Natural Earth countries (PD)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["openflights-airports", "openflights-routes", "ne-50m-countries"]

if __name__ == "__main__":
    fetch_all(SOURCES)
