"""Seaborn helpers: ``label_points(ax, data=df, x="col", y="col", label="col", **opts)``
for axes-level plots.

Re-exported from the optional ``label-anything-extras`` package
(``pip install "label-anything[seaborn]"``).
"""

from __future__ import annotations

from ._extras import require

require("seaborn")

from label_anything_extras.seaborn import label_points  # noqa: E402

__all__ = ["label_points"]
