"""The one-call API (``place``), the raw JSON API (``place_problem``, ``validate``,
``render_svg``) and the solve itself."""

from __future__ import annotations

import json
import os
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import Any, Optional, Union

from . import _native
from ._background import RawRaster, raw_raster
from ._json import dumps
from ._types import Candidate, FontSpec, JSONDict, Length
from .labels import FontLike, LeadersLike, WrapLike
from .problem import Problem, apply_priority_fn, is_number_list, is_tier_list
from .result import Report, Result

__all__ = ["place", "place_problem", "render_svg", "validate"]

#: ``measure(text, font) -> TextMetrics | {width, ascent, descent} | (w, a, d) | None``
MeasureFn = Callable[[str, FontSpec], Any]
#: ``cost(candidate) -> float >= 0``
CostFn = Callable[[Candidate], float]
#: ``progress(phase, fraction)``
ProgressFn = Callable[[str, float], Any]

ProblemLike = Union[Mapping[str, Any], str, "os.PathLike[str]", Problem]


def _cancel_arg(c: Any) -> Any:
    """A ``CancelToken``, a callable, a ``threading.Event`` or an object with ``cancelled``."""
    if c is None or isinstance(c, _native.CancelToken):
        return c
    is_set = getattr(c, "is_set", None)
    if callable(is_set):
        return is_set
    flag = getattr(c, "cancelled", None)
    if flag is not None and not callable(c):
        if callable(flag):
            return flag
        return lambda: bool(getattr(c, "cancelled"))
    if callable(c):
        return c
    raise TypeError(
        "cancelled must be a CancelToken, a callable returning bool, a threading.Event, "
        "or an object with a 'cancelled' attribute"
    )


def solve(
    problem: JSONDict,
    raster: Optional[RawRaster] = None,
    *,
    measure: Optional[MeasureFn] = None,
    cost: Optional[CostFn] = None,
    progress: Optional[ProgressFn] = None,
    cancelled: Any = None,
) -> Result:
    """Run the engine on a problem dict (and optional raw raster pixels)."""
    text = dumps(problem)
    out = _native.place_json(
        text,
        rgba=None if raster is None else raster.data,
        width=0 if raster is None else raster.width,
        height=0 if raster is None else raster.height,
        measure=measure,
        cost=cost,
        progress=progress,
        cancelled=_cancel_arg(cancelled),
    )
    return Result(json.loads(out), problem, raster=raster)


def _path_text(text: str) -> Optional[Path]:
    """A string naming a file rather than holding problem JSON: JSON text starts with
    ``{`` (a problem) or ``[`` (not a problem, reported as such); anything else is read as
    a path. Raises ``FileNotFoundError`` when no such file exists (the text is neither)."""
    if text.lstrip().startswith(("{", "[")):
        return None
    path = Path(text)
    if not path.is_file():
        raise FileNotFoundError(
            f"a problem string must be JSON text (an object) or the path of a JSON file: no file {text!r}"
        )
    return path


def _load(problem: ProblemLike) -> JSONDict:
    if isinstance(problem, Problem):
        return problem.build()
    if isinstance(problem, Mapping):
        loaded: JSONDict = json.loads(dumps(problem))
        return loaded
    if isinstance(problem, os.PathLike):
        with open(problem, encoding="utf-8") as f:
            from_file: JSONDict = json.load(f)
            return from_file
    if isinstance(problem, str):
        path = _path_text(problem)
        if path is not None:
            return _load(path)
        try:
            parsed: Any = json.loads(problem)
        except json.JSONDecodeError as e:
            from ._errors import ValidationError

            raise ValidationError.single("", "parse", f"invalid problem JSON: {e}") from None
        if not isinstance(parsed, dict):
            from ._errors import ValidationError

            raise ValidationError.single("", "type", "a problem must be a JSON object")
        return parsed
    raise TypeError(f"a problem must be a dict, JSON text, a path or a Problem (got {type(problem).__name__})")


def place_problem(
    problem: ProblemLike,
    *,
    raster: Any = None,
    priority: Optional[Callable[[JSONDict], Any]] = None,
    measure: Optional[MeasureFn] = None,
    cost: Optional[CostFn] = None,
    progress: Optional[ProgressFn] = None,
    cancelled: Any = None,
) -> Result:
    """Solve a raw problem: a dict, JSON text, a path to a JSON file, or a :class:`Problem`.

    ``raster``: pixels (NumPy ``uint8`` array, PIL image) that replace the image of the
    first ``obstacles.raster`` source (or add one with default options).
    ``priority``: a callable ``f(item) -> score | (tier, score)`` evaluated once per item;
    its values are written into the problem as explicit ``priority`` / ``tier``.
    """
    raw: Optional[RawRaster] = None
    if isinstance(problem, Problem):
        doc, raw = problem._compile()
    else:
        doc = _load(problem)
    if priority is not None:
        items = doc.get("items")
        if isinstance(items, list):
            apply_priority_fn(items, priority)
            pr = doc.get("priority")
            if isinstance(pr, dict):
                pr.pop("terms", None)
    if raster is not None:
        raw = raw_raster(raster)
    return solve(doc, raw, measure=measure, cost=cost, progress=progress, cancelled=cancelled)


def validate(problem: ProblemLike) -> Report:
    """Validate a problem; returns a :class:`Report` (never raises for invalid problems)."""
    if isinstance(problem, str) and _path_text(problem) is None:
        text = problem
    else:
        try:
            text = dumps(_load(problem))
        except Exception as e:  # e.g. NaN in a dict
            errors = getattr(e, "errors", None)
            if errors is None:
                raise
            return Report(valid=False, errors=list(errors), warnings=[])
    return Report.from_dict(json.loads(_native.validate_json(text)))


def render_svg(problem: ProblemLike, result: Union[Result, Mapping[str, Any], str], *, raster: Any = None) -> str:
    """The debug SVG overlay of a problem and a result."""
    if isinstance(result, Result):
        raw_result: Any = result.raw
    elif isinstance(result, str):
        raw_result = json.loads(result)
    else:
        raw_result = dict(result)
    doc = _load(problem)
    raw = raw_raster(raster) if raster is not None else None
    return _native.render_svg(
        dumps(doc),
        json.dumps({k: v for k, v in raw_result.items() if k != "debug_svg"}),
        rgba=None if raw is None else raw.data,
        width=0 if raw is None else raw.width,
        height=0 if raw is None else raw.height,
    )


def _split_per_item(priority: Any, tiers: Any) -> tuple[Any, Any, Any, Any]:
    """(problem-level priority, per-item priorities, tier rules, per-item tiers)."""
    per_prio = None
    if priority is not None and is_number_list(priority):
        per_prio, priority = priority, None
    per_tier = None
    if isinstance(tiers, Iterator):
        tiers = list(tiers)
    if is_tier_list(tiers):
        per_tier, tiers = list(tiers), None
    return priority, per_prio, tiers, per_tier


def place(
    anchors: Iterable[Any],
    labels: Iterable[Any],
    *,
    # --- per item (one entry per anchor) ---
    ids: Optional[Iterable[Any]] = None,
    attrs: Any = None,
    marks: Any = None,
    required: Any = None,
    groups: Optional[Iterable[Optional[str]]] = None,
    keep_with: Optional[Iterable[Any]] = None,
    svg_ids: Optional[Iterable[Optional[str]]] = None,
    item_placement: Optional[Iterable[Optional[Mapping[str, Any]]]] = None,
    # --- canvas and coordinates ---
    canvas: Any = None,
    canvas_padding: Optional[Length] = None,
    allow_outside: Optional[bool] = None,
    device_pixel_ratio: Optional[float] = None,
    region: Optional[Sequence[float]] = None,
    canvas_background: Optional[str] = None,
    y_axis: Optional[str] = None,
    transform: Optional[Sequence[float]] = None,
    preset: Optional[str] = None,
    # --- label defaults ---
    font: Optional[FontLike] = None,
    font_family: Optional[str] = None,
    font_size: Optional[float] = None,
    font_weight: Union[int, str, None] = None,
    font_style: Optional[str] = None,
    line_height: Optional[float] = None,
    font_file: Any = None,
    padding: Optional[Length] = None,
    buffer: Optional[Length] = None,
    margin: Optional[Length] = None,
    mark: Any = None,
    wrap: Optional[WrapLike] = None,
    truncate: Optional[str] = None,
    shaping: Optional[str] = None,
    defaults: Optional[Mapping[str, Any]] = None,
    text: Optional[Mapping[str, Any]] = None,
    # --- backgrounds and obstacles ---
    background: Any = None,
    background_mode: Optional[str] = None,
    background_class: Optional[str] = None,
    background_scale: Optional[float] = None,
    background_offset: Optional[Sequence[float]] = None,
    background_options: Optional[Mapping[str, Any]] = None,
    svg_classes: Any = None,
    svg_default_class: Optional[str] = None,
    auto_mark_items: Optional[bool] = None,
    vector: Optional[Iterable[Mapping[str, Any]]] = None,
    obstacles: Optional[Mapping[str, Any]] = None,
    # --- what to avoid ---
    avoid: Optional[Mapping[str, Any]] = None,
    avoid_leader: Optional[Mapping[str, Any]] = None,
    avoid_buffer: Optional[Mapping[str, float]] = None,
    relaxable: Optional[Iterable[str]] = None,
    # --- placement models ---
    models: Union[str, Iterable[str], None] = None,
    position_order: Union[str, Iterable[str], None] = None,
    offset: Optional[Length] = None,
    max_distance: Optional[Length] = None,
    min_distance: Optional[Length] = None,
    slider_per_quadrant: Optional[int] = None,
    k_distant: Optional[int] = None,
    distant_rings: Optional[int] = None,
    distant_directions: Optional[int] = None,
    free_space_seeds: Optional[bool] = None,
    internal: Optional[str] = None,
    inner_padding: Optional[Length] = None,
    internal_circle_ratio: Optional[float] = None,
    prune_factor: Optional[float] = None,
    boundary: Any = None,
    fan: Optional[str] = None,
    own_nearest: Optional[bool] = None,
    stubs: Optional[str] = None,
    stub_length: Optional[Length] = None,
    stub_reach: Optional[Length] = None,
    placement: Optional[Mapping[str, Any]] = None,
    # --- leaders ---
    leaders: Optional[LeadersLike] = None,
    # --- priority and omission ---
    priority: Any = None,
    tiers: Any = None,
    omission: Optional[str] = None,
    coverage: Any = None,
    ties: Optional[str] = None,
    band: Optional[float] = None,
    max_labels: Optional[int] = None,
    max_ink_fraction: Optional[float] = None,
    focus: Optional[Sequence[float]] = None,
    font_classes: Optional[Sequence[Mapping[str, Any]]] = None,
    # --- solver ---
    strategy: Optional[str] = None,
    time_budget_ms: Optional[float] = None,
    max_iterations: Optional[int] = None,
    seed: Optional[int] = None,
    grid_cell: Union[float, str, None] = None,
    solver: Optional[Mapping[str, Any]] = None,
    # --- degradation ladder, weights, warm start ---
    degrade: Optional[Iterable[str]] = None,
    min_scale: Optional[float] = None,
    wrap_max_lines: Optional[int] = None,
    soft_overlap_weight: Optional[float] = None,
    degrade_options: Optional[Mapping[str, Any]] = None,
    weights: Optional[Mapping[str, float]] = None,
    warm_start: Any = None,
    # --- output ---
    debug_svg: Optional[bool] = None,
    cost_breakdown: Optional[bool] = None,
    candidates: Optional[bool] = None,
    item_shape: Optional[bool] = None,
    output: Optional[Mapping[str, Any]] = None,
    # --- host callbacks (not schema fields) ---
    measure: Optional[MeasureFn] = None,
    cost: Optional[CostFn] = None,
    progress: Optional[ProgressFn] = None,
    cancelled: Any = None,
) -> Result:
    """Place labels in one call.

    ``anchors`` are ``(x, y)`` pairs in canvas pixels (or data units with ``transform`` /
    ``y_axis``; an ``(N, 2)`` array or a two-column DataFrame works too), :class:`Area`
    polygons or anchor dicts; ``labels`` are strings, :class:`Text`, :class:`Icon`,
    :class:`Box`, :class:`Composite` or label dicts. ``attrs`` values may be dates
    (ISO 8601 strings in the problem) and durations (seconds).
    Every other keyword maps 1:1 to a schema field (see ``docs/bindings/python.md``);
    ``None`` leaves the spec default.

    * ``background``: a raster/SVG path, bytes, SVG markup, a NumPy RGBA/RGB array or a
      PIL image (``background_mode``, ``svg_classes``, ... set its options).
    * ``avoid``: ``{"ink": 0.5, "outliers": "hard"}`` (label vs. class) or the full
      ``{"label": ..., "leader": ..., "buffer": ...}`` object.
    * ``leaders``: a style name or :class:`Leaders`.
    * ``priority``: a :class:`Priority` (terms), an attribute name, a list of numbers
      (one per item) or a callable ``f(item) -> score | (tier, score)``.
    * ``tiers``: tier rules ``[{"where": expr, "tier": n}]`` or one int per item.
    * ``measure``, ``cost``, ``progress``, ``cancelled``: host callbacks.
    """
    params = dict(locals())
    options = {
        k: v
        for k, v in params.items()
        if v is not None
        and k
        not in (
            "anchors",
            "labels",
            "ids",
            "attrs",
            "marks",
            "required",
            "groups",
            "keep_with",
            "svg_ids",
            "item_placement",
            "priority",
            "tiers",
            "measure",
            "cost",
            "progress",
            "cancelled",
        )
    }
    prio, per_prio, tier_rules_, per_tier = _split_per_item(priority, tiers)
    p = Problem(**options)
    p.items(
        anchors,
        labels,
        ids=ids,
        attrs=attrs,
        marks=marks,
        priority=per_prio,
        tiers=per_tier,
        required=required,
        groups=groups,
        keep_with=keep_with,
        svg_ids=svg_ids,
        placement=item_placement,
    )
    p.set(priority=prio, tiers=tier_rules_)
    return p.solve(measure=measure, cost=cost, progress=progress, cancelled=cancelled)
