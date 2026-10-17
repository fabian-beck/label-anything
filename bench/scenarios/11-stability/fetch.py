"""Fetch scenario 11 data (scenario 05's OpenFlights and Natural Earth, scenario 07's Les Misérables)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["openflights-airports", "openflights-routes", "ne-50m-countries", "vega-datasets-3.2.1"]

if __name__ == "__main__":
    fetch_all(SOURCES)
