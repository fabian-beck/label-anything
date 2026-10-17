"""adjustText in a sequence: one emulation and one iteration budget for all frames."""
from __future__ import annotations

import pytest

from bench.baselines import BASELINES, Unsupported
from bench.baselines.results import baseline_info
from bench.eval.tests.helpers import item, problem

pytest.importorskip("matplotlib")
if BASELINES["adjusttext"].check() is not None:
    pytest.skip("adjustText not installed", allow_module_level=True)

from bench.baselines import adjusttext_baseline as at  # noqa: E402


def frames(n: int, labels: int = 6) -> list[tuple[dict, None]]:
    """``n`` frames of a row of labels that drifts to the right, each overlapping its neighbours."""
    return [(problem([item(f"L{i}", 40.0 + 12.0 * i + 3.0 * k, 50.0, w=30.0, h=10.0) for i in range(labels)],
                     width=200.0, height=100.0), None) for k in range(n)]


def test_small_sequences_keep_the_full_iteration_budget():
    opts = BASELINES["adjusttext"].sequence_options(frames(3))
    assert opts == {"step": at.STEPS[0], "iter_lim": at.ITER_LIM}


def test_the_budget_divides_by_the_comparisons_of_all_frames(monkeypatch):
    fr = frames(4)
    _step, costs = at.plan([at.build_scene(p, None) for p, _ in fr])
    total = sum(costs)
    assert total > 0
    monkeypatch.setattr(at, "SEQ_BUDGET", 12.5 * total)
    assert at.sequence_options(fr)["iter_lim"] == 12
    # twice the frames, half the iterations: the sequence's cost stays within the budget
    _step, costs8 = at.plan([at.build_scene(p, None) for p, _ in frames(8)])
    assert at.sequence_options(frames(8))["iter_lim"] == int(12.5 * total // sum(costs8))
    monkeypatch.setattr(at, "SEQ_BUDGET", (at.SEQ_MIN_ITER - 0.5) * total)
    with pytest.raises(Unsupported, match="sequence budget"):
        at.sequence_options(fr)


def test_a_frame_beyond_the_pair_limit_makes_the_sequence_unsupported(monkeypatch):
    monkeypatch.setattr(at, "PAIR_LIMIT", 1.0)
    with pytest.raises(Unsupported, match="frame 0"):
        at.sequence_options(frames(2))


def test_frames_are_solved_with_the_planned_iterations():
    (p, _), = frames(1)
    res = at.solve(p, None, {"step": at.STEPS[0], "iter_lim": 7})
    assert all(q["placed"] for q in res["placements"])
    assert ("adjusttext-iterations: 7 iterations per frame (the comparison budget of the sequence)"
            in baseline_info(res)["emulations"])
    # a problem on its own gets the full budget, without the note
    assert not any("iterations" in m for m in baseline_info(at.solve(p))["emulations"])


def test_other_baselines_plan_nothing():
    assert BASELINES["textalloc"].sequence_options(frames(2)) is None
