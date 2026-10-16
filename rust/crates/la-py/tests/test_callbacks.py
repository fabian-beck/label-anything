"""Host callbacks: measure, cost, progress, cancellation and priority callables."""

from __future__ import annotations

import threading
import time
import traceback
from typing import Any, Dict, List, Tuple

import pytest

import label_anything as la
from label_anything import _native

POINTS = [(60.0 + 37.0 * (i % 8), 50.0 + 41.0 * (i // 8)) for i in range(32)]
NAMES = [f"label{i}" for i in range(32)]


class Boom(Exception):
    pass


def grid(n: int, w: float = 1000.0) -> List[Tuple[float, float]]:
    import random

    rnd = random.Random(7)
    return [(rnd.uniform(0, w), rnd.uniform(0, w)) for _ in range(n)]


# --- measure -----------------------------------------------------------------------
def test_measure_sets_the_label_size() -> None:
    calls: List[Tuple[str, la.FontSpec]] = []

    def measure(text: str, font: la.FontSpec) -> Dict[str, float]:
        calls.append((text, font))
        return {"width": 10.0 * len(text), "ascent": 7.0, "descent": 3.0}

    res = la.place([(100, 100)], ["abcd"], canvas=(300, 300), padding=1, measure=measure)
    box = res.placements[0].box
    assert box is not None
    assert box.w == pytest.approx(40 + 2)
    assert box.h == pytest.approx(10 + 2)
    texts = {t for t, _ in calls}
    assert "abcd" in texts and "" in texts  # "" asks for the vertical metrics
    font = calls[0][1]
    assert isinstance(font, la.FontSpec)
    assert font.family == "default" and font.weight == 400 and font.italic is False
    assert font.size == pytest.approx(12.0)


@pytest.mark.parametrize(
    "ret",
    [
        {"width": 30.0, "ascent": 8.0, "descent": 2.0},
        (30.0, 8.0, 2.0),
        [30, 8, 2],
        la.TextMetrics(30.0, 8.0, 2.0),
    ],
)
def test_measure_return_forms(ret: Any) -> None:
    res = la.place([(100, 100)], ["x"], canvas=(300, 300), padding=0, measure=lambda t, f: ret)
    assert res.placements[0].box is not None
    assert res.placements[0].box.w == pytest.approx(30.0)
    assert res.placements[0].box.h == pytest.approx(10.0)


def test_measure_none_falls_back_to_the_bundled_font() -> None:
    plain = la.place([(100, 100)], ["Hello"], canvas=(300, 300))
    deferred = la.place([(100, 100)], ["Hello"], canvas=(300, 300), measure=lambda t, f: None)
    assert plain.placements[0].box == deferred.placements[0].box


def test_measure_results_are_cached() -> None:
    seen: Dict[Tuple[str, float], int] = {}

    def measure(text: str, font: la.FontSpec) -> Tuple[float, float, float]:
        seen[(text, font.size)] = seen.get((text, font.size), 0) + 1
        return (6.0 * len(text), 9.0, 3.0)

    la.place(POINTS, ["same"] * len(POINTS), canvas=(400, 400), measure=measure)
    assert seen and max(seen.values()) == 1


def test_measure_exception_propagates() -> None:
    def measure(text: str, font: la.FontSpec) -> Any:
        raise Boom(f"cannot measure {text!r}")

    with pytest.raises(Boom, match="cannot measure") as info:
        la.place(POINTS, NAMES, canvas=(400, 400), measure=measure)
    # the traceback still shows the callback
    assert "measure" in "".join(traceback.format_tb(info.value.__traceback__))


@pytest.mark.parametrize(
    "ret, exc",
    [("wide", TypeError), ({"width": 3.0}, TypeError), ((1.0, 2.0), TypeError), ((-1.0, 2.0, 3.0), ValueError), ((float("nan"), 2.0, 3.0), ValueError)],
)
def test_measure_bad_results(ret: Any, exc: type) -> None:
    with pytest.raises(exc):
        la.place([(100, 100)], ["x"], canvas=(300, 300), measure=lambda t, f: ret)


def test_measure_with_wrapping() -> None:
    def measure(text: str, font: la.FontSpec) -> Tuple[float, float, float]:
        return (7.0 * len(text), 8.0, 2.0)

    res = la.place([(150, 150)], [la.Text("alpha beta gamma delta", wrap=la.Wrap(max_width=80, max_lines=3))], canvas=(300, 300), measure=measure)
    p = res.placements[0]
    assert len(p.lines) >= 2
    assert all(7.0 * len(line) <= 80 for line in p.lines)


# --- cost ---------------------------------------------------------------------------
def test_cost_callback_steers_the_placement() -> None:
    seen: List[la.Candidate] = []

    def prefer_right(c: la.Candidate) -> float:
        seen.append(c)
        return 0.0 if c.box.x > 150 else 50.0

    res = la.place([(150, 150)], ["right"], canvas=(300, 300), models=["adjacent"], cost=prefer_right)
    p = res.placements[0]
    assert p.anchor_side in ("right", "top-right", "bottom-right")
    assert seen and all(isinstance(c, la.Candidate) and isinstance(c.box, la.BBox) for c in seen)
    assert {c.id for c in seen} == {"0"}
    assert all(c.leader is False for c in seen)


def test_cost_sees_leaders() -> None:
    leaders: List[bool] = []
    la.place([(150, 150)], ["far"], canvas=(300, 300), models=["distant"], cost=lambda c: leaders.append(c.leader) or 0.0)
    assert leaders and all(leaders)


def test_cost_exception_propagates() -> None:
    calls = []

    def cost(c: la.Candidate) -> float:
        calls.append(c)
        if len(calls) == 5:
            raise Boom("bad candidate")
        return 0.0

    with pytest.raises(Boom, match="bad candidate"):
        la.place(POINTS, NAMES, canvas=(400, 400), cost=cost)
    # the solve stopped calling back after the exception
    assert len(calls) == 5


@pytest.mark.parametrize("ret, exc", [("x", TypeError), (-1.0, ValueError), (float("inf"), ValueError)])
def test_cost_bad_results(ret: Any, exc: type) -> None:
    with pytest.raises(exc):
        la.place([(100, 100)], ["x"], canvas=(300, 300), cost=lambda c: ret)


def test_base_exceptions_propagate() -> None:
    def cost(c: la.Candidate) -> float:
        raise KeyboardInterrupt

    with pytest.raises(KeyboardInterrupt):
        la.place([(100, 100)], ["x"], canvas=(300, 300), cost=cost)


# --- progress -----------------------------------------------------------------------
def test_progress_phases() -> None:
    events: List[Tuple[str, float]] = []
    la.place(POINTS, NAMES, canvas=(400, 400), progress=lambda phase, f: events.append((phase, f)))
    phases = [p for p, _ in events]
    assert "greedy" in phases
    assert events[-1] == ("done", 1.0)
    assert all(0.0 <= f <= 1.0 for _, f in events)


def test_progress_exception_propagates() -> None:
    def progress(phase: str, fraction: float) -> None:
        raise Boom(phase)

    with pytest.raises(Boom, match="greedy"):
        la.place(POINTS, NAMES, canvas=(400, 400), progress=progress)


# --- cancellation -------------------------------------------------------------------
def test_cancel_token() -> None:
    tok = la.CancelToken()
    assert not tok.cancelled and not tok.is_set()
    tok.cancel()
    assert tok.cancelled and tok.is_set()
    assert "cancelled=True" in repr(tok)
    with pytest.raises(la.Cancelled):
        la.place(POINTS, NAMES, canvas=(400, 400), cancelled=tok)
    tok.reset()
    assert la.place(POINTS, NAMES, canvas=(400, 400), cancelled=tok).stats["placed"] > 0


def test_cancel_from_a_callback() -> None:
    tok = la.CancelToken()
    calls = []

    def cost(c: la.Candidate) -> float:
        calls.append(c)
        if len(calls) == 20:
            tok.cancel()
        return 0.0

    with pytest.raises(la.Cancelled):
        la.place(POINTS, NAMES, canvas=(400, 400), cost=cost, cancelled=tok)


@pytest.mark.parametrize("kind", ["callable", "event", "attribute"])
def test_cancel_sources(kind: str) -> None:
    state = {"n": 0}
    if kind == "callable":

        def source() -> bool:
            state["n"] += 1
            return state["n"] > 1

        token: Any = source
    elif kind == "event":
        token = threading.Event()
        token.set()
    else:

        class Flag:
            cancelled = True

        token = Flag()
    with pytest.raises(la.Cancelled):
        la.place(POINTS, NAMES, canvas=(400, 400), cancelled=token)


def test_cancel_callable_exception_propagates() -> None:
    def source() -> bool:
        raise Boom("token broke")

    with pytest.raises(Boom, match="token broke"):
        la.place(POINTS, NAMES, canvas=(400, 400), cancelled=source)


def test_cancel_from_another_thread() -> None:
    pts = grid(2000)
    labels = [f"L{i}" for i in range(2000)]
    tok = la.CancelToken()
    out: Dict[str, Any] = {}

    def run() -> None:
        try:
            out["result"] = la.place(pts, labels, canvas=(1000, 1000), time_budget_ms=3000, cancelled=tok)
        except la.Cancelled as e:
            out["cancelled"] = e

    th = threading.Thread(target=run)
    th.start()
    time.sleep(0.15)
    t0 = time.perf_counter()
    tok.cancel()
    th.join(30)
    assert "cancelled" in out, "the solve finished before the cancellation request"
    assert time.perf_counter() - t0 < 2.0


# --- the GIL ------------------------------------------------------------------------
def _count_while(th: threading.Thread) -> int:
    n = 0
    while th.is_alive():
        n += 1
    return n


@pytest.mark.parametrize("with_callback", [False, True])
def test_gil_is_released_while_solving(with_callback: bool) -> None:
    pts = grid(2000)
    labels = [f"L{i}" for i in range(2000)]
    kw: Dict[str, Any] = {"progress": lambda p, f: None} if with_callback else {}
    started = threading.Event()

    def run() -> None:
        started.set()
        la.place(pts, labels, canvas=(1000, 1000), time_budget_ms=300, **kw)

    th = threading.Thread(target=run)
    th.start()
    started.wait()
    spins = _count_while(th)
    th.join()
    # with the GIL held for the whole solve, this thread could hardly run at all
    assert spins > 10_000


def test_concurrent_solves_are_independent() -> None:
    problems = [(grid(150), [f"P{i}" for i in range(150)], seed) for seed in range(4)]
    expected = [la.place(p, l, canvas=(1000, 1000), seed=s).raw["placements"] for p, l, s in problems]
    got: Dict[int, Any] = {}

    def run(k: int) -> None:
        p, l, s = problems[k]
        got[k] = la.place(p, l, canvas=(1000, 1000), seed=s).raw["placements"]

    threads = [threading.Thread(target=run, args=(k,)) for k in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert [got[k] for k in range(4)] == expected


# --- priority callables ------------------------------------------------------------
def test_priority_callable_scores() -> None:
    pts = [(100.0 + i * 0.5, 100.0) for i in range(6)]  # all compete for one spot
    items_seen: List[Dict[str, Any]] = []

    def score(item: Dict[str, Any]) -> float:
        items_seen.append(item)
        return float(item["attrs"]["w"])

    res = la.place(pts, [f"n{i}" for i in range(6)], canvas=(300, 200), attrs=[{"w": w} for w in (1, 5, 3, 9, 2, 4)], priority=score, max_labels=1, omission="prefix")
    assert [p.id for p in res.placed] == ["3"]
    assert len(items_seen) == 6
    assert all(it["priority"] == w for it, w in zip(res.problem["items"], (1, 5, 3, 9, 2, 4)))
    assert "terms" not in res.problem.get("priority", {})
    # omission order: lowest priority first
    assert res.omission_order == ["0", "4", "2", "5", "1"]


def test_priority_callable_tiers() -> None:
    def tiered(item: Dict[str, Any]) -> Tuple[int, float]:
        return (1 if item["id"] == "b" else 0, 0.0)

    res = la.place([(100, 100), (101, 100)], ["a", "b"], ids=["a", "b"], canvas=(300, 200), priority=tiered, max_labels=1, omission="prefix")
    assert [p.id for p in res.placed] == ["b"]
    assert res.problem["items"][1]["tier"] == 1
    assert res["b"].priority is not None and res["b"].priority["tier"] == 1


def test_priority_callable_in_place_problem() -> None:
    problem = {
        "canvas": {"width": 300, "height": 200},
        "items": [
            {"id": "x", "anchor": {"type": "point", "x": 100, "y": 100}, "label": {"type": "text", "text": "x"}},
            {"id": "y", "anchor": {"type": "point", "x": 100.5, "y": 100}, "label": {"type": "text", "text": "y"}},
        ],
        "priority": {"terms": [{"builtin": "input_order"}], "budget": {"max_labels": 1}},
    }
    res = la.place_problem(problem, priority=lambda it: 2.0 if it["id"] == "y" else 1.0)
    assert [p.id for p in res.placed] == ["y"]
    assert "terms" not in problem["priority"] or problem["priority"]["terms"]  # input unchanged


def test_priority_callable_errors_propagate() -> None:
    with pytest.raises(Boom):
        la.place(POINTS, NAMES, priority=lambda it: (_ for _ in ()).throw(Boom()))
    with pytest.raises(la.ValidationError):
        la.place(POINTS, NAMES, priority=lambda it: float("nan"))


def test_native_rejects_non_callables() -> None:
    with pytest.raises(TypeError):
        _native.place_json('{"items": []}', measure=42)
