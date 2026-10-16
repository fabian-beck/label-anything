"""Import guard of the plotting helpers (the optional ``label-anything-extras`` package)."""

from __future__ import annotations

import importlib
from types import ModuleType

_NEEDS = {
    "matplotlib": ("matplotlib", "numpy"),
    "plotly": ("plotly",),
    "seaborn": ("seaborn", "matplotlib", "numpy", "pandas"),
}


def require(name: str) -> ModuleType:
    """Import ``label_anything_extras.<name>`` with a helpful message when it is missing."""
    try:
        return importlib.import_module(f"label_anything_extras.{name}")
    except ImportError as e:
        missing = (e.name or "").split(".")[0]
        if missing in ("label_anything_extras", *_NEEDS[name]):
            raise ImportError(
                f"label_anything.{name} needs the optional plotting helpers "
                f"({missing or 'label_anything_extras'} is not installed): "
                f'pip install "label-anything[{name}]"'
            ) from e
        raise
