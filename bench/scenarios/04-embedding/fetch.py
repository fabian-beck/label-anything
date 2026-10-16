"""Fetch scenario 04 data: WordNet 3.0 as distributed by NLTK (nltk_data, pinned commit).

The 2-D embedding is computed (and cached) by build.py; it takes ~10 minutes once."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["nltk-wordnet"]

if __name__ == "__main__":
    fetch_all(SOURCES)
