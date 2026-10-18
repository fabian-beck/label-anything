"""label_points for Plotly: annotations and leader shapes."""

from __future__ import annotations

import math
from typing import Any, Tuple

import pytest

np = pytest.importorskip("numpy")
go = pytest.importorskip("plotly.graph_objects")
from plotly.subplots import make_subplots  # noqa: E402

import label_anything as la  # noqa: E402
from label_anything_extras.plotly import PlotlyLabels, label_points  # noqa: E402


def data(n: int = 60, seed: int = 2) -> Tuple[Any, Any]:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=n)
    return x, x + rng.normal(scale=0.4, size=n)


def to_px(fig: Any, ax: str, v: float, log: bool = False) -> float:
    """Plot-area pixel of a value on axis ``xaxis``/``yaxis`` (y measured upwards)."""
    a = fig.layout[ax]
    r0, r1 = a.range
    return ((math.log10(v) if log else v) - r0) / (r1 - r0)


def test_annotations_and_layout() -> None:
    x, y = data()
    fig = go.Figure(go.Scatter(x=x, y=y, mode="markers"))
    out = label_points(fig, x, y, [f"p{i}" for i in range(60)], priority=la.Priority.outlierness(), max_labels=12)
    assert isinstance(out, PlotlyLabels)
    res = out.result
    assert res.stats["hard_violations"] == 0
    assert len(out.annotations) == len(res.placed) == 12
    assert fig.layout.width == 700 and fig.layout.height == 450
    assert fig.layout.xaxis.range is not None and fig.layout.xaxis.autorange is False
    assert len(fig.layout.annotations) == 12
    by_id = {p.id: p for p in res.placed}
    for ann in out.annotations:
        assert ann["xref"] == "x" and ann["yref"] == "y" and ann["showarrow"] is False
        p = next(q for q in res.placed if q.lines[0] == ann["text"])
        i = int(p.id)
        # the annotation centre is the box centre: back to plot-area fractions
        fx = to_px(fig, "xaxis", ann["x"])
        fy = to_px(fig, "yaxis", ann["y"])
        cw, ch = res.problem["canvas"]["width"], res.problem["canvas"]["height"]
        assert fx * cw == pytest.approx(p.box.cx, abs=1e-6)
        assert (1 - fy) * ch == pytest.approx(p.box.cy, abs=1e-6)
        # and the label sits next to its point
        px, py = to_px(fig, "xaxis", x[i]) * cw, (1 - to_px(fig, "yaxis", y[i])) * ch
        assert math.hypot(px - p.box.cx, py - p.box.cy) < 40
        assert i in {int(k) for k in by_id}


def test_leader_shapes_and_log_axes() -> None:
    x, y = data(40)
    xs = 10 ** (x + 2)
    fig = go.Figure(go.Scatter(x=xs, y=y, mode="markers"))
    fig.update_xaxes(type="log")
    out = label_points(fig, xs, y, [f"L{i}" for i in range(40)], models=["distant"], leaders="straight", max_labels=6)
    assert out.shapes and len(out.shapes) >= len([p for p in out.result.placed if p.leader])
    r0, r1 = fig.layout.xaxis.range
    for ann in out.annotations:
        assert r0 <= ann["x"] <= r1  # annotations: log10 units on log axes
    for s in out.shapes:
        assert s["type"] == "path" and s["path"].startswith("M ")
        xs_path = [float(tok.split(",")[0]) for tok in s["path"].replace("M ", "").split(" L ")]
        for v in xs_path:  # shapes: data units
            assert 10**r0 <= v <= 10**r1
    assert len(fig.layout.shapes) == len(out.shapes)


def test_other_traces_are_obstacles() -> None:
    x, y = data(30)
    bx, by = data(300, seed=9)
    fig = go.Figure([go.Scatter(x=bx, y=by, mode="markers", marker={"size": 4}), go.Scatter(x=x, y=y, mode="markers"), go.Scatter(x=[-2, 2], y=[-2, 2], mode="lines")])
    out = label_points(fig, x, y, [f"a{i}" for i in range(30)], add=False)
    layers = {layer["class"]: layer for layer in out.result.problem["obstacles"]["vector"]}
    assert len(layers["points"]["points"]) == 300 and layers["points"]["r"] == 2.0
    assert "lines" in layers
    assert not fig.layout.annotations


def test_subplots() -> None:
    x, y = data(20)
    fig = make_subplots(rows=1, cols=2)
    fig.add_trace(go.Scatter(x=x, y=y, mode="markers"), row=1, col=1)
    fig.add_trace(go.Scatter(x=x, y=-y, mode="markers"), row=1, col=2)
    out = label_points(fig, x, -y, [f"b{i}" for i in range(20)], row=1, col=2)
    assert all(a["xref"] == "x2" and a["yref"] == "y2" for a in out.annotations)
    dom = fig.layout.xaxis2.domain
    assert out.result.problem["canvas"]["width"] == pytest.approx((dom[1] - dom[0]) * (700 - 160))


def test_marker_sizes_per_point() -> None:
    pd = pytest.importorskip("pandas")
    x, y = data(5)
    sizes = [6.0, 10.0, 14.0, 18.0, 22.0]
    for ms in [sizes, np.array(sizes), pd.Series(sizes, index=[7, 8, 9, 10, 11])]:
        out = label_points(go.Figure(go.Scatter(x=x, y=y, mode="markers")), x, y, list("abcde"), marker_size=ms)
        assert [it["anchor"]["mark"]["r"] for it in out.result.problem["items"]] == [s / 2 for s in sizes]
    with pytest.raises(ValueError, match="marker_size has 2 values but there are 5 points"):
        label_points(go.Figure(), x, y, list("abcde"), marker_size=[6, 8])


def test_a_priority_lets_important_labels_cover_minor_dots() -> None:
    x, y = data(5)
    fig = go.Figure(go.Scatter(x=x, y=y, mode="markers"))
    avoid = label_points(fig, x, y, list("abcde"), priority=[5, 4, 3, 2, 1]).result.problem["avoid"]
    assert avoid == {"label": {"lower_items": 10}, "leader": {"lower_items": 2.5}}
    own = label_points(go.Figure(), x, y, list("abcde"), priority=[5, 4, 3, 2, 1], avoid={"points": 0.5})
    assert own.result.problem["avoid"]["label"] == {"lower_items": 10, "points": 0.5}
    assert "avoid" not in label_points(go.Figure(), x, y, list("abcde")).result.problem


def test_annotation_font_is_merged() -> None:
    x, y = data(10)
    out = label_points(go.Figure(), x, y, list("abcdefghij"), font_size=14, annotation_kw={"font": {"color": "red"}})
    assert all(a["font"] == {"color": "red", "size": 14} for a in out.annotations)
    with pytest.raises(TypeError, match="font size 20 differs"):
        label_points(go.Figure(), x, y, list("abcdefghij"), font_size=14, annotation_kw={"font": {"size": 20}})


def test_category_axes_are_rejected() -> None:
    fig = go.Figure(go.Scatter(x=["a", "b"], y=[1, 2]))
    fig.update_xaxes(type="category")
    with pytest.raises(ValueError, match="linear and log"):
        label_points(fig, [0, 1], [1, 2], ["a", "b"])


def test_shim_module() -> None:
    import label_anything.plotly as shim

    assert shim.label_points is label_points
