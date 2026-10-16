"""Fetch scenario 09 data: vega-datasets 3.2.1 (unemployment-across-industries.json, stocks.csv, gapminder.json)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["vega-datasets-3.2.1"]

if __name__ == "__main__":
    fetch_all(SOURCES)
