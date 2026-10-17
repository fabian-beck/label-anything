"""The builder and the one-call API produce the expected problem dicts."""

from __future__ import annotations

import inspect
from typing import Any, Dict

import pytest

import label_anything as la
from label_anything.problem import ALL_OPTIONS, OPTION_PATHS, SECTIONS


def get_path(d: Dict[str, Any], path: str) -> Any:
    for k in path.split("."):
        d = d[k]
    return d


def test_excerpt_example_problem() -> None:
    anchors = [(100.0, 100.0), (104.0, 102.0), (300.0, 200.0)]
    res = la.place(
        anchors=anchors,
        labels=["Alpha", la.Icon(16, 16), la.Composite([la.Icon(12, 12), "Gamma"], gap=3)],
        canvas=(800, 600),
        font_size=11,
        avoid={"ink": 0.5, "outliers": "hard"},
        leaders=la.Leaders(style="angles", angles=range(0, 360, 45)),
        preset="scatter",
        attrs=[{"cbo": 3}, {"cbo": 10}, {"cbo": 7}],
        priority=la.Priority.outlierness(k=5) + 0.5 * la.Priority.attr("cbo", "log1p") - 0.2 * la.Priority.label_size(),
        omission="strict",
        max_labels=None,
    )
    assert res.problem == {
        "canvas": {"width": 800.0, "height": 600.0},
        "preset": "scatter",
        "defaults": {"font": {"size": 11}},
        "items": [
            {"anchor": {"type": "point", "x": 100.0, "y": 100.0}, "label": {"type": "text", "text": "Alpha"}, "attrs": {"cbo": 3}},
            {"anchor": {"type": "point", "x": 104.0, "y": 102.0}, "label": {"type": "icon", "width": 16, "height": 16}, "attrs": {"cbo": 10}},
            {
                "anchor": {"type": "point", "x": 300.0, "y": 200.0},
                "label": {"type": "composite", "gap": 3, "parts": [{"type": "icon", "width": 12, "height": 12}, {"type": "text", "text": "Gamma"}]},
                "attrs": {"cbo": 7},
            },
        ],
        "avoid": {"label": {"ink": 0.5, "outliers": "hard"}},
        "leaders": {"style": "angles", "angles": [0.0, 45.0, 90.0, 135.0, 180.0, 225.0, 270.0, 315.0]},
        "priority": {
            "omission": "strict",
            "terms": [
                {"builtin": "outlierness", "k": 5},
                {"attr": "cbo", "transform": "log1p", "weight": 0.5},
                {"builtin": "label_size", "weight": -0.2},
            ],
        },
    }
    assert res.stats["hard_violations"] == 0
    assert isinstance(res.omission_order, list)


def test_builder_fluent_api() -> None:
    p = (
        la.Problem(preset="map", seed=3)
        .canvas(400, 300, padding=2, region=(10, 10, 380, 280))
        .item((10, 20), "A", id="a", attrs={"pop": 3}, mark=la.Mark.rect(8, 4), priority=2.5, tier=1, required=True)
        .item(la.Area([(50, 50), (150, 50), (150, 120)]), la.Text("Lake", font=la.Font(weight="bold")), id="lake", group="water", keep_with=["a"])
        .items([(200, 200), (210, 205)], ["x", "y"], ids=["x", "y"], groups=["g", None], svg_ids=["node-x", None])
        .vector("roads", polylines=[[[0, 0], [400, 300]]], width=3)
        .avoid(roads=0.8, text="hard")
        .avoid_leader({"roads": 0.3})
        .avoid_buffer(items=0.5)
        .leaders("elbow", port="side-center", angles=(45, 135))
        .priority(la.Priority.attr("pop", "sqrt"))
        .tier("attrs.pop > 2", 2)
        .option("output.cost_breakdown", True)
        .set(max_labels=10, strategy="greedy", time_budget_ms=50, degrade=["wrap", "omit"], coverage=("attrs.region", 2))
    )
    assert len(p) == 4
    assert p.build() == {
        "canvas": {"width": 400.0, "height": 300.0, "padding": 2, "region": [10.0, 10.0, 380.0, 280.0]},
        "preset": "map",
        "items": [
            {
                "id": "a",
                "anchor": {"type": "point", "x": 10.0, "y": 20.0, "mark": {"shape": "rect", "w": 8, "h": 4}},
                "label": {"type": "text", "text": "A"},
                "attrs": {"pop": 3},
                "priority": 2.5,
                "tier": 1,
                "required": True,
            },
            {
                "id": "lake",
                "anchor": {"type": "area", "polygon": [[50.0, 50.0], [150.0, 50.0], [150.0, 120.0]]},
                "label": {"type": "text", "text": "Lake", "font": {"weight": "bold"}},
                "group": "water",
                "keep_with": ["a"],
            },
            {"id": "x", "anchor": {"type": "point", "x": 200.0, "y": 200.0}, "label": {"type": "text", "text": "x"}, "group": "g", "svg_id": "node-x"},
            {"id": "y", "anchor": {"type": "point", "x": 210.0, "y": 205.0}, "label": {"type": "text", "text": "y"}},
        ],
        "obstacles": {"vector": [{"class": "roads", "polylines": [[[0, 0], [400, 300]]], "width": 3}]},
        "avoid": {"label": {"roads": 0.8, "text": "hard"}, "leader": {"roads": 0.3}, "buffer": {"items": 0.5}},
        "leaders": {"style": "elbow", "port": "side-center", "angles": [45.0, 135.0]},
        "priority": {
            "terms": [{"attr": "pop", "transform": "sqrt"}],
            "tiers": [{"where": "attrs.pop > 2", "tier": 2}],
            "budget": {"max_labels": 10},
            "coverage": {"by": "attrs.region", "min_per_group": 2},
        },
        "solver": {"seed": 3, "strategy": "greedy", "time_budget_ms": 50},
        "degrade": ["wrap", "omit"],
        "output": {"cost_breakdown": True},
    }
    report = p.validate()
    assert report.valid, report.errors
    res = p.solve()
    assert res.stats["hard_violations"] == 0
    assert res["lake"].placed


def test_every_option_reaches_its_schema_path() -> None:
    samples: Dict[str, Any] = {
        "models": ["adjacent"], "position_order": "cartographic", "boundary": ["left"], "region": (0, 0, 10, 10),
        "focus": (1, 2), "transform": (1, 0, 0, 1, 0, 0), "coverage": "attrs.g", "degrade": ["omit"], "relaxable": ["ink"],
        "mark": {"shape": "circle", "r": 3}, "font_file": "font.ttf", "avoid_leader": {"ink": 0.1}, "avoid_buffer": {"items": 1.0},
        "font_classes": [{"first": "5%", "scale": 1.3, "weight": "bold"}],
    }
    for key, path in OPTION_PATHS.items():
        value = samples.get(key, 7)
        built = la.Problem(**{key: value}).build()
        got = get_path(built, path)
        assert got is not None, key
        if key not in samples:
            assert got == 7, key


def test_keywords_cover_the_schema(problem_schema: Dict[str, Any]) -> None:
    defs = problem_schema["$defs"]
    paths = set(OPTION_PATHS.values())
    covered = {
        # sections with their own keyword (whole objects, or special handling)
        "canvas.width", "canvas.height", "defaults.font", "defaults.wrap",
        "avoid.label", "priority.terms", "priority.tiers", "priority.budget",
    }
    for section in ("canvas", "placement", "solver", "degradeOptions", "output", "textOptions", "itemDefaults", "avoid", "priority"):
        key = {"degradeOptions": "degrade_options", "textOptions": "text", "itemDefaults": "defaults"}.get(section, section)
        for prop in defs[section]["properties"]:
            full = f"{key}.{prop}"
            assert full in paths or full in covered, f"no keyword for {full}"
    for prop in defs["priority"]["properties"]["budget"]["properties"]:
        assert f"priority.budget.{prop}" in paths
    for prop in defs["font"]["properties"]:
        assert f"defaults.font.{prop}" in paths or prop == "style" and "defaults.font.style" in paths
    # leaders: the Leaders helper has one field per schema property
    assert {f.name for f in la.Leaders.__dataclass_fields__.values()} == set(defs["leaders"]["properties"])
    # every top-level field is a keyword of place() (items come from anchors/labels)
    params = set(inspect.signature(la.place).parameters)
    for prop in problem_schema["properties"]:
        if prop in ("$schema", "items", "version"):
            continue
        assert prop in params or prop in OPTION_PATHS, f"place() has no keyword for {prop}"
    # and place() exposes every builder option
    assert ALL_OPTIONS - {"version"} <= params, ALL_OPTIONS - params
    assert set(SECTIONS) <= params


def test_specific_keywords_win_over_sections() -> None:
    built = la.Problem(solver={"seed": 1, "strategy": "local"}, seed=2).build()
    assert built["solver"] == {"seed": 2, "strategy": "local"}
    built = la.Problem(defaults={"font": {"size": 9, "family": "x"}}, font_size=14, font=la.Font(weight=700)).build()
    assert built["defaults"]["font"] == {"size": 14, "family": "x", "weight": 700}


def test_avoid_forms() -> None:
    flat = la.Problem(avoid={"ink": 0.5, "label": 2.0}).build()["avoid"]
    assert flat == {"label": {"ink": 0.5, "label": 2.0}}
    full = la.Problem(avoid={"label": {"ink": 1}, "leader": {"ink": 0.1}, "relaxable": ["ink"]}).build()["avoid"]
    assert full == {"label": {"ink": 1}, "leader": {"ink": 0.1}, "relaxable": ["ink"]}


def test_priority_forms() -> None:
    assert la.Problem(priority="cbo").build()["priority"] == {"terms": [{"attr": "cbo"}]}
    assert la.Problem(priority=[{"builtin": "crowding", "weight": -1}]).build()["priority"] == {"terms": [{"builtin": "crowding", "weight": -1}]}
    assert la.Problem(priority={"omission": "prefix"}).build()["priority"] == {"omission": "prefix"}
    res = la.place([(1, 1), (50, 50)], ["a", "b"], canvas=(100, 100), priority=[0.5, None], tiers=[None, 3])
    items = res.problem["items"]
    assert items[0]["priority"] == 0.5 and "priority" not in items[1]
    assert items[1]["tier"] == 3 and "tier" not in items[0]
    rules = la.place([(1, 1)], ["a"], canvas=(100, 100), tiers=[("attrs.x == 1", 2)]).problem["priority"]
    assert rules == {"tiers": [{"where": "attrs.x == 1", "tier": 2}]}


def test_per_item_options() -> None:
    res = la.place(
        [(10, 10), (40, 40), (70, 70)],
        ["a", "b", "c"],
        canvas=(100, 100),
        ids=["a", "b", "c"],
        attrs={"w": [1, 2, float("nan")]},
        marks=[3, None, la.Mark.ellipse(4, 2)],
        required={"b"},
        keep_with=[None, None, "set1"],
        item_placement=[{"models": ["adjacent"]}, None, None],
    )
    items = res.problem["items"]
    assert [it.get("attrs") for it in items] == [{"w": 1}, {"w": 2}, None]
    assert items[0]["anchor"]["mark"] == {"shape": "circle", "r": 3.0}
    assert "mark" not in items[1]["anchor"]
    assert items[2]["anchor"]["mark"] == {"shape": "ellipse", "rx": 4, "ry": 2}
    assert [it.get("required") for it in items] == [None, True, None]
    assert items[2]["keep_with"] == "set1"
    assert items[0]["placement"] == {"models": ["adjacent"]}
    bools = la.place([(10, 10), (40, 40)], ["a", "b"], canvas=(100, 100), required=[True, False]).problem["items"]
    assert [it.get("required") for it in bools] == [True, False]


def test_attrs_from_a_dataframe() -> None:
    pd = pytest.importorskip("pandas")
    df = pd.DataFrame({"pop": [1.5, None], "name": ["x", "y"]})
    items = la.Problem().items([(1, 1), (2, 2)], df["name"], attrs=df).build()["items"]
    assert items[0]["attrs"] == {"pop": 1.5, "name": "x"}
    assert items[1]["attrs"] == {"name": "y"}


def test_numpy_inputs() -> None:
    np = pytest.importorskip("numpy")
    pts = np.array([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    res = la.place(pts, np.array(["a", "b"]), canvas=(50, 50), attrs={"v": np.array([1, 2], dtype=np.int64)}, priority=np.array([0.1, 0.9]), seed=np.int64(5))
    items = res.problem["items"]
    assert items[0]["anchor"] == {"type": "point", "x": 1.0, "y": 2.0}
    assert items[1]["priority"] == pytest.approx(0.9)
    assert res.problem["solver"]["seed"] == 5


def test_label_helpers() -> None:
    assert la.Text("A", alternatives=["a"], wrap=(60, 2), truncate="end", padding="2px", align="center").to_dict() == {
        "type": "text", "text": "A", "alternatives": ["a"], "wrap": {"max_width": 60, "max_lines": 2},
        "truncate": "end", "padding": "2px", "align": "center",
    }
    assert la.Text("A", wrap=80).to_dict()["wrap"] == {"max_width": 80}
    assert la.Box(30, 10, shape="rounded:3").to_dict() == {"type": "box", "width": 30, "height": 10, "shape": "rounded:3"}
    assert la.Icon(8, 8, shape="polygon", polygon=[(0, 0), (8, 0), (4, 8)]).to_dict()["polygon"] == [[0.0, 0.0], [8.0, 0.0], [4.0, 8.0]]
    assert la.Font("Noto Sans", 11, 700, "italic", 1.3).to_dict() == {"family": "Noto Sans", "size": 11, "weight": 700, "style": "italic", "line_height": 1.3}
    assert la.Leaders(style="curved", min_length=4, width=1.5).to_dict() == {"style": "curved", "min_length": 4, "width": 1.5}
    assert la.Mark.icon(10, 12, tip=(5, 12)) == {"shape": "icon", "w": 10, "h": 12, "tip": [5.0, 12.0]}
    assert la.Mark.from_svg(svg_id="n1") == {"shape": "from_svg", "svg_id": "n1"}
    with pytest.raises(ValueError):
        la.Mark.from_svg()
    items = la.Problem().items([(0, 0)] * 3, ["s", {"text": "t", "font": {"size": 9}}, 42]).build()["items"]
    assert [it["label"] for it in items] == [
        {"type": "text", "text": "s"},
        {"type": "text", "text": "t", "font": {"size": 9}},
        {"type": "text", "text": "42"},
    ]


def test_priority_algebra() -> None:
    P = la.Priority
    a = P.outlierness(k=3) + 2 * P.attr("x") - P.label_size() / 4
    assert a.to_terms() == [
        {"builtin": "outlierness", "k": 3},
        {"attr": "x", "weight": 2.0},
        {"builtin": "label_size", "weight": -0.25},
    ]
    assert repr(a) == "Priority(outlierness(k=3) + 2*attr('x') - 0.25*label_size())"
    assert (-P.isolation()).to_terms() == [{"builtin": "isolation", "weight": -1.0}]
    assert P.expr("attrs.a * 2", "abs", normalize="minmax").to_terms() == [{"expr": "attrs.a * 2", "transform": "abs", "normalize": "minmax"}]
    assert (P.crowding() + P.degree()).normalized("none").to_terms() == [
        {"builtin": "crowding", "normalize": "none"},
        {"builtin": "degree", "normalize": "none"},
    ]
    assert P.mark_size() + P.centrality() + P.input_order() == P.mark_size() + P.centrality() + P.input_order()
    with pytest.raises(ValueError):
        P.attr("x", "log")
    with pytest.raises(TypeError):
        P.attr("x") + 1  # type: ignore[operator]


def test_warm_start_from_a_result() -> None:
    first = la.place([(50, 50), (60, 52)], ["one", "two"], canvas=(200, 200))
    again = la.place([(50, 50), (60, 52)], ["one", "two"], canvas=(200, 200), warm_start=first)
    assert again.problem["warm_start"]["placements"] == first.raw["placements"]
    assert [p.box for p in again.placements] == [p.box for p in first.placements]
    assert all(p.raw.get("displacement") == 0.0 for p in again.placed)


def test_builder_copy_is_independent() -> None:
    p = la.Problem(canvas=(10, 10)).item((1, 1), "a")
    q = p.copy().item((2, 2), "b").set(seed=4)
    assert len(p) == 1 and len(q) == 2
    assert "solver" not in p.build()
    assert repr(p) == "<Problem items=1 canvas=10×10>"
