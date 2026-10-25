"""Results of a solve and validation reports."""

from __future__ import annotations

import copy
import json
import math
import os
from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple, Union

from . import _native
from ._errors import ValidationError, _issue
from ._json import dumps
from ._types import BBox, Issue, JSONDict, Point

if TYPE_CHECKING:
    from ._background import RawRaster

__all__ = ["Leader", "Placement", "Report", "Result"]


def _pt(p: Any) -> Point:
    return (float(p[0]), float(p[1]))


def _pts(ps: Any) -> Optional[Tuple[Point, ...]]:
    return None if ps is None else tuple(_pt(p) for p in ps)


@dataclass(frozen=True)
class Leader:
    """A leader line from the item (boundary + ``anchor_gap``, or tip) to the label port."""

    points: Tuple[Point, ...]
    style: str
    port: Point
    #: For ``port="baseline"``: the underline below the first text line.
    underline: Optional[Tuple[Point, ...]] = None
    #: For ``style="curved"``: ``(start, control, end)`` of the quadratic Bézier
    #: (``points`` holds its flattening).
    curve: Optional[Tuple[Point, ...]] = None
    #: For the fan leaders of a group label: the member this leader points to.
    member: Optional[str] = None
    #: The stub of a label next to its mark among other marks (``placement.stubs``).
    stub: bool = False

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Leader:
        return cls(
            points=tuple(_pt(p) for p in d.get("points", ())),
            style=str(d.get("style", "straight")),
            port=_pt(d.get("port", (0.0, 0.0))),
            underline=_pts(d.get("underline")),
            curve=_pts(d.get("curve")),
            member=d.get("member"),
            stub=bool(d.get("stub", False)),
        )

    @property
    def length(self) -> float:
        """Length of the polyline (px)."""
        return sum(math.hypot(b[0] - a[0], b[1] - a[1]) for a, b in zip(self.points, self.points[1:]))


@dataclass(frozen=True)
class Placement:
    """Where one item's label went (or why it was omitted). Canvas px, y down."""

    id: str
    placed: bool
    box: Optional[BBox] = None
    #: The item's anchor point (area items: the pole of the polygon). Passed back as
    #: ``warm_start``, the label box moves with it.
    anchor: Optional[Point] = None
    #: ``top``, ``right``, ..., ``bottom-left``, ``internal``, ``distant``, ``boundary`` or
    #: ``fan``.
    anchor_side: Optional[str] = None
    #: ``adjacent``, ``slider``, ``internal``, ``distant``, ``boundary`` or ``fan`` (a label
    #: in a crowd's column).
    model: Optional[str] = None
    leader: Optional[Leader] = None
    #: Text lines as placed (wrapped, truncated or an alternative); empty for icons/boxes.
    lines: Tuple[str, ...] = ()
    #: Why an unplaced item was omitted: ``omitted_by_priority``,
    #: ``no_feasible_candidate``, ``budget_exhausted``, ``keep_with`` or ``grouped``.
    reason: Optional[str] = None
    cost: Optional[float] = None
    #: ``{tier, score, rank, ...}`` of the item.
    priority: Optional[JSONDict] = None
    #: Fan leaders of a group label (one per member).
    leaders: Tuple[Leader, ...] = ()
    #: Group members sharing this label.
    members: Tuple[str, ...] = ()
    #: Degradation steps used (``wrap``, ``shrink:0.85``, ...).
    degrade_steps: Tuple[str, ...] = ()
    #: Hard classes that rejected candidates (unplaced items).
    blocking: Tuple[str, ...] = ()
    #: Placed items of higher or equal priority in the way (unplaced items).
    blocked_by: Tuple[str, ...] = ()
    #: Text layout: ``baseline_offsets``, ``x_offsets`` (each line's start, aligned per
    #: ``align``), ``font_size``, ``line_widths``, ...
    text: Optional[JSONDict] = None
    #: Parts of a composite label (each ``{type, box, text?}``).
    parts: Tuple[JSONDict, ...] = ()
    #: The placement object as returned by the engine.
    raw: JSONDict = field(default_factory=dict, repr=False, compare=False)

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Placement:
        b = d.get("box")
        text = d.get("text")
        leader = d.get("leader")
        return cls(
            id=str(d["id"]),
            placed=bool(d.get("placed", False)),
            box=BBox(float(b["x"]), float(b["y"]), float(b["w"]), float(b["h"])) if b else None,
            anchor=_pt(d["anchor"]) if d.get("anchor") is not None else None,
            anchor_side=d.get("anchor_side"),
            model=d.get("model"),
            leader=Leader.from_dict(leader) if leader else None,
            lines=tuple(text.get("lines", ())) if text else (),
            reason=d.get("reason"),
            cost=d.get("cost"),
            priority=dict(d["priority"]) if d.get("priority") is not None else None,
            leaders=tuple(Leader.from_dict(x) for x in d.get("leaders", ())),
            members=tuple(d.get("members", ())),
            degrade_steps=tuple(d.get("degrade_steps", ())),
            blocking=tuple(d.get("blocking", ())),
            blocked_by=tuple(d.get("blocked_by", ())),
            text=dict(text) if text else None,
            parts=tuple(dict(p) for p in d.get("parts", ())),
            raw=dict(d),
        )

    @property
    def all_leaders(self) -> Tuple[Leader, ...]:
        """The leader and the fan leaders of a group label."""
        return ((self.leader,) if self.leader is not None else ()) + self.leaders

    @property
    def baselines(self) -> Tuple[float, ...]:
        """Canvas y of each text line's baseline."""
        if self.box is None or not self.text:
            return ()
        return tuple(self.box.y + float(o) for o in self.text.get("baseline_offsets", ()))

    @property
    def line_starts(self) -> Tuple[float, ...]:
        """Canvas x where each text line starts: the lines aligned per ``text["align"]``
        (centered by default)."""
        if self.box is None or not self.text:
            return ()
        xs = self.text.get("x_offsets")
        if xs is None:  # a result without them: every line at the text block's left edge
            xs = [self.text.get("x_offset", 0.0)] * len(self.text.get("lines", ()))
        return tuple(self.box.x + float(x) for x in xs)


class Result:
    """The result of a solve (``spec/schema/result.v1.json``)."""

    def __init__(
        self,
        raw: JSONDict,
        problem: Optional[JSONDict] = None,
        *,
        raster: Optional[RawRaster] = None,
    ) -> None:
        #: The result JSON as a dict.
        self.raw = raw
        #: The problem that was solved (with a placeholder for a raw raster background).
        self.problem = problem
        self._raster = raster
        #: One placement per item, in input order.
        self.placements: List[Placement] = [Placement.from_dict(p) for p in raw.get("placements", ())]
        self._by_id: Dict[str, Placement] = {p.id: p for p in self.placements}

    # --- summary ------------------------------------------------------------------
    @property
    def stats(self) -> JSONDict:
        """``placed``, ``total``, ``hard_violations``, ``omission_order``, ``runtime_ms``, ..."""
        st: JSONDict = self.raw.get("stats", {})
        return st

    @property
    def omission_order(self) -> List[str]:
        """Ids of the omitted items, lowest priority first (``stats.omission_order``)."""
        return list(self.stats.get("omission_order", []))

    @property
    def warnings(self) -> List[Issue]:
        """Validation and preparation warnings (``unknown_class``, ``ignored``, ...)."""
        return [_issue(w) for w in self.raw.get("warnings", [])]

    @property
    def placed(self) -> List[Placement]:
        return [p for p in self.placements if p.placed]

    @property
    def unplaced(self) -> List[Placement]:
        return [p for p in self.placements if not p.placed]

    @property
    def debug_svg(self) -> Optional[str]:
        """The overlay rendered during the solve (with ``debug_svg=True``), else ``None``."""
        s = self.raw.get("debug_svg")
        return s if isinstance(s, str) else None

    # --- access -------------------------------------------------------------------
    def __getitem__(self, item_id: object) -> Placement:
        """The placement of an item by id. Ids are strings; other keys are looked up as
        ``str(key)``, as the API converts them (``ids=[101, 202]`` → ``res[101]``; items
        without an id are ``"0"``, ``"1"``, ... → ``res[0]``)."""
        return self._by_id[item_id if isinstance(item_id, str) else str(item_id)]

    def get(self, item_id: object) -> Optional[Placement]:
        """The placement of an item by id (as ``res[item_id]``), or ``None``."""
        return self._by_id.get(item_id if isinstance(item_id, str) else str(item_id))

    def __iter__(self) -> Iterator[Placement]:
        return iter(self.placements)

    def __len__(self) -> int:
        return len(self.placements)

    def __repr__(self) -> str:
        st = self.stats
        return (
            f"<Result placed={st.get('placed')}/{st.get('total')} "
            f"hard_violations={st.get('hard_violations')} "
            f"omitted={len(st.get('omission_order', []))}>"
        )

    # --- export -------------------------------------------------------------------
    def to_dict(self) -> JSONDict:
        """A deep copy of the result JSON."""
        return copy.deepcopy(self.raw)

    def to_json(self, indent: Optional[int] = None) -> str:
        return json.dumps(self.raw, indent=indent, ensure_ascii=False)

    def to_svg(self, path: Union[str, "os.PathLike[str]", None] = None) -> str:
        """The debug SVG overlay (marks, obstacles, label boxes, leaders); written to
        ``path`` when given.

        With ``debug_svg=True`` at solve time the overlay rendered during the solve (with
        cost-grid heatmaps) is used; otherwise it is rendered from the problem now.
        """
        svg = self.debug_svg
        if svg is None:
            if self.problem is None:
                raise ValueError("this Result has no problem attached; use render_svg(problem, result)")
            raw = {k: v for k, v in self.raw.items() if k != "debug_svg"}
            r = self._raster
            svg = _native.render_svg(
                dumps(self.problem),
                json.dumps(raw),
                rgba=None if r is None else r.data,
                width=0 if r is None else r.width,
                height=0 if r is None else r.height,
            )
        if path is not None:
            with open(path, "w", encoding="utf-8") as f:
                f.write(svg)
        return svg


@dataclass(frozen=True)
class Report:
    """A validation report: ``valid``, ``errors`` and ``warnings``."""

    valid: bool
    errors: List[Issue] = field(default_factory=list)
    warnings: List[Issue] = field(default_factory=list)

    def __bool__(self) -> bool:
        return self.valid

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> Report:
        return cls(
            valid=bool(d.get("valid", False)),
            errors=[_issue(e) for e in d.get("errors", [])],
            warnings=[_issue(w) for w in d.get("warnings", [])],
        )

    def raise_for_errors(self) -> None:
        """Raise :class:`ValidationError` if the problem is invalid."""
        if not self.valid:
            first = self.errors[0] if self.errors else None
            msg = "invalid problem"
            if first is not None:
                msg += f": {first['pointer'] or '/'}: {first['message']} ({first['code']})"
                if len(self.errors) > 1:
                    msg += f" (and {len(self.errors) - 1} more)"
            raise ValidationError(msg, self.errors, self.warnings)
