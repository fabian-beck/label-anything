"""JSON encoding of problems (NumPy values, paths and the helper classes included)."""

from __future__ import annotations

import json
import math
import os
from collections.abc import Iterable, Mapping
from typing import Any, Optional

from ._errors import ValidationError


def _default(o: Any) -> Any:
    conv = getattr(o, "__la_json__", None)
    if conv is not None:
        return conv()
    tolist = getattr(o, "tolist", None)  # NumPy arrays and scalars, pandas Series
    if callable(tolist):
        return tolist()
    if isinstance(o, os.PathLike):
        return os.fspath(o)
    if isinstance(o, Mapping):
        return dict(o)
    if isinstance(o, (set, frozenset)):
        try:
            return sorted(o)
        except TypeError:
            return list(o)
    if isinstance(o, Iterable) and not isinstance(o, (str, bytes)):
        return list(o)
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def plain(o: Any) -> Any:
    """Convert to plain JSON values (dict, list, str, int, float, bool, None)."""
    if o is None or isinstance(o, (str, bool, int, float)):
        return o
    if isinstance(o, dict):
        return {str(k): plain(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [plain(v) for v in o]
    return plain(_default(o))


def _token(k: Any) -> str:
    return str(k).replace("~", "~0").replace("/", "~1")


def find_non_finite(o: Any, pointer: str = "") -> Optional[str]:
    """JSON Pointer of the first NaN or infinite number in a plain value."""
    if isinstance(o, float) and not math.isfinite(o):
        return pointer
    if isinstance(o, dict):
        for k, v in o.items():
            p = find_non_finite(v, f"{pointer}/{_token(k)}")
            if p is not None:
                return p
    elif isinstance(o, list):
        for i, v in enumerate(o):
            p = find_non_finite(v, f"{pointer}/{i}")
            if p is not None:
                return p
    return None


def dumps(o: Any, *, indent: Optional[int] = None) -> str:
    """Encode a problem as JSON text; NaN or infinity raise :class:`ValidationError`."""
    try:
        return json.dumps(
            o,
            default=_default,
            allow_nan=False,
            ensure_ascii=False,
            indent=indent,
            separators=None if indent is not None else (",", ":"),
        )
    except ValueError as e:
        if "Out of range float" not in str(e):
            raise
        at = find_non_finite(plain(o)) or ""
        raise ValidationError.single(
            at, "invalid_value", "numbers must be finite (got NaN or infinity)"
        ) from None
