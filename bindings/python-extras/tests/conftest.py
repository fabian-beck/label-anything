"""Headless plotting for the helper tests."""

from __future__ import annotations

import os
from typing import Iterator

os.environ.setdefault("MPLBACKEND", "Agg")

import pytest  # noqa: E402


@pytest.fixture(autouse=True)
def _close_figures() -> Iterator[None]:
    yield None
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        return
    plt.close("all")
