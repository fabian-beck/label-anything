"""Fetch scenario 01 data: the react-native 0.63.5 npm tarball (MIT), SHA-256 verified.

The Java sources are extracted and measured by build.py (CkLite.java, needs a JDK)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["react-native-0.63.5"]

if __name__ == "__main__":
    fetch_all(SOURCES)
