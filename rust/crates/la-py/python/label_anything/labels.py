"""Typed helpers for labels, fonts, leaders, anchors and marks.

Every helper converts to the JSON object of ``spec/schema/problem.v1.json`` with
``to_dict()``; fields left at ``None`` are omitted, so the spec defaults apply.
"""

from __future__ import annotations

import math
import os
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, fields
from typing import Any, ClassVar, Dict, List, Optional, Tuple, Union

from ._errors import ValidationError
from ._types import JSONDict, Length, Point

__all__ = [
    "Area",
    "Box",
    "Composite",
    "Font",
    "Icon",
    "Leaders",
    "Mark",
    "Text",
    "Wrap",
]


def _compact(d: Mapping[str, Any]) -> JSONDict:
    return {k: v for k, v in d.items() if v is not None}


def _points(pts: Iterable[Any]) -> List[List[float]]:
    return [[float(p[0]), float(p[1])] for p in pts]


@dataclass(frozen=True)
class Font:
    """A font request (``family`` ``"default"`` is the bundled Noto Sans)."""

    family: Optional[str] = None
    #: Size in px.
    size: Optional[float] = None
    #: 1-1000, or ``"normal"`` / ``"bold"``.
    weight: Union[int, str, None] = None
    #: ``"normal"`` or ``"italic"``.
    style: Optional[str] = None
    #: Line pitch of wrapped text, in em.
    line_height: Optional[float] = None
    #: A TTF/OTF file path or a ``data:`` URL.
    file: Union[str, "os.PathLike[str]", None] = None

    def to_dict(self) -> JSONDict:
        return _compact(
            {
                "family": self.family,
                "size": self.size,
                "weight": self.weight,
                "style": self.style,
                "line_height": self.line_height,
                "file": os.fspath(self.file) if self.file is not None else None,
            }
        )

    __la_json__ = to_dict


FontLike = Union[Font, Mapping[str, Any], str]


def font_dict(font: FontLike) -> JSONDict:
    """Normalize a font given as :class:`Font`, a dict, or a family name."""
    if isinstance(font, Font):
        return font.to_dict()
    if isinstance(font, str):
        return {"family": font}
    if isinstance(font, Mapping):
        return dict(font)
    raise TypeError(f"font must be a Font, a dict or a family name (got {type(font).__name__})")


@dataclass(frozen=True)
class Wrap:
    """Wrap settings of a text label (``max_width`` in px or with a unit)."""

    max_width: Optional[Length] = None
    max_lines: Optional[int] = None
    balance: Optional[bool] = None

    def to_dict(self) -> JSONDict:
        return _compact(
            {"max_width": self.max_width, "max_lines": self.max_lines, "balance": self.balance}
        )

    __la_json__ = to_dict


WrapLike = Union[Wrap, Mapping[str, Any], float, str, Tuple[Length, int]]


def wrap_dict(wrap: WrapLike) -> JSONDict:
    """Normalize wrap settings: :class:`Wrap`, a dict, a max width, or ``(width, lines)``."""
    if isinstance(wrap, Wrap):
        return wrap.to_dict()
    if isinstance(wrap, Mapping):
        return dict(wrap)
    if isinstance(wrap, tuple):
        if len(wrap) != 2:
            raise ValueError("wrap tuple must be (max_width, max_lines)")
        return Wrap(max_width=wrap[0], max_lines=int(wrap[1])).to_dict()
    if isinstance(wrap, (int, float, str)) and not isinstance(wrap, bool):
        return {"max_width": wrap}
    raise TypeError(f"wrap must be a Wrap, a dict, a width or (width, lines) (got {wrap!r})")


@dataclass(frozen=True)
class Text:
    """A text label."""

    text: str
    #: Shorter fallbacks, in order of preference.
    alternatives: Optional[Sequence[str]] = None
    wrap: Optional[WrapLike] = None
    #: ``"none"``, ``"end"`` or ``"middle"``.
    truncate: Optional[str] = None
    font: Optional[FontLike] = None
    padding: Optional[Length] = None
    #: Host-measured size in px (disables built-in measurement for this label).
    width: Optional[float] = None
    height: Optional[float] = None
    #: Host-wrapped lines matching ``width``/``height``.
    lines: Optional[Sequence[str]] = None
    #: ``"start"``, ``"center"`` or ``"end"`` (reported only).
    align: Optional[str] = None

    def to_dict(self) -> JSONDict:
        return _compact(
            {
                "type": "text",
                "text": self.text,
                "alternatives": list(self.alternatives) if self.alternatives is not None else None,
                "wrap": wrap_dict(self.wrap) if self.wrap is not None else None,
                "truncate": self.truncate,
                "font": font_dict(self.font) if self.font is not None else None,
                "padding": self.padding,
                "width": self.width,
                "height": self.height,
                "lines": list(self.lines) if self.lines is not None else None,
                "align": self.align,
            }
        )

    __la_json__ = to_dict


@dataclass(frozen=True)
class _Sized:
    kind: ClassVar[str] = "icon"
    width: float
    height: float
    #: ``"rect"``, ``"circle"``, ``"rounded:<r>"`` or ``"polygon"``.
    shape: Optional[str] = None
    #: Silhouette for ``shape="polygon"``, relative to the top-left corner.
    polygon: Optional[Sequence[Point]] = None
    padding: Optional[Length] = None
    #: Only used to resolve ``em`` units.
    font: Optional[FontLike] = None

    def to_dict(self) -> JSONDict:
        return _compact(
            {
                "type": self.kind,
                "width": self.width,
                "height": self.height,
                "shape": self.shape,
                "polygon": _points(self.polygon) if self.polygon is not None else None,
                "padding": self.padding,
                "font": font_dict(self.font) if self.font is not None else None,
            }
        )

    __la_json__ = to_dict


@dataclass(frozen=True)
class Icon(_Sized):
    """An icon label of fixed size (px)."""

    kind: ClassVar[str] = "icon"


@dataclass(frozen=True)
class Box(_Sized):
    """A box label of fixed size (px), e.g. a sparkline or a mini chart."""

    kind: ClassVar[str] = "box"


@dataclass(frozen=True)
class Composite:
    """Several parts (text, icons, boxes) laid out in a row or a column."""

    parts: Sequence[Union[Text, Icon, Box, str, Mapping[str, Any]]]
    #: ``"row"`` (default) or ``"column"``.
    direction: Optional[str] = None
    gap: Optional[Length] = None
    #: ``"start"``, ``"center"`` (default) or ``"end"``.
    align: Optional[str] = None
    padding: Optional[Length] = None
    font: Optional[FontLike] = None

    def to_dict(self) -> JSONDict:
        return _compact(
            {
                "type": "composite",
                "direction": self.direction,
                "gap": self.gap,
                "align": self.align,
                "parts": [label_dict(p) for p in self.parts],
                "padding": self.padding,
                "font": font_dict(self.font) if self.font is not None else None,
            }
        )

    __la_json__ = to_dict


LabelLike = Union[str, Text, Icon, Box, Composite, Mapping[str, Any]]


def label_dict(label: Any) -> JSONDict:
    """Normalize a label: a string, a helper object, or a label dict."""
    if isinstance(label, str):
        return {"type": "text", "text": label}
    if isinstance(label, (Text, _Sized, Composite)):
        return label.to_dict()
    if isinstance(label, Mapping):
        d = dict(label)
        if "type" not in d:
            if "parts" in d:
                d["type"] = "composite"
            elif "text" in d:
                d = {"type": "text", **d}
            else:
                raise ValueError(
                    "a label dict needs a 'type' (text, icon, box or composite) or a 'text'"
                )
        return d
    if label is None:
        raise TypeError("a label cannot be None (use an empty string)")
    if isinstance(label, (int, float)) or hasattr(label, "__index__") or hasattr(label, "item"):
        return {"type": "text", "text": str(label)}
    raise TypeError(
        f"a label must be a string, Text, Icon, Box, Composite or dict (got {type(label).__name__})"
    )


@dataclass(frozen=True)
class Leaders:
    """Leader-line settings (spec §7)."""

    #: ``"straight"``, ``"angles"``, ``"orthogonal"``, ``"elbow"`` or ``"curved"``.
    style: Optional[str] = None
    #: Allowed directions in degrees (0 = right, 90 = up), e.g. ``range(0, 360, 45)``.
    angles: Optional[Iterable[float]] = None
    #: ``"nearest"``, ``"side-center"`` or ``"baseline"``.
    port: Optional[str] = None
    #: ``"auto"``, ``"boundary"``, ``"center"`` or ``"tip"``.
    attach: Optional[str] = None
    min_length: Optional[Length] = None
    max_length: Optional[Length] = None
    anchor_gap: Optional[Length] = None
    clearance: Optional[Length] = None
    min_angle_between: Optional[float] = None
    #: Stroke width used for collision tests (px).
    width: Optional[float] = None

    def __post_init__(self) -> None:
        if self.angles is not None and not isinstance(self.angles, tuple):
            object.__setattr__(self, "angles", tuple(float(a) for a in self.angles))

    def to_dict(self) -> JSONDict:
        d: Dict[str, Any] = {}
        for f in fields(self):
            v = getattr(self, f.name)
            if v is not None:
                d[f.name] = list(v) if f.name == "angles" else v
        return d

    __la_json__ = to_dict


LeadersLike = Union[str, Leaders, Mapping[str, Any]]


def leaders_dict(leaders: LeadersLike) -> JSONDict:
    """Normalize leader settings: a style name, :class:`Leaders` or a dict."""
    if isinstance(leaders, str):
        return {"style": leaders}
    if isinstance(leaders, Leaders):
        return leaders.to_dict()
    if isinstance(leaders, Mapping):
        d = dict(leaders)
        if "angles" in d and d["angles"] is not None:
            d["angles"] = [float(a) for a in d["angles"]]
        return d
    raise TypeError(f"leaders must be a style name, Leaders or a dict (got {leaders!r})")


@dataclass(frozen=True)
class Area:
    """An area anchor: the label goes inside the polygon (spec §6.5)."""

    polygon: Sequence[Point]
    holes: Optional[Sequence[Sequence[Point]]] = None
    #: Mark drawn at the pole when the label falls back to an external position.
    dot: Optional[Mapping[str, Any]] = None

    def to_dict(self) -> JSONDict:
        return _compact(
            {
                "type": "area",
                "polygon": _points(self.polygon),
                "holes": [_points(h) for h in self.holes] if self.holes is not None else None,
                "dot": dict(self.dot) if self.dot is not None else None,
            }
        )

    __la_json__ = to_dict


AnchorLike = Union[Point, Sequence[float], Area, Mapping[str, Any]]


def _finite(v: Any, pointer: str) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValidationError.single(pointer, "type", f"expected a number (got {v!r})") from None
    if not math.isfinite(x):
        raise ValidationError.single(
            pointer, "invalid_value", f"coordinates must be finite (got {x})"
        )
    return x


def anchor_dict(anchor: Any, pointer: str = "/anchor") -> JSONDict:
    """Normalize an anchor: ``(x, y)``, :class:`Area`, an anchor dict or an object with
    ``x``/``y`` attributes."""
    if isinstance(anchor, Area):
        return anchor.to_dict()
    if isinstance(anchor, Mapping):
        d = dict(anchor)
        d.setdefault("type", "point" if "x" in d else "area")
        return d
    if isinstance(anchor, (str, bytes)):
        raise TypeError(f"an anchor must be (x, y), Area or a dict (got {anchor!r})")
    try:
        n = len(anchor)
    except TypeError:
        if hasattr(anchor, "x") and hasattr(anchor, "y"):
            return {
                "type": "point",
                "x": _finite(anchor.x, f"{pointer}/x"),
                "y": _finite(anchor.y, f"{pointer}/y"),
            }
        raise TypeError(f"an anchor must be (x, y), Area or a dict (got {anchor!r})") from None
    if n != 2:
        raise ValueError(f"a point anchor needs two coordinates (got {n})")
    return {
        "type": "point",
        "x": _finite(anchor[0], f"{pointer}/x"),
        "y": _finite(anchor[1], f"{pointer}/y"),
    }


class Mark:
    """Constructors for mark shapes (the geometry of a labeled feature, spec §3.2).

    Each returns the mark dict, e.g. ``Mark.circle(4)`` → ``{"shape": "circle", "r": 4}``.
    """

    @staticmethod
    def circle(r: float) -> JSONDict:
        return {"shape": "circle", "r": r}

    @staticmethod
    def ellipse(rx: float, ry: float, rotation: Optional[float] = None) -> JSONDict:
        return _compact({"shape": "ellipse", "rx": rx, "ry": ry, "rotation": rotation})

    @staticmethod
    def rect(
        w: float,
        h: float,
        corner_radius: Optional[float] = None,
        rotation: Optional[float] = None,
    ) -> JSONDict:
        return _compact(
            {"shape": "rect", "w": w, "h": h, "corner_radius": corner_radius, "rotation": rotation}
        )

    @staticmethod
    def polygon(
        points: Sequence[Point],
        holes: Optional[Sequence[Sequence[Point]]] = None,
        relative: Optional[bool] = None,
    ) -> JSONDict:
        return _compact(
            {
                "shape": "polygon",
                "points": _points(points),
                "holes": [_points(h) for h in holes] if holes is not None else None,
                "relative": relative,
            }
        )

    @staticmethod
    def path(d: str, relative: Optional[bool] = None) -> JSONDict:
        return _compact({"shape": "path", "d": d, "relative": relative})

    @staticmethod
    def icon(
        w: float,
        h: float,
        tip: Optional[Point] = None,
        silhouette: Optional[Sequence[Point]] = None,
    ) -> JSONDict:
        return _compact(
            {
                "shape": "icon",
                "w": w,
                "h": h,
                "tip": [float(tip[0]), float(tip[1])] if tip is not None else None,
                "silhouette": _points(silhouette) if silhouette is not None else None,
            }
        )

    @staticmethod
    def from_svg(svg_id: Optional[str] = None, selector: Optional[str] = None) -> JSONDict:
        if (svg_id is None) == (selector is None):
            raise ValueError("Mark.from_svg needs exactly one of svg_id and selector")
        return _compact({"shape": "from_svg", "svg_id": svg_id, "selector": selector})

