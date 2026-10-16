"""Fetch scenario 02 data: Galaxy volcanoplot test table (MIT) and nf-core DESeq2 results (MIT)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3]))

from bench.common.fetch import fetch_all  # noqa: E402

SOURCES = ["galaxy-volcano-input", "nfcore-srp254919-deseq2", "nfcore-srp254919-genemeta"]

if __name__ == "__main__":
    fetch_all(SOURCES)
