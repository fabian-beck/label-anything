import pytest

from bench.eval import evaluate_sequence
from bench.eval.tests.helpers import item, omitted, placed, problem, result


def test_displacement_flips_and_nesting():
    f0 = problem([item("A", 50, 50), item("B", 100, 50), item("C", 150, 50)])
    # zoom in by 2 around (100, 50): A -> (0, 50) (now off-screen and dropped), B stays, C -> (200, 50)
    f1 = problem([item("B", 100, 50), item("C", 196, 50)], width=300)
    r0 = result([placed("A", 55, 30), placed("B", 105, 30), omitted("C")])
    # B keeps its offset (+5, -20) -> displacement 0; C newly placed
    r1 = result([placed("B", 105, 30), placed("C", 200, 30)])
    m = evaluate_sequence([(f0, r0), (f1, r1)], ["start", "zoom_in"])
    assert m["zoom_in_steps"] == 1 and m["nesting_rate"] == 1.0
    assert m["displacement_mean_px"] == pytest.approx(0.0)
    assert m["steps"][0]["added"] == 1 and m["steps"][0]["removed"] == 0
    # B moves 6 px and flips side; and A visible but dropped on a zoom-in step breaks nesting
    f1b = problem([item("A", 20, 50), item("B", 100, 50)], width=300)
    r1b = result([omitted("A"), placed("B", 111, 30, side="right")])
    m = evaluate_sequence([(f0, r0), (f1b, r1b)], ["start", "zoom_in"])
    assert m["displacement_mean_px"] == pytest.approx(6.0)
    assert m["flip_rate"] == pytest.approx(1.0)
    assert m["nesting_rate"] == 0.0 and m["steps"][0]["nesting_fraction"] == pytest.approx(0.5)
