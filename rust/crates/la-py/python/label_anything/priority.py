"""``Priority``: a builder for ``priority.terms`` (spec §9).

Terms combine with ``+`` and ``-`` and scale with a number::

    la.Priority.outlierness(k=5) + 0.5 * la.Priority.attr("cbo", "log1p") \\
        - 0.2 * la.Priority.label_size()

gives the terms ``outlierness(k=5)`` (weight 1), ``attr cbo`` with ``log1p`` (weight 0.5)
and ``label_size`` (weight -0.2). Each term's raw value is transformed, normalized over
all items (``rank`` by default) and weighted; the item's score is the sum.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

from ._types import JSONDict

__all__ = ["Priority"]

_TRANSFORMS = ("none", "log1p", "sqrt", "neg", "abs")
_NORMALIZE = ("rank", "minmax", "none")


def _term(
    kind: str,
    value: Any,
    *,
    transform: Optional[str] = None,
    normalize: Optional[str] = None,
    k: Optional[int] = None,
) -> JSONDict:
    if transform is not None and transform not in _TRANSFORMS:
        raise ValueError(f"transform must be one of {', '.join(_TRANSFORMS)} (got {transform!r})")
    if normalize is not None and normalize not in _NORMALIZE:
        raise ValueError(f"normalize must be one of {', '.join(_NORMALIZE)} (got {normalize!r})")
    d: Dict[str, Any] = {kind: value}
    if k is not None:
        d["k"] = int(k)
    if transform is not None:
        d["transform"] = transform
    if normalize is not None:
        d["normalize"] = normalize
    return d


class Priority:
    """A weighted sum of priority terms; ``to_terms()`` gives ``priority.terms``."""

    __slots__ = ("_terms",)

    def __init__(self, terms: Tuple[Tuple[JSONDict, float], ...] = ()) -> None:
        self._terms = tuple((dict(t), float(w)) for t, w in terms)

    # --- constructors -------------------------------------------------------------
    @classmethod
    def builtin(
        cls,
        name: str,
        *,
        k: Optional[int] = None,
        transform: Optional[str] = None,
        normalize: Optional[str] = None,
    ) -> Priority:
        """A built-in term by name (``outlierness``, ``isolation``, ``crowding``, ...)."""
        return cls(((_term("builtin", name, transform=transform, normalize=normalize, k=k), 1.0),))

    @classmethod
    def outlierness(
        cls,
        k: Optional[int] = None,
        *,
        transform: Optional[str] = None,
        normalize: Optional[str] = None,
    ) -> Priority:
        """Mean distance to the ``k`` nearest neighbours (default ``k`` = 5)."""
        return cls.builtin("outlierness", k=k, transform=transform, normalize=normalize)

    @classmethod
    def isolation(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Distance to the nearest other item."""
        return cls.builtin("isolation", transform=transform, normalize=normalize)

    @classmethod
    def crowding(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Number of items nearby."""
        return cls.builtin("crowding", transform=transform, normalize=normalize)

    @classmethod
    def label_size(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Label area (use a negative weight to favour short labels)."""
        return cls.builtin("label_size", transform=transform, normalize=normalize)

    @classmethod
    def mark_size(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Area of the item's mark."""
        return cls.builtin("mark_size", transform=transform, normalize=normalize)

    @classmethod
    def centrality(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Closeness to ``priority.focus`` (default: the canvas center)."""
        return cls.builtin("centrality", transform=transform, normalize=normalize)

    @classmethod
    def degree(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Node degree (``attrs.degree``) for graphs."""
        return cls.builtin("degree", transform=transform, normalize=normalize)

    @classmethod
    def input_order(cls, *, transform: Optional[str] = None, normalize: Optional[str] = None) -> Priority:
        """Earlier items first."""
        return cls.builtin("input_order", transform=transform, normalize=normalize)

    @classmethod
    def attr(
        cls,
        name: str,
        transform: Optional[str] = None,
        *,
        normalize: Optional[str] = None,
    ) -> Priority:
        """An item attribute (``item.attrs[name]``), e.g. ``attr("cbo", "log1p")``."""
        return cls(((_term("attr", name, transform=transform, normalize=normalize), 1.0),))

    @classmethod
    def expr(
        cls,
        src: str,
        transform: Optional[str] = None,
        *,
        normalize: Optional[str] = None,
    ) -> Priority:
        """An expression (``spec/expr.peg``), e.g. ``expr("attrs.a * attrs.b")``."""
        return cls(((_term("expr", src, transform=transform, normalize=normalize), 1.0),))

    # --- algebra ------------------------------------------------------------------
    def __add__(self, other: object) -> Priority:
        if not isinstance(other, Priority):
            return NotImplemented
        return Priority(self._terms + other._terms)

    def __sub__(self, other: object) -> Priority:
        if not isinstance(other, Priority):
            return NotImplemented
        return self + (-other)

    def __mul__(self, w: object) -> Priority:
        if isinstance(w, bool) or not isinstance(w, (int, float)):
            try:
                w = float(w)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                return NotImplemented
        return Priority(tuple((t, wt * float(w)) for t, wt in self._terms))

    __rmul__ = __mul__

    def __truediv__(self, w: object) -> Priority:
        if not isinstance(w, (int, float)) or isinstance(w, bool):
            return NotImplemented
        return self * (1.0 / w)

    def __neg__(self) -> Priority:
        return self * -1.0

    def __pos__(self) -> Priority:
        return self

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Priority) and self.to_terms() == other.to_terms()

    def __hash__(self) -> int:
        return hash(repr(self))

    def __len__(self) -> int:
        return len(self._terms)

    def normalized(self, how: str) -> Priority:
        """The same terms with another normalization (``rank``, ``minmax`` or ``none``)."""
        if how not in _NORMALIZE:
            raise ValueError(f"normalize must be one of {', '.join(_NORMALIZE)}")
        return Priority(tuple(({**t, "normalize": how}, w) for t, w in self._terms))

    def to_terms(self) -> List[JSONDict]:
        """``priority.terms`` (``weight`` is omitted when it is 1)."""
        out: List[JSONDict] = []
        for t, w in self._terms:
            d = dict(t)
            if w != 1.0:
                d["weight"] = w
            out.append(d)
        return out

    def __la_json__(self) -> List[JSONDict]:
        return self.to_terms()

    def __repr__(self) -> str:
        parts: List[str] = []
        for i, (t, w) in enumerate(self._terms):
            kind = "builtin" if "builtin" in t else ("attr" if "attr" in t else "expr")
            args = [repr(t[kind])] if kind != "builtin" else []
            name = t[kind] if kind == "builtin" else kind
            if "k" in t:
                args.append(f"k={t['k']}")
            if "transform" in t:
                args.append(repr(t["transform"]) if kind != "builtin" else f"transform={t['transform']!r}")
            if "normalize" in t:
                args.append(f"normalize={t['normalize']!r}")
            call = f"{name}({', '.join(args)})"
            sign = "-" if w < 0 else "+"
            mag = abs(w)
            body = call if mag == 1.0 else f"{mag:g}*{call}"
            if i == 0:
                parts.append(body if sign == "+" else f"-{body}")
            else:
                parts.append(f" {sign} {body}")
        return f"Priority({''.join(parts)})"
