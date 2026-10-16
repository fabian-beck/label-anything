"""Small value types shared by the API and the callbacks."""

from __future__ import annotations

from typing import Any, Dict, NamedTuple, Tuple, TypedDict, Union

#: A point ``(x, y)``.
Point = Tuple[float, float]
#: A length: pixels, or a string with a unit (``"0.5em"``, ``"8pt"``, ``"3px"``).
Length = Union[float, str]
#: A JSON object.
JSONDict = Dict[str, Any]


class Issue(TypedDict):
    """One validation error or warning (``pointer`` is an RFC 6901 JSON Pointer)."""

    pointer: str
    code: str
    message: str


class FontSpec(NamedTuple):
    """The resolved font passed to a ``measure`` callback (``size`` in px)."""

    family: str
    weight: int
    italic: bool
    size: float


class TextMetrics(NamedTuple):
    """What a ``measure`` callback returns (px; ``ascent`` and ``descent`` positive).

    A dict with the same keys or a plain ``(width, ascent, descent)`` tuple works too.
    """

    width: float
    ascent: float
    descent: float


class BBox(NamedTuple):
    """An axis-aligned box in canvas pixels (origin top-left, y down)."""

    x: float
    y: float
    w: float
    h: float

    @property
    def x0(self) -> float:
        return self.x

    @property
    def y0(self) -> float:
        return self.y

    @property
    def x1(self) -> float:
        return self.x + self.w

    @property
    def y1(self) -> float:
        return self.y + self.h

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def center(self) -> Point:
        return (self.cx, self.cy)

    def contains(self, x: float, y: float) -> bool:
        """Whether the point lies inside the box (edges included)."""
        return self.x <= x <= self.x1 and self.y <= y <= self.y1

    def intersects(self, other: BBox, tol: float = 0.0) -> bool:
        """Whether the interiors overlap by more than ``tol`` px in both directions."""
        return (
            min(self.x1, other.x1) - max(self.x, other.x) > tol
            and min(self.y1, other.y1) - max(self.y, other.y) > tol
        )


class Candidate(NamedTuple):
    """A candidate position passed to a ``cost`` callback."""

    #: Item id.
    id: str
    #: Label box (canvas px).
    box: BBox
    #: Whether the candidate has a leader line.
    leader: bool
