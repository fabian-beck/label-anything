"""What the plotting helpers share: their defaults and the handling of per-point options."""

from __future__ import annotations

import copy
from typing import Any, Dict, Iterable, List, Mapping, MutableMapping

import label_anything as la

#: With a priority, important labels may cover the dots of less important points, which
#: then go unlabeled (``avoid`` ``lower_items``, ADR priority/lower-items).
LOWER_ITEMS: Dict[str, Any] = {"label": {"lower_items": 10}, "leader": {"lower_items": 2.5}}


def default_avoid(opts: Mapping[str, Any]) -> Dict[str, Any]:
    """The helpers' ``avoid`` before the caller's: ``lower_items`` when a priority is given."""
    if opts.get("priority") is None and opts.get("tiers") is None:
        return {}
    return copy.deepcopy(LOWER_ITEMS)


def item_ids(opts: MutableMapping[str, Any], n: int) -> List[str]:
    """Take ``ids`` out of ``opts``: one id per point (default: the point's index)."""
    given = opts.pop("ids", None)
    ids = [str(i) for i in (given if given is not None else range(n))]
    if len(ids) != n:
        raise ValueError("ids must have one entry per point")
    return ids


def take(v: Any, keep: Any) -> Any:
    """The entries of a per-point value (a sequence, a dict of columns, a pandas object)
    at the indices ``keep``: the points that are passed on to the engine."""
    if v is None:
        return None
    if isinstance(v, Mapping):  # dict of columns
        return {k: [list(col)[i] for i in keep] for k, col in v.items()}
    if hasattr(v, "iloc"):  # pandas
        return v.iloc[keep]
    vals = list(v)
    return [vals[i] for i in keep]


def take_per_item(opts: MutableMapping[str, Any], keep: Any, n: int, keys: Iterable[str]) -> Dict[str, Any]:
    """Reduce the per-point options to the points ``keep`` of the ``n`` given ones.

    The options named in ``keys`` are taken out of ``opts`` and returned; ``priority`` and
    ``tiers`` stay in ``opts`` and are reduced when they hold one number per point (not an
    expression, a :class:`label_anything.Priority`, a callable or a list of tier rules).
    """
    per_item = {k: take(opts.pop(k), keep) for k in keys if k in opts}
    for k in ("priority", "tiers"):
        v = opts.get(k)
        if v is not None and not isinstance(v, (str, Mapping, la.Priority)) and not callable(v):
            vals = list(v)
            if len(vals) == n and all(t is None or isinstance(t, (int, float)) or hasattr(t, "item") for t in vals):
                opts[k] = [vals[i] for i in keep]
    return per_item
