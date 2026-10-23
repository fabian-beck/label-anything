"""Fetch scenario 12 data (sources of scenarios 01 and 05)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["react-native-0.63.5", "openflights-airports", "openflights-routes", "ne-50m-countries", "ne-50m-disputed"]

if __name__ == "__main__":
    fetch_all(SOURCES)
