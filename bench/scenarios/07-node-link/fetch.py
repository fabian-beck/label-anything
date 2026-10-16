"""Fetch scenario 07 data: vega-datasets (miserables.json) and the Cora citation network (pygcn copy)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["vega-datasets-3.2.1", "cora-cites", "cora-content"]

if __name__ == "__main__":
    fetch_all(SOURCES)
