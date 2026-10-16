"""Matplotlib helpers: ``label_points(ax, x, y, labels, **opts)``.

Re-exported from the optional ``label-anything-extras`` package
(``pip install "label-anything[matplotlib]"``).
"""

from __future__ import annotations

from ._extras import require

require("matplotlib")

from label_anything_extras.matplotlib import (  # noqa: E402
    MatplotlibLabels,
    figure_background,
    label_points,
    text_measure,
)

__all__ = ["MatplotlibLabels", "figure_background", "label_points", "text_measure"]
