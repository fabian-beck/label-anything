"""Fetch scenario 06 data: OpenStreetMap extract of Monaco (ODbL, © OpenStreetMap contributors)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["osm-monaco"]

if __name__ == "__main__":
    fetch_all(SOURCES)
