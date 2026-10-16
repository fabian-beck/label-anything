"""Plotly helpers: ``label_points(fig, x, y, labels, **opts)`` returns layout annotations
and leader shapes.

Re-exported from the optional ``label-anything-extras`` package
(``pip install "label-anything[plotly]"``).
"""

from __future__ import annotations

from ._extras import require

require("plotly")

from label_anything_extras.plotly import PlotlyLabels, label_points  # noqa: E402

__all__ = ["PlotlyLabels", "label_points"]
