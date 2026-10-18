"""Label Anything: a label placement engine for charts, maps and diagrams.

Place text, icons or any sized label next to points, areas and shapes, avoid what must
not be covered (vector obstacles, SVG or raster backgrounds), draw leaders without
crossings, and omit labels in a user-defined priority order when space runs out.

Three ways to describe a problem:

* the one-call API :func:`place` (positional anchors and labels, keyword options that
  map 1:1 to schema fields);
* the builder :class:`Problem` (fluent methods, ``build()`` gives the problem dict);
* the raw JSON API :func:`place_problem` / :func:`validate` for anything else.

Plotting helpers live in ``label_anything.matplotlib``, ``.plotly`` and ``.seaborn``
(``pip install "label-anything[matplotlib]"``).
"""

from __future__ import annotations

from ._api import place, place_problem, render_svg, validate
from ._errors import Cancelled, LabelAnythingError, ValidationError
from ._native import CancelToken, capabilities
from ._native import version as _version
from ._types import BBox, Candidate, FontSpec, Issue, TextMetrics
from .labels import Area, Box, Composite, Font, Icon, Leaders, Mark, Text, Wrap
from .priority import Priority
from .problem import Problem
from .result import Leader, Placement, Report, Result

__version__: str = _version()


def version() -> str:
    """Version of the engine (e.g. ``"0.1.0"``)."""
    return _version()


__all__ = [
    "Area",
    "BBox",
    "Box",
    "CancelToken",
    "Cancelled",
    "Candidate",
    "Composite",
    "Font",
    "FontSpec",
    "Icon",
    "Issue",
    "LabelAnythingError",
    "Leader",
    "Leaders",
    "Mark",
    "Placement",
    "Priority",
    "Problem",
    "Report",
    "Result",
    "Text",
    "TextMetrics",
    "ValidationError",
    "Wrap",
    "__version__",
    "capabilities",
    "place",
    "place_problem",
    "render_svg",
    "validate",
    "version",
]
