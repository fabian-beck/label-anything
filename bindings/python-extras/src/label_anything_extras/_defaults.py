"""Defaults the plotting helpers share."""

from __future__ import annotations

import copy
from typing import Any, Dict, Mapping

#: With a priority, important labels may cover the dots of less important points, which
#: then go unlabeled (``avoid`` ``lower_items``, ADR priority/lower-items).
LOWER_ITEMS: Dict[str, Any] = {"label": {"lower_items": 10}, "leader": {"lower_items": 2.5}}


def default_avoid(opts: Mapping[str, Any]) -> Dict[str, Any]:
    """The helpers' ``avoid`` before the caller's: ``lower_items`` when a priority is given."""
    if opts.get("priority") is None and opts.get("tiers") is None:
        return {}
    return copy.deepcopy(LOWER_ITEMS)
