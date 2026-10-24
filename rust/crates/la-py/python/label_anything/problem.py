"""``la.Problem``: a fluent builder for problems, and the keyword-option mapping shared
with the one-call ``la.place(...)``.

Keyword options map 1:1 to schema fields (``spec/schema/problem.v1.json``): a keyword is
the field's name (``seed`` → ``solver.seed``, ``max_labels`` →
``priority.budget.max_labels``), prefixed where a name occurs twice (``canvas_padding``
→ ``canvas.padding`` vs. ``padding`` → ``defaults.padding``). Whole sections can be given
as dicts (``solver={...}``, ``placement={...}``) and are deep-merged; specific keywords
win over sections. ``None`` always means "not set" (the spec default applies).
"""

from __future__ import annotations

import copy
import difflib
import math
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Tuple

from . import _background
from ._errors import ValidationError
from ._json import plain, pointer_token
from ._types import JSONDict
from .labels import anchor_dict, font_dict, label_dict, leaders_dict, wrap_dict
from .priority import Priority

if TYPE_CHECKING:
    from .result import Report, Result

__all__ = ["OPTION_PATHS", "Problem"]

#: Keyword option → dotted schema path.
OPTION_PATHS: Dict[str, str] = {
    "version": "version",
    "y_axis": "y_axis",
    "transform": "transform",
    "preset": "preset",
    # canvas
    "canvas_padding": "canvas.padding",
    "allow_outside": "canvas.allow_outside",
    "device_pixel_ratio": "canvas.device_pixel_ratio",
    "region": "canvas.region",
    "canvas_background": "canvas.background",
    # label defaults
    "font_family": "defaults.font.family",
    "font_size": "defaults.font.size",
    "font_weight": "defaults.font.weight",
    "font_style": "defaults.font.style",
    "line_height": "defaults.font.line_height",
    "font_file": "defaults.font.file",
    "padding": "defaults.padding",
    "buffer": "defaults.buffer",
    "margin": "defaults.margin",
    "spacing": "defaults.spacing",
    "mark": "defaults.mark",
    "truncate": "defaults.truncate",
    "shaping": "text.shaping",
    # placement
    "models": "placement.models",
    "position_order": "placement.position_order",
    "offset": "placement.offset",
    "max_distance": "placement.max_distance",
    "min_distance": "placement.min_distance",
    "slider_per_quadrant": "placement.slider_per_quadrant",
    "k_distant": "placement.k_distant",
    "distant_rings": "placement.distant_rings",
    "distant_directions": "placement.distant_directions",
    "free_space_seeds": "placement.free_space_seeds",
    "internal": "placement.internal",
    "inner_padding": "placement.inner_padding",
    "internal_circle_ratio": "placement.internal_circle_ratio",
    "prune_factor": "placement.prune_factor",
    "boundary": "placement.boundary",
    "fan": "placement.fan",
    "own_nearest": "placement.own_nearest",
    "stubs": "placement.stubs",
    "stub_length": "placement.stub_length",
    "stub_reach": "placement.stub_reach",
    # avoid
    "avoid_leader": "avoid.leader",
    "avoid_buffer": "avoid.buffer",
    "relaxable": "avoid.relaxable",
    # priority
    "omission": "priority.omission",
    "coverage": "priority.coverage",
    "ties": "priority.ties",
    "band": "priority.band",
    "max_labels": "priority.budget.max_labels",
    "max_ink_fraction": "priority.budget.max_ink_fraction",
    "focus": "priority.focus",
    "font_classes": "priority.font_classes",
    # solver
    "strategy": "solver.strategy",
    "time_budget_ms": "solver.time_budget_ms",
    "max_iterations": "solver.max_iterations",
    "seed": "solver.seed",
    "grid_cell": "solver.grid_cell",
    # degradation ladder
    "degrade": "degrade",
    "min_scale": "degrade_options.min_scale",
    "wrap_max_lines": "degrade_options.wrap_max_lines",
    "soft_overlap_weight": "degrade_options.soft_overlap_weight",
    # output
    "debug_svg": "output.debug_svg",
    "cost_breakdown": "output.cost_breakdown",
    "candidates": "output.candidates",
    "item_shape": "output.item_shape",
}

#: Sections given as whole dicts (deep-merged before the specific keywords).
SECTIONS = (
    "defaults",
    "text",
    "obstacles",
    "placement",
    "solver",
    "degrade_options",
    "weights",
    "output",
)

#: ``background=`` options → keyword of ``_background.sources``.
BACKGROUND_OPTIONS = {
    "background_mode": "mode",
    "background_class": "cls",
    "background_scale": "scale",
    "background_offset": "offset",
    "background_options": "options",
    "svg_classes": "svg_classes",
    "svg_default_class": "svg_default_class",
    "auto_mark_items": "auto_mark_items",
}

#: Options with their own handling.
SPECIAL = (
    "canvas",
    "font",
    "wrap",
    "avoid",
    "leaders",
    "warm_start",
    "vector",
    "background",
    "priority",
    "tiers",
)

ALL_OPTIONS = frozenset(SECTIONS) | frozenset(OPTION_PATHS) | frozenset(BACKGROUND_OPTIONS) | frozenset(SPECIAL)

#: Top-level key order of built problems (schema order).
_KEY_ORDER = (
    "version",
    "canvas",
    "y_axis",
    "transform",
    "preset",
    "defaults",
    "text",
    "items",
    "obstacles",
    "avoid",
    "placement",
    "leaders",
    "priority",
    "solver",
    "degrade",
    "degrade_options",
    "weights",
    "warm_start",
    "output",
)
_AVOID_SECTIONS = ("label", "leader", "buffer", "relaxable")

PriorityFn = Callable[[JSONDict], Any]


def merge(dst: Dict[str, Any], src: Mapping[str, Any]) -> Dict[str, Any]:
    """Deep-merge ``src`` into ``dst`` (dicts recursively, everything else replaces)."""
    for k, v in src.items():
        if isinstance(v, Mapping) and isinstance(dst.get(k), dict):
            merge(dst[k], v)
        elif isinstance(v, Mapping):
            dst[k] = merge({}, v)
        else:
            dst[k] = copy.deepcopy(v)
    return dst


def set_path(doc: Dict[str, Any], path: str, value: Any) -> None:
    """Set a dotted path (``"solver.seed"``), creating intermediate objects."""
    keys = path.split(".")
    node = doc
    for k in keys[:-1]:
        nxt = node.get(k)
        if not isinstance(nxt, dict):
            nxt = {}
            node[k] = nxt
        node = nxt
    node[keys[-1]] = value


def _numbers(v: Any, n: int, name: str) -> List[float]:
    vals = [float(x) for x in v]
    if len(vals) != n:
        raise ValueError(f"{name} needs {n} numbers (got {len(vals)})")
    return vals


def _strings(v: Any) -> List[str]:
    return [v] if isinstance(v, str) else [str(x) for x in v]


def _normalize(key: str, value: Any) -> Any:
    """Convert convenient Python values of a path option into schema values."""
    if key in ("models", "degrade", "relaxable"):
        return _strings(value)
    if key == "position_order":
        return value if isinstance(value, str) else _strings(value)
    if key == "boundary":
        if isinstance(value, Mapping):
            return dict(value)
        return {"sides": _strings(value)}
    if key == "region":
        return _numbers(value, 4, "region")
    if key == "focus":
        return _numbers(value, 2, "focus")
    if key == "transform":
        return _numbers(value, 6, "transform")
    if key == "coverage":
        if isinstance(value, str):
            return {"by": value}
        if isinstance(value, tuple):
            by, n = value
            return {"by": str(by), "min_per_group": int(n)}
        return dict(value)
    if key == "mark":
        return mark_dict(value)
    if key == "font_file":
        import os

        return os.fspath(value)
    return value


def mark_dict(mark: Any) -> JSONDict:
    """A mark: a mark dict, or a number (the radius of a circle)."""
    if isinstance(mark, Mapping):
        return dict(mark)
    if isinstance(mark, (int, float)) and not isinstance(mark, bool):
        return {"shape": "circle", "r": float(mark)}
    if hasattr(mark, "item"):  # NumPy scalar
        return {"shape": "circle", "r": float(mark)}
    raise TypeError(f"a mark must be a mark dict (see la.Mark) or a radius (got {mark!r})")


def avoid_dict(avoid: Mapping[str, Any]) -> JSONDict:
    """``avoid``: the full object (``{"label": ..., "leader": ...}``) or the flat
    ``avoid.label`` map (``{"ink": 0.5, "outliers": "hard"}``)."""
    d = dict(avoid)
    structured = bool(d) and all(
        k in _AVOID_SECTIONS and isinstance(v, (Mapping, list, tuple)) for k, v in d.items()
    )
    if structured:
        return {k: (dict(v) if isinstance(v, Mapping) else list(v)) for k, v in d.items()}
    return {"label": d}


def warm_start_dict(prev: Any) -> JSONDict:
    """``warm_start``: a previous :class:`Result`, a result dict, or its placements."""
    raw = getattr(prev, "raw", None)
    if isinstance(raw, Mapping):
        prev = raw
    if isinstance(prev, Mapping):
        return {"placements": copy.deepcopy(list(prev.get("placements", [])))}
    return {"placements": [dict(p) for p in prev]}


def tier_rules(tiers: Any) -> List[JSONDict]:
    """``priority.tiers``: ``[{where, tier}]`` or ``[(where, tier)]``."""
    out: List[JSONDict] = []
    for t in tiers:
        if isinstance(t, Mapping):
            out.append(dict(t))
        else:
            where, tier = t
            out.append({"where": str(where), "tier": int(tier)})
    return out


def is_number_list(v: Any) -> bool:
    """A sequence of numbers or ``None`` (an explicit value per item)."""
    if isinstance(v, (str, bytes, Mapping, Priority)) or callable(v):
        return False
    if not isinstance(v, Iterable):
        return False
    if hasattr(v, "dtype"):  # NumPy array
        return getattr(v.dtype, "kind", "") in "iuf"
    vals = list(v)
    return all(
        x is None or (isinstance(x, (int, float)) and not isinstance(x, bool)) or hasattr(x, "item")
        for x in vals
    ) and not all(isinstance(x, Mapping) for x in vals[:1])


def is_tier_list(v: Any) -> bool:
    """A non-empty sequence of ints or ``None`` (an explicit tier per item), not tier rules."""
    if v is None or isinstance(v, (str, bytes, Mapping)) or not isinstance(v, Iterable):
        return False
    if hasattr(v, "dtype"):  # NumPy array
        return getattr(v.dtype, "kind", "") in "iu" and int(getattr(v, "size", 0)) > 0
    vals = list(v)
    return bool(vals) and all(
        t is None or (isinstance(t, int) and not isinstance(t, bool)) or hasattr(t, "item") for t in vals
    )


def _finite_number(v: Any, pointer: str) -> float:
    try:
        x = float(v)
    except (TypeError, ValueError):
        raise ValidationError.single(pointer, "type", f"expected a number (got {v!r})") from None
    if not math.isfinite(x):
        raise ValidationError.single(pointer, "invalid_value", f"must be finite (got {x})")
    return x


def make_item(
    index: int,
    anchor: Any,
    label: Any,
    *,
    id: Any = None,
    attrs: Optional[Mapping[str, Any]] = None,
    mark: Any = None,
    priority: Any = None,
    tier: Optional[int] = None,
    required: Optional[bool] = None,
    group: Optional[str] = None,
    keep_with: Any = None,
    svg_id: Optional[str] = None,
    placement: Optional[Mapping[str, Any]] = None,
) -> JSONDict:
    """One item dict, in schema key order."""
    pointer = f"/items/{index}"
    item: JSONDict = {}
    if id is not None:
        item["id"] = str(id)
    a = anchor_dict(anchor, f"{pointer}/anchor")
    if mark is not None:
        if a.get("type") != "point":
            raise ValueError(f"item {index}: marks apply to point anchors only")
        a["mark"] = mark_dict(mark)
    item["anchor"] = a
    item["label"] = label_dict(label)
    cleaned = clean_attrs(attrs, f"{pointer}/attrs") if attrs else None
    if cleaned:
        item["attrs"] = cleaned
    if priority is not None:
        item["priority"] = _finite_number(priority, f"{pointer}/priority")
    if tier is not None:
        item["tier"] = int(tier)
    if required is not None:
        item["required"] = bool(required)
    if group is not None:
        item["group"] = str(group)
    if keep_with is not None:
        item["keep_with"] = keep_with if isinstance(keep_with, str) else [str(k) for k in keep_with]
    if svg_id is not None:
        item["svg_id"] = str(svg_id)
    if placement is not None:
        item["placement"] = dict(placement)
    return item


def clean_attrs(attrs: Mapping[str, Any], pointer: str = "/attrs") -> JSONDict:
    """Item attributes as JSON values (NumPy scalars as numbers, dates and times as ISO 8601
    strings, durations in seconds); NaN / missing values (pandas ``NaN``, ``NA``, ``NaT``)
    are dropped."""
    out: JSONDict = {}
    for k, v in attrs.items():
        if isinstance(v, float) and math.isnan(v):
            continue
        if type(v).__name__ in ("NAType", "NaTType"):
            continue
        if hasattr(v, "dtype") and getattr(v, "shape", None) == () and v != v:  # NumPy NaN, NaT
            continue
        try:
            out[str(k)] = plain(v)
        except TypeError:
            raise TypeError(
                f"{pointer}/{pointer_token(k)}: a value of type {type(v).__name__!r} has no JSON "
                "encoding (attributes are numbers, strings, booleans, dates, lists or dicts)"
            ) from None
    return out


def attrs_list(attrs: Any, n: int) -> List[Optional[Mapping[str, Any]]]:
    """Per-item attributes: a list of dicts, a dict of columns, or a pandas DataFrame."""
    if hasattr(attrs, "to_dict") and hasattr(attrs, "columns"):
        recs: List[Any] = list(attrs.to_dict("records"))
    elif isinstance(attrs, Mapping):
        cols = {str(k): list(v) for k, v in attrs.items()}
        for k, col in cols.items():
            if len(col) != n:
                raise ValueError(f"attrs column {k!r} has {len(col)} values but there are {n} items")
        recs = [{k: col[i] for k, col in cols.items()} for i in range(n)]
    else:
        recs = list(attrs)
    if len(recs) != n:
        raise ValueError(f"attrs has {len(recs)} entries but there are {n} items")
    return recs


def _length(v: Any) -> Optional[int]:
    try:
        return len(v)
    except TypeError:
        return None


def per_item(name: str, values: Any, n: int) -> Optional[List[Any]]:
    if values is None:
        return None
    if isinstance(values, (str, bytes)):
        raise TypeError(f"{name} must be a sequence with one entry per item")
    vals = list(values)
    if len(vals) != n:
        raise ValueError(f"{name} has {len(vals)} entries but there are {n} items")
    return vals


def apply_priority_fn(items: List[JSONDict], fn: PriorityFn) -> None:
    """Evaluate a priority callable once per item and store explicit ``priority``/``tier``."""
    for i, it in enumerate(items):
        v = fn(dict(it))
        if v is None:
            continue
        pointer = f"/items/{i}/priority"
        if isinstance(v, (tuple, list)):
            if len(v) != 2:
                raise ValueError("a priority callable returns a number or (tier, score)")
            tier, score = v
            if tier is not None:
                it["tier"] = int(tier)
            if score is not None:
                it["priority"] = _finite_number(score, pointer)
        else:
            it["priority"] = _finite_number(v, pointer)


def _set_per_item(items: List[JSONDict], key: str, vals: List[Any], when: str) -> None:
    """Write explicit ``priority`` / ``tier`` values (one per item; ``None`` skips)."""
    if len(vals) != len(items):
        name = "priority" if key == "priority" else "tiers"
        raise ValueError(
            f"{name} has {len(vals)} values{when} but there are {len(items)} items "
            f"(per-item values can also go with the items: .items(..., {name}=[...]))"
        )
    for i, (it, v) in enumerate(zip(items, vals)):
        if v is None:
            continue
        it[key] = _finite_number(v, f"/items/{i}/{key}") if key == "priority" else int(v)


def unknown_option(name: str) -> TypeError:
    close = difflib.get_close_matches(name, sorted(ALL_OPTIONS), n=3)
    hint = f" (did you mean {', '.join(repr(c) for c in close)}?)" if close else ""
    return TypeError(f"unknown option {name!r}{hint}")


class Problem:
    """A fluent builder for a Label Anything problem.

    ::

        p = (la.Problem(canvas=(800, 600), preset="scatter", font_size=11)
               .item((120, 80), "Alpha", id="a", attrs={"cbo": 41})
               .items(points, names)
               .background("plot.png")
               .avoid(ink=0.5, outliers="hard")
               .leaders("elbow")
               .priority(la.Priority.outlierness(k=5)))
        problem_dict = p.build()
        result = p.solve()

    The constructor and :meth:`set` take the same keyword options as :func:`la.place`.
    """

    def __init__(self, **options: Any) -> None:
        self._doc: JSONDict = {}
        self._items: List[JSONDict] = []
        self._backgrounds: List[Tuple[Any, Dict[str, Any]]] = []
        self._bg_defaults: Dict[str, Any] = {}
        self._vector: List[JSONDict] = []
        self._priority_fn: Optional[PriorityFn] = None
        #: Per-item ``priority`` / ``tier`` values given before the items (applied at build).
        self._pending: Dict[str, List[Any]] = {}
        if options:
            self.set(**options)

    # --- options ------------------------------------------------------------------
    def set(self, **options: Any) -> Problem:
        """Set keyword options (the ones of :func:`la.place`); ``None`` values are skipped."""
        for k in options:
            if k not in ALL_OPTIONS:
                raise unknown_option(k)
        opts = {k: v for k, v in options.items() if v is not None}
        doc = self._doc
        for k in SECTIONS:
            if k in opts:
                v = opts[k]
                if not isinstance(v, Mapping):
                    raise TypeError(f"{k} must be a dict")
                merge(doc.setdefault(k, {}), v)
        if "canvas" in opts:
            self.canvas(opts["canvas"])
        if "font" in opts:
            merge(doc.setdefault("defaults", {}).setdefault("font", {}), font_dict(opts["font"]))
        if "wrap" in opts:
            set_path(doc, "defaults.wrap", wrap_dict(opts["wrap"]))
        if "avoid" in opts:
            v = opts["avoid"]
            if not isinstance(v, Mapping):
                raise TypeError("avoid must be a dict")
            merge(doc.setdefault("avoid", {}), avoid_dict(v))
        if "leaders" in opts:
            merge(doc.setdefault("leaders", {}), leaders_dict(opts["leaders"]))
        if "warm_start" in opts:
            doc["warm_start"] = warm_start_dict(opts["warm_start"])
        if "vector" in opts:
            self._vector = [dict(layer) for layer in opts["vector"]]
        for k, kw in BACKGROUND_OPTIONS.items():
            if k in opts:
                self._bg_defaults[kw] = opts[k]
        if "background" in opts:
            self._backgrounds = [(opts["background"], {})]
        for k, path in OPTION_PATHS.items():
            if k in opts:
                set_path(doc, path, _normalize(k, opts[k]))
        if "priority" in opts:
            self.priority(opts["priority"])
        if "tiers" in opts:
            tiers = opts["tiers"]
            if isinstance(tiers, Iterator):
                tiers = list(tiers)
            if is_tier_list(tiers):
                self._per_item("tier", tiers)
            else:
                set_path(doc, "priority.tiers", tier_rules(tiers))
        return self

    def option(self, path: str, value: Any) -> Problem:
        """Set any schema field by dotted path, e.g. ``option("leaders.port", "baseline")``."""
        set_path(self._doc, path, copy.deepcopy(value))
        return self

    def canvas(self, width: Any, height: Optional[float] = None, **canvas_options: Any) -> Problem:
        """Set the canvas: ``canvas(800, 600, padding=4)``, ``canvas((800, 600))`` or a dict."""
        if isinstance(width, Mapping):
            merge(self._doc.setdefault("canvas", {}), width)
        else:
            if height is None:
                if isinstance(width, (str, bytes)) or _length(width) != 2:
                    raise TypeError(f"canvas must be (width, height) or a dict (got {width!r})")
                width, height = width
            c = self._doc.setdefault("canvas", {})
            c["width"], c["height"] = float(width), float(height)
        c = self._doc["canvas"]
        for k, v in canvas_options.items():
            if v is not None:
                c[k] = _normalize("region", v) if k == "region" else v
        return self

    # --- items --------------------------------------------------------------------
    def item(
        self,
        anchor: Any,
        label: Any,
        *,
        id: Any = None,
        attrs: Optional[Mapping[str, Any]] = None,
        mark: Any = None,
        priority: Optional[float] = None,
        tier: Optional[int] = None,
        required: Optional[bool] = None,
        group: Optional[str] = None,
        keep_with: Any = None,
        svg_id: Optional[str] = None,
        placement: Optional[Mapping[str, Any]] = None,
    ) -> Problem:
        """Add one item: an anchor ``(x, y)`` / :class:`Area` / dict and a label."""
        self._items.append(
            make_item(
                len(self._items),
                anchor,
                label,
                id=id,
                attrs=attrs,
                mark=mark,
                priority=priority,
                tier=tier,
                required=required,
                group=group,
                keep_with=keep_with,
                svg_id=svg_id,
                placement=placement,
            )
        )
        return self

    def items(
        self,
        anchors: Iterable[Any],
        labels: Iterable[Any],
        *,
        ids: Optional[Iterable[Any]] = None,
        attrs: Any = None,
        marks: Any = None,
        priority: Optional[Iterable[Optional[float]]] = None,
        tiers: Optional[Iterable[Optional[int]]] = None,
        required: Any = None,
        groups: Optional[Iterable[Optional[str]]] = None,
        keep_with: Optional[Iterable[Any]] = None,
        svg_ids: Optional[Iterable[Optional[str]]] = None,
        placement: Optional[Iterable[Optional[Mapping[str, Any]]]] = None,
    ) -> Problem:
        """Add many items. ``anchors``: ``(x, y)`` pairs, an ``(N, 2)`` array or a two-column
        DataFrame, :class:`Area` polygons or anchor dicts. Every keyword is a sequence with
        one entry per item (``None`` entries are skipped); ``attrs`` may also be a dict of
        columns or a DataFrame, ``marks`` a single mark for all, ``required`` a set of ids."""
        if isinstance(labels, (str, bytes)):
            raise TypeError("labels must be a sequence of labels, not a single string")
        if hasattr(anchors, "columns") and hasattr(anchors, "to_numpy"):
            # a pandas DataFrame iterates over its column names: use its rows
            if len(anchors.columns) != 2:
                raise ValueError(f"a DataFrame of anchors needs two columns, x and y (got {len(anchors.columns)})")
            anchors = anchors.to_numpy(dtype=float)
        anchor_list = list(anchors)
        label_list = list(labels)
        n = len(anchor_list)
        if len(label_list) != n:
            hint = ""
            if n == 2 and all(_length(a) == len(label_list) for a in anchor_list):
                hint = " (anchors are (x, y) pairs: for separate x and y sequences pass zip(x, y))"
            raise ValueError(f"{n} anchors but {len(label_list)} labels{hint}")
        id_list = per_item("ids", ids, n)
        attr_list = attrs_list(attrs, n) if attrs is not None else None
        if marks is not None and (isinstance(marks, Mapping) or not isinstance(marks, Iterable)):
            mark_list: Optional[List[Any]] = [marks] * n
        else:
            mark_list = per_item("marks", marks, n)
        prio_list = per_item("priority", priority, n)
        tier_list = per_item("tiers", tiers, n)
        group_list = per_item("groups", groups, n)
        keep_list = per_item("keep_with", keep_with, n)
        svg_list = per_item("svg_ids", svg_ids, n)
        place_list = per_item("placement", placement, n)
        req_list: Optional[List[Any]] = None
        if required is not None:
            req = list(required) if not isinstance(required, (set, frozenset)) else None
            if req is not None and len(req) == n and all(isinstance(r, bool) or hasattr(r, "item") for r in req):
                req_list = [bool(r) for r in req]
            else:
                wanted = {str(r) for r in (required if req is None else req)}
                req_list = [
                    (str(id_list[i]) if id_list and id_list[i] is not None else str(len(self._items) + i))
                    in wanted
                    or None
                    for i in range(n)
                ]
        start = len(self._items)
        for i in range(n):
            self._items.append(
                make_item(
                    start + i,
                    anchor_list[i],
                    label_list[i],
                    id=id_list[i] if id_list else None,
                    attrs=attr_list[i] if attr_list else None,
                    mark=mark_list[i] if mark_list else None,
                    priority=prio_list[i] if prio_list else None,
                    tier=tier_list[i] if tier_list else None,
                    required=req_list[i] if req_list else None,
                    group=group_list[i] if group_list else None,
                    keep_with=keep_list[i] if keep_list else None,
                    svg_id=svg_list[i] if svg_list else None,
                    placement=place_list[i] if place_list else None,
                )
            )
        return self

    # --- obstacles ----------------------------------------------------------------
    def background(
        self,
        source: Any,
        *,
        mode: Optional[str] = None,
        cls: Optional[str] = None,
        scale: Optional[float] = None,
        offset: Optional[Sequence[float]] = None,
        svg_classes: Any = None,
        svg_default_class: Optional[str] = None,
        auto_mark_items: Optional[bool] = None,
        options: Optional[Mapping[str, Any]] = None,
    ) -> Problem:
        """Add a background: a raster/SVG path, bytes, SVG markup, a NumPy array or a PIL
        image (see ``background=`` of :func:`la.place`)."""
        opts = {
            k: v
            for k, v in (
                ("mode", mode),
                ("cls", cls),
                ("scale", scale),
                ("offset", offset),
                ("svg_classes", svg_classes),
                ("svg_default_class", svg_default_class),
                ("auto_mark_items", auto_mark_items),
                ("options", options),
            )
            if v is not None
        }
        self._backgrounds.append((source, opts))
        return self

    def vector(self, cls: str, **layer: Any) -> Problem:
        """Add a vector obstacle layer of class ``cls``: ``points``, ``r``, ``circles``,
        ``polylines``, ``width``, ``polygons``, ``fill_rule``, ``rects``, ``shapes``."""
        d: JSONDict = {"class": cls}
        for k, v in layer.items():
            if v is not None:
                d[k] = v
        self._vector.append(d)
        return self

    def avoid(self, classes: Optional[Mapping[str, Any]] = None, **weights: Any) -> Problem:
        """Label box vs. classes (``avoid.label``): ``avoid(ink=0.5, outliers="hard")``."""
        d = dict(classes or {})
        d.update(weights)
        merge(self._doc.setdefault("avoid", {}), avoid_dict(d))
        return self

    def avoid_leader(self, classes: Optional[Mapping[str, Any]] = None, **weights: Any) -> Problem:
        """Leaders vs. classes (``avoid.leader``)."""
        d = dict(classes or {})
        d.update(weights)
        merge(self._doc.setdefault("avoid", {}), {"leader": d})
        return self

    def avoid_buffer(self, classes: Optional[Mapping[str, float]] = None, **weights: float) -> Problem:
        """Soft weights of the ambiguity buffer ring (``avoid.buffer``)."""
        d = dict(classes or {})
        d.update(weights)
        merge(self._doc.setdefault("avoid", {}), {"buffer": d})
        return self

    def leaders(self, style: Any = None, **options: Any) -> Problem:
        """Leader settings: ``leaders("elbow", port="side-center")`` or a :class:`Leaders`."""
        d: JSONDict = {} if style is None else leaders_dict(style)
        d.update({k: v for k, v in options.items() if v is not None})
        if "angles" in d:
            d["angles"] = [float(a) for a in d["angles"]]
        merge(self._doc.setdefault("leaders", {}), d)
        return self

    # --- priority -----------------------------------------------------------------
    def priority(self, spec: Any) -> Problem:
        """The priority: a :class:`Priority` (terms), an attribute name, a list of term
        dicts, a whole ``priority`` dict, a list of numbers (one per item; given before
        the items, they apply at :meth:`build`), or a callable
        ``f(item) -> score | (tier, score)`` evaluated once per item at :meth:`build`."""
        pr = self._doc.setdefault("priority", {})
        self._priority_fn = None
        if isinstance(spec, Priority):
            pr["terms"] = spec.to_terms()
        elif isinstance(spec, str):
            pr["terms"] = [{"attr": spec}]
        elif isinstance(spec, Mapping):
            merge(pr, spec)
        elif callable(spec):
            self._priority_fn = spec
            pr.pop("terms", None)
        elif is_number_list(spec):
            self._per_item("priority", spec)
        else:
            pr["terms"] = [dict(t) for t in spec]
        return self

    def _per_item(self, key: str, values: Any) -> None:
        """Explicit ``priority`` / ``tier`` values, one per item: applied to the items now,
        or at :meth:`build` when they are given before the items (``Problem(priority=[...])``)."""
        vals = list(values)
        if not self._items:
            self._pending[key] = vals
            return
        self._pending.pop(key, None)
        _set_per_item(self._items, key, vals, "")

    def tier(self, where: str, tier: int) -> Problem:
        """Append a tier rule ``{where, tier}`` (first match wins)."""
        pr = self._doc.setdefault("priority", {})
        pr.setdefault("tiers", []).append({"where": where, "tier": int(tier)})
        return self

    def warm_start(self, previous: Any) -> Problem:
        """Stay close to a previous result (spec ``warm_start``)."""
        self._doc["warm_start"] = warm_start_dict(previous)
        return self

    # --- output -------------------------------------------------------------------
    def _compile(self, *, embed_background: bool = False) -> Tuple[JSONDict, Optional[_background.RawRaster]]:
        doc = copy.deepcopy(self._doc)
        items = copy.deepcopy(self._items)
        for key, vals in self._pending.items():
            _set_per_item(items, key, vals, " (given before the items)")
        if self._priority_fn is not None:
            apply_priority_fn(items, self._priority_fn)
            pr = doc.get("priority")
            if isinstance(pr, dict):
                pr.pop("terms", None)
        doc["items"] = items
        if self._backgrounds or self._vector:
            obstacles = doc.setdefault("obstacles", {})
            entries = [(bg, {**self._bg_defaults, **opts}) for bg, opts in self._backgrounds]
            srcs = _background.sources(entries, embed=embed_background)
            _background.merge_sources(obstacles, srcs)
            if self._vector:
                obstacles["vector"] = list(obstacles.get("vector", [])) + copy.deepcopy(self._vector)
            raw = srcs.override
        else:
            raw = None
        ordered = {k: doc[k] for k in _KEY_ORDER if k in doc}
        ordered.update({k: v for k, v in doc.items() if k not in ordered})
        return ordered, raw

    def build(self, *, embed_background: bool = False) -> JSONDict:
        """The problem as a dict (``spec/schema/problem.v1.json``).

        A NumPy/PIL background is not part of the JSON (it is handed to the engine
        directly); its raster source is a placeholder ``{"rgba": {"width", "height",
        "data": ""}}``. ``embed_background=True`` embeds the pixels as base64 instead, so
        the problem is self-contained (e.g. for the CLI).
        """
        return self._compile(embed_background=embed_background)[0]

    def to_json(self, *, indent: Optional[int] = None, embed_background: bool = True) -> str:
        """The problem as JSON text (self-contained by default)."""
        from ._json import dumps

        return dumps(self.build(embed_background=embed_background), indent=indent)

    def solve(
        self,
        *,
        measure: Any = None,
        cost: Any = None,
        progress: Any = None,
        cancelled: Any = None,
    ) -> Result:
        """Solve the problem (callbacks as in :func:`la.place`)."""
        from ._api import solve

        problem, raw = self._compile()
        return solve(problem, raw, measure=measure, cost=cost, progress=progress, cancelled=cancelled)

    def validate(self) -> Report:
        """Validate the built problem."""
        from ._api import validate

        return validate(self.build())

    def copy(self) -> Problem:
        """An independent copy of this builder."""
        p = Problem()
        p._doc = copy.deepcopy(self._doc)
        p._items = copy.deepcopy(self._items)
        p._backgrounds = list(self._backgrounds)
        p._bg_defaults = dict(self._bg_defaults)
        p._vector = copy.deepcopy(self._vector)
        p._priority_fn = self._priority_fn
        p._pending = copy.deepcopy(self._pending)
        return p

    def __len__(self) -> int:
        return len(self._items)

    def __repr__(self) -> str:
        c = self._doc.get("canvas", {})
        size = f"{c.get('width'):g}×{c.get('height'):g}" if "width" in c else "unbounded"
        return f"<Problem items={len(self._items)} canvas={size}>"
