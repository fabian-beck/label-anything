"""label_points for matplotlib (Agg, headless)."""

from __future__ import annotations

import io
from typing import Any, List, Tuple

import pytest

np = pytest.importorskip("numpy")
matplotlib = pytest.importorskip("matplotlib")
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.lines import Line2D  # noqa: E402
from matplotlib.text import Text  # noqa: E402

import label_anything as la  # noqa: E402
from label_anything_extras.matplotlib import (  # noqa: E402
    MatplotlibLabels,
    figure_background,
    label_points,
    svg_classes,
    text_measure,
)


def scatter(n: int = 120, seed: int = 1) -> Tuple[Any, Any, Any, Any]:
    rng = np.random.default_rng(seed)
    x = rng.normal(size=n)
    y = 0.5 * x + rng.normal(scale=0.6, size=n)
    fig, ax = plt.subplots(figsize=(6, 4), dpi=100)
    ax.scatter(x, y, s=16, color="0.5")
    ax.set_title("A scatter plot")
    return fig, ax, x, y


def extents(texts: List[Text], fig: Any) -> List[Any]:
    renderer = fig.canvas.get_renderer()
    return [t.get_window_extent(renderer) for t in texts]


def overlaps(a: Any, b: Any, tol: float = 0.5) -> bool:
    return min(a.x1, b.x1) - max(a.x0, b.x0) > tol and min(a.y1, b.y1) - max(a.y0, b.y0) > tol


def test_label_points_draws_texts_inside_the_axes() -> None:
    fig, ax, x, y = scatter()
    xlim, ylim = ax.get_xlim(), ax.get_ylim()
    names = [f"p{i}" for i in range(len(x))]
    out = label_points(ax, x, y, names, priority=la.Priority.outlierness(k=5), max_labels=20)
    assert isinstance(out, MatplotlibLabels)
    res = out.result
    assert res.stats["hard_violations"] == 0
    assert 0 < len(res.placed) <= 20
    assert len(out.texts) == sum(len(p.lines) for p in res.placed)
    assert all(isinstance(t, Text) for t in out.texts)
    assert {t.get_text() for t in out.texts} == {p.lines[0] for p in res.placed}
    # the view is frozen
    assert ax.get_xlim() == pytest.approx(xlim) and ax.get_ylim() == pytest.approx(ylim)
    fig.canvas.draw()
    assert ax.get_xlim() == pytest.approx(xlim)
    axes_box = ax.get_window_extent()
    boxes = extents(out.texts, fig)
    for bb in boxes:
        assert bb.x0 >= axes_box.x0 - 1 and bb.x1 <= axes_box.x1 + 1
        assert bb.y0 >= axes_box.y0 - 1 and bb.y1 <= axes_box.y1 + 1
    for i, a in enumerate(boxes):
        for b in boxes[i + 1 :]:
            assert not overlaps(a, b)
    # the title and tick labels are visible again
    assert ax.title.get_visible()
    assert all(t.get_visible() for t in ax.get_xticklabels())


def test_texts_match_the_placed_boxes() -> None:
    fig, ax, x, y = scatter(40)
    out = label_points(ax, x, y, [f"label{i}" for i in range(40)], max_labels=10)
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    height = fig.bbox.height
    axes = ax.get_window_extent(renderer)
    frame_left, frame_top = np.floor(axes.x0), np.floor(height - axes.y1)
    by_text = {t.get_text(): t for t in out.texts}
    for p in out.result.placed:
        assert p.box is not None
        t = by_text[p.lines[0]]
        bb = t.get_window_extent(renderer)
        # display → canvas px of the axes region
        x0, y_top = bb.x0 - frame_left, (height - bb.y1) - frame_top
        assert x0 == pytest.approx(p.box.x + p.text["x_offset"], abs=1.5)
        assert x0 + bb.width <= p.box.x1 + 1.5
        assert y_top >= p.box.y - 1.5 and y_top + bb.height <= p.box.y1 + 1.5


def test_existing_texts_and_legends_are_avoided() -> None:
    fig, ax, x, y = scatter(80)
    note = ax.text(0.0, 0.0, "EXISTING NOTE", fontsize=14, ha="center", va="center")
    ax.plot([], [], label="series")
    leg = ax.legend(loc="upper left")
    out = label_points(ax, x, y, [f"n{i}" for i in range(80)])
    kinds = {layer["class"] for layer in out.result.problem["obstacles"]["vector"]}
    assert {"text", "legend"} <= kinds
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    blocked = [note.get_window_extent(renderer), leg.get_window_extent(renderer)]
    for bb in extents(out.texts, fig):
        for other in blocked:
            assert not overlaps(bb, other, tol=1.0)


def test_a_priority_lets_important_labels_cover_minor_dots() -> None:
    fig, ax, x, y = scatter(40)
    names = [f"n{i}" for i in range(40)]
    avoid = label_points(ax, x, y, names, priority=list(range(40)), draw=False).result.problem["avoid"]
    assert avoid["label"]["lower_items"] == 10 and avoid["leader"]["lower_items"] == 2.5
    plain = label_points(ax, x, y, names, draw=False).result.problem
    assert "lower_items" not in plain.get("avoid", {}).get("label", {})
    own = label_points(ax, x, y, names, priority=list(range(40)), avoid={"lower_items": "hard"}, draw=False)
    assert own.result.problem["avoid"]["label"]["lower_items"] == "hard"


def test_leader_lines() -> None:
    fig, ax, x, y = scatter(60)
    out = label_points(ax, x, y, [f"name{i}" for i in range(60)], models=["distant"], leaders="straight", max_labels=8)
    with_leaders = [p for p in out.result.placed if p.leader is not None]
    assert with_leaders and len(out.leaders) >= len(with_leaders)
    assert all(isinstance(ln, Line2D) for ln in out.leaders)
    for ln in out.leaders:
        assert ln in ax.get_children()
        assert len(ln.get_xdata()) >= 2


def test_raster_background_has_no_text() -> None:
    fig, ax, x, y = scatter(30)
    ax.text(0.0, 0.0, "MMMMMMMM", fontsize=30, ha="center", va="center", color="red")
    bg = figure_background(ax)
    img = bg.background
    assert img.dtype == np.uint8 and img.ndim == 3 and img.shape[2] == 4
    assert img.shape[1] == bg.frame.width and img.shape[0] == bg.frame.height
    red = (img[:, :, 0] > 200) & (img[:, :, 1] < 80) & (img[:, :, 2] < 80)
    assert not red.any()
    # ... while the normal rendering shows it
    fig.canvas.draw()
    full = np.asarray(fig.canvas.buffer_rgba())
    assert ((full[:, :, 0] > 200) & (full[:, :, 1] < 80) & (full[:, :, 2] < 80)).any()
    assert bg.options["background_options"] == {"ink": {"background": "#ffffff"}}
    assert any(r[2] > 50 for r in bg.text_rects)  # the hidden text is an obstacle instead


def test_svg_background_mode() -> None:
    fig, ax, x, y = scatter(80)
    ax.axvspan(-0.5, 0.5, color="black")  # a big filled band
    out = label_points(
        ax, x, y, [f"q{i}" for i in range(80)],
        background="svg", avoid={"ink": "hard"}, relaxable=[], max_labels=30,
    )
    res = out.result
    svg = res.problem["obstacles"]["svg"]
    assert "<svg" in svg["source"] and svg["classes"] == svg_classes(["la-bg-figure", "la-bg-axes-0"])
    canvas = res.problem["canvas"]
    assert canvas["width"] == pytest.approx(fig.bbox.width) and len(canvas["region"]) == 4
    assert res.stats["hard_violations"] == 0
    assert "ink" in res.stats["grid"]["classes"] and "points" in res.stats["grid"]["classes"]
    # no label on the band
    fig.canvas.draw()
    band = ax.transData.transform([(-0.5, 0), (0.5, 0)])[:, 0]
    for bb in extents(out.texts, fig):
        assert bb.x1 <= band[0] + 1 or bb.x0 >= band[1] - 1
    # the background patches did not leak into the obstacles
    assert ax.patch.get_gid() is None and fig.patch.get_gid() is None


def test_matplotlib_svg_file_as_background() -> None:
    """A figure saved as SVG, used directly as ``background=`` with explicit rules."""
    fig, ax = plt.subplots(figsize=(4, 3), dpi=100)
    ax.bar([0, 1, 2], [3, 1, 2], color="C0")
    fig.patch.set_gid("la-bg-figure")
    ax.patch.set_gid("la-bg-axes-0")
    buf = io.StringIO()
    fig.savefig(buf, format="svg")
    svg = buf.getvalue()
    fig.canvas.draw()
    w, h = fig.bbox.width, fig.bbox.height
    # anchors: the bar tops in canvas px (y down)
    tops = ax.transData.transform([(0, 3), (1, 1), (2, 2)])
    anchors = [(px, h - py) for px, py in tops]
    res = la.place(
        anchors, ["three", "one", "two"], canvas=(w, h), background=svg,
        svg_classes=svg_classes(), avoid={"ink": "hard"}, relaxable=[], models=["adjacent"],
    )
    assert res.stats["hard_violations"] == 0 and res.warnings == []
    assert "ink" in res.stats["grid"]["classes"]
    bars = [b.get_window_extent() for b in ax.patches]
    for p in res.placed:
        assert p.box is not None
        for bb in bars:
            top, bottom = h - bb.y1, h - bb.y0
            inside_x = min(p.box.x1, bb.x1) - max(p.box.x, bb.x0) > 0.5
            inside_y = min(p.box.y1, bottom) - max(p.box.y, top) > 0.5
            assert not (inside_x and inside_y), (p.id, p.box)
    # A label in empty axes space: with the explicit rules the axes background patch is
    # ignored; with the preset rules it (< 90 % of the figure, so not `:background`) is
    # classed `lines` and the whole label covers it: the `lines` weight per em² of label.
    empty = [(w * 0.75, h * 0.2)]
    explicit = la.place(empty, ["x"], canvas=(w, h), background=svg, svg_classes=svg_classes(), cost_breakdown=True)
    preset = la.place(empty, ["x"], canvas=(w, h), background=svg, cost_breakdown=True)
    assert explicit.placements[0].raw["cost_breakdown"].get("lines", 0.0) < 0.2  # spines only
    box = preset.placements[0].box
    assert preset.placements[0].raw["cost_breakdown"]["lines"] == pytest.approx(box.w * box.h / 12 ** 2)


def test_figure_region_and_log_scale() -> None:
    rng = np.random.default_rng(4)
    x = 10 ** rng.uniform(0, 3, 50)
    y = rng.uniform(0, 1, 50)
    fig, ax = plt.subplots(figsize=(5, 4), dpi=80)
    ax.scatter(x, y, s=9)
    ax.set_xscale("log")
    out = label_points(ax, x, y, [f"v{i}" for i in range(50)], region="figure", max_labels=15)
    res = out.result
    assert res.problem["canvas"] == {"width": 400.0, "height": 320.0}
    assert res.stats["hard_violations"] == 0
    # texts sit next to their points in display space
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    disp = ax.transData.transform(np.column_stack([x, y]))
    by_text = {t.get_text(): t for t in out.texts}
    for p in res.placed:
        bb = by_text[p.lines[0]].get_window_extent(renderer)
        px, py = disp[int(p.id)]
        gap = max(bb.x0 - px, px - bb.x1, bb.y0 - py, py - bb.y1, 0.0)
        assert gap < 40, (p.id, gap)


def test_no_background_no_draw_and_removal() -> None:
    fig, ax, x, y = scatter(30)
    n_children = len(ax.get_children())
    out = label_points(ax, x, y, [f"s{i}" for i in range(30)], background=None, draw=False, measure=False)
    assert out.texts == [] and out.leaders == []
    assert len(ax.get_children()) == n_children
    assert "obstacles" not in out.result.problem or "raster" not in out.result.problem["obstacles"]
    drawn = label_points(ax, x, y, [f"s{i}" for i in range(30)])
    assert len(ax.get_children()) > n_children
    drawn.remove()
    assert len(ax.get_children()) == n_children


def test_non_finite_points_are_skipped() -> None:
    fig, ax = plt.subplots()
    x = np.array([0.0, np.nan, 1.0, 2.0])
    y = np.array([0.0, 1.0, np.inf, 2.0])
    ax.scatter(x, y)
    out = label_points(ax, x, y, ["a", "b", "c", "d"], ids=["A", "B", "C", "D"], attrs=[{"k": i} for i in range(4)])
    assert [p.id for p in out.result.placements] == ["A", "D"]
    assert [it["attrs"] for it in out.result.problem["items"]] == [{"k": 0}, {"k": 3}]


def test_dates_and_categories_use_the_axis_units() -> None:
    pd = pytest.importorskip("pandas")
    dates = pd.date_range("2024-01-01", periods=60, freq="D")
    fig, ax = plt.subplots()
    ax.plot(dates, np.sin(np.arange(60) / 6))
    picks = [10, 30, 50]
    out = label_points(ax, dates[picks], np.sin(np.asarray(picks) / 6), ["a", "b", "c"])
    assert len(out.result.placed) == 3
    for t, i in zip(out.texts, picks):  # each label next to its point
        tx, ty = t.get_position()
        assert abs(tx - matplotlib.dates.date2num(dates[i])) < 5
    fig, ax = plt.subplots()
    ax.scatter(["apples", "pears", "plums"], [3, 5, 2])
    out = label_points(ax, ["apples", "pears", "plums"], [3, 5, 2], ["a", "b", "c"])
    assert [p.anchor for p in out.result.placed] == [p.anchor for p in label_points(ax, [0, 1, 2], [3, 5, 2], ["a", "b", "c"], draw=False).result.placed]


def test_line_feeds_break_lines() -> None:
    fig, ax = plt.subplots()
    ax.scatter([1, 2], [1, 2])
    seen: List[str] = []
    measure = text_measure(fig)

    def spy(text: str, font: la.FontSpec) -> la.TextMetrics:
        seen.append(text)
        return measure(text, font)

    out = label_points(ax, [1, 2], [1, 2], ["Paris\n2.1M", "Rome"], measure=spy)
    assert sorted(t.get_text() for t in out.texts) == ["2.1M", "Paris", "Rome"]
    assert not any("\n" in t for t in seen)


def test_points_outside_the_canvas_warn() -> None:
    fig, ax = plt.subplots()
    ax.scatter([0, 1], [0, 1])
    with pytest.warns(UserWarning, match="none of the 2 points lies inside the axes"):
        out = label_points(ax, [100, 200], [100, 200], ["a", "b"])
    assert out.result.placed == []


def test_font_keys_of_text_kw_are_measured() -> None:
    fig, ax, x, y = scatter(20)
    out = label_points(ax, x, y, [f"label {i}" for i in range(20)], text_kw={"size": 12, "weight": "bold", "color": "C3"})
    fig.canvas.draw()
    for t, bb in zip(out.texts, extents(out.texts, fig)):
        p = next(q for q in out.result.placed if t.get_text() in q.lines)
        assert p.box is not None and p.text is not None
        assert t.get_fontsize() == pytest.approx(12 * p.text["scale"]) and t.get_color() == "C3"
        assert bb.width == pytest.approx(max(p.text["line_widths"]), abs=1.0)
    with pytest.raises(TypeError, match="fontsize is given twice"):
        label_points(ax, x, y, ["a"] * 20, fontsize=8, text_kw={"fontsize": 12})
    with pytest.raises(TypeError, match=r"text_kw\['rotation'\] would change the drawn labels"):
        label_points(ax, x, y, ["a"] * 20, text_kw={"rotation": 30})


def test_temporary_canvas_is_restored() -> None:
    from matplotlib.backends.backend_svg import FigureCanvasSVG
    from matplotlib.figure import Figure

    fig = Figure(figsize=(4, 3), dpi=100)
    canvas = FigureCanvasSVG(fig)
    ax = fig.add_subplot()
    ax.scatter([1, 2, 3], [1, 4, 9])
    out = label_points(ax, [1, 2, 3], [1, 4, 9], ["a", "b", "c"])
    assert fig.canvas is canvas
    assert len(out.result.placed) == 3


def test_text_measure_matches_matplotlib() -> None:
    fig, ax = plt.subplots(dpi=100)
    fig.canvas.draw()
    measure = text_measure(fig)
    m = measure("Hello", la.FontSpec("default", 400, False, 20.0))
    t = ax.text(0, 0, "Hello", fontsize=20 * 72 / 100)
    fig.canvas.draw()
    bb = t.get_window_extent()
    assert m.width == pytest.approx(bb.width, abs=1.0)
    assert m.ascent > m.descent > 0
    assert measure("", la.FontSpec("default", 400, False, 20.0)).width == 0.0


def test_shim_module() -> None:
    import label_anything.matplotlib as shim

    assert shim.label_points is label_points
    assert shim.svg_classes is svg_classes and shim.figure_background is figure_background
