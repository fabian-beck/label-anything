"""JSON encoding of problems (NumPy values, paths, dates and the helper classes included).

Dates and times (``datetime``, ``date``, ``time``, pandas ``Timestamp``, NumPy
``datetime64``) become ISO 8601 strings, which compare chronologically in expressions
(``attrs.when >= "2024-01-15"``); durations (``timedelta``, pandas ``Timedelta``, NumPy
``timedelta64``) become seconds; ``NaT`` becomes ``null``.
"""

from __future__ import annotations

import datetime as _dt
import json
import math
import os
from collections.abc import Iterable, Mapping
from typing import Any, Optional, Tuple

from ._errors import ValidationError

_MISSING = object()


def _temporal(o: Any) -> Any:
    """The JSON value of a date, time or duration, or ``_MISSING`` for anything else."""
    if type(o).__name__ == "NaTType":  # pandas NaT (a datetime subclass)
        return None
    if isinstance(o, (_dt.datetime, _dt.date, _dt.time)):
        return o.isoformat()
    if isinstance(o, _dt.timedelta):
        return o.total_seconds()
    kind = getattr(getattr(o, "dtype", None), "kind", None)
    if kind in ("M", "m") and getattr(o, "shape", None) != ():  # arrays: element by element
        return list(o)
    if kind in ("M", "m"):  # NumPy datetime64 / timedelta64
        import numpy as np

        if np.isnat(o):
            return None
        if kind == "m":
            return float(o / np.timedelta64(1, "us")) / 1e6
        days = np.datetime_data(o.dtype)[0] in ("Y", "M", "W", "D")
        v = o.astype("datetime64[D]" if days else "datetime64[us]").item()
        t = _temporal(v)  # a date or datetime; an int outside their range
        return v if t is _MISSING else t
    return _MISSING


def _default(o: Any) -> Any:
    conv = getattr(o, "__la_json__", None)
    if conv is not None:
        return conv()
    t = _temporal(o)
    if t is not _MISSING:
        return t
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


def pointer_token(k: Any) -> str:
    """A key as a JSON Pointer reference token (RFC 6901 escapes)."""
    return str(k).replace("~", "~0").replace("/", "~1")


def find_non_finite(o: Any, pointer: str = "") -> Optional[str]:
    """JSON Pointer of the first NaN or infinite number in a plain value."""
    if isinstance(o, float) and not math.isfinite(o):
        return pointer
    if isinstance(o, dict):
        for k, v in o.items():
            p = find_non_finite(v, f"{pointer}/{pointer_token(k)}")
            if p is not None:
                return p
    elif isinstance(o, list):
        for i, v in enumerate(o):
            p = find_non_finite(v, f"{pointer}/{i}")
            if p is not None:
                return p
    return None


def find_unencodable(o: Any, pointer: str = "") -> Optional[Tuple[str, Any]]:
    """JSON Pointer and value of the first value that has no JSON encoding."""
    if o is None or isinstance(o, (str, bool, int, float)):
        return None
    if isinstance(o, Mapping):
        items: Iterable[Tuple[str, Any]] = ((f"{pointer}/{pointer_token(k)}", v) for k, v in o.items())
    elif isinstance(o, (list, tuple)):
        items = ((f"{pointer}/{i}", v) for i, v in enumerate(o))
    else:
        try:
            conv = _default(o)
        except TypeError:
            return pointer, o
        return find_unencodable(conv, pointer)
    for p, v in items:
        found = find_unencodable(v, p)
        if found is not None:
            return found
    return None


def dumps(o: Any, *, indent: Optional[int] = None) -> str:
    """Encode a problem as JSON text; NaN or infinity raise :class:`ValidationError`, values
    without a JSON encoding a ``TypeError`` naming their JSON Pointer."""
    try:
        return json.dumps(
            o,
            default=_default,
            allow_nan=False,
            ensure_ascii=False,
            indent=indent,
            separators=None if indent is not None else (",", ":"),
        )
    except TypeError as e:
        found = find_unencodable(o)
        if found is None:
            raise
        at, value = found
        raise TypeError(
            f"{at or '/'}: a value of type {type(value).__name__!r} has no JSON encoding "
            "(use numbers, strings, booleans, dates, lists or dicts)"
        ) from e
    except ValueError as e:
        if "Out of range float" not in str(e):
            raise
        at = find_non_finite(plain(o)) or ""
        raise ValidationError.single(
            at, "invalid_value", "numbers must be finite (got NaN or infinity)"
        ) from None
