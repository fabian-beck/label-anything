"""Fetch scenario 08 data: the scikit-image 0.26.0 sdist (PyPI), which bundles the sample images."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["scikit-image-0.26.0-sdist"]

if __name__ == "__main__":
    fetch_all(SOURCES)
