#!/usr/bin/env python3
"""Generate the `place` conformance cases in conformance/place/ (format: conformance/README.md).

Every case is a small problem plus expected *properties* that any correct implementation
must satisfy (hard guarantees, forced outcomes, exact text layout), not one particular
solution. Usage: python3 tools/conformance/make_place_cases.py [--check]
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "conformance/place"

SAFE = {"hard_violations": 0, "leader_crossings": 0, "priority_inversions": 0, "deterministic": True}


def pt(id_, x, y, text, **extra):
    item = {"id": id_, "anchor": {"type": "point", "x": x, "y": y}, "label": {"type": "text", "text": text}}
    item.update(extra)
    return item


def case(name, problem, expect, comment=None):
    c = {"kind": "place", "name": name}
    if comment:
        c["$comment"] = comment
    c.update(problem if "problem_file" in problem else {"problem": problem})
    c["expect"] = {**SAFE, **expect}
    return c


CASES = {}

# --- positions -------------------------------------------------------------------------
CASES["single-point-top"] = case(
    "a lone point gets the first position of the perceptual order",
    {"canvas": {"width": 200, "height": 120}, "items": [pt("a", 100, 60, "Alpha")]},
    {"placed": 1, "anchor_side": {"a": "top"}, "model": {"a": "adjacent"}, "inside_canvas": True,
     "touch_gap_max": 0.5})

CASES["cartographic-order"] = case(
    "cartographic order starts at top-right",
    {"canvas": {"width": 200, "height": 120}, "placement": {"position_order": "cartographic"},
     "items": [pt("a", 100, 60, "Alpha")]},
    {"placed": 1, "anchor_side": {"a": "top-right"}, "inside_canvas": True})

CASES["explicit-order"] = case(
    "an explicit position order is followed when nothing is in the way",
    {"canvas": {"width": 200, "height": 120}, "placement": {"position_order": ["bottom", "top"]},
     "items": [pt("a", 100, 60, "Alpha")]},
    {"placed": 1, "anchor_side": {"a": "bottom"}})

CASES["canvas-edge"] = case(
    "labels stay inside the canvas (minus padding) next to its edges",
    {"canvas": {"width": 160, "height": 100, "padding": 4},
     "items": [pt("tl", 2, 2, "TopLeftCorner"), pt("br", 158, 98, "BottomRight"),
               pt("r", 158, 50, "RightEdge")]},
    {"placed": 3, "inside_canvas": True})

CASES["two-close-points"] = case(
    "two nearby points both get non-overlapping labels",
    {"canvas": {"width": 300, "height": 200}, "items": [pt("a", 120, 80, "Alpha"), pt("b", 126, 84, "Beta")]},
    {"placed": 2, "inside_canvas": True})

CASES["no-room"] = case(
    "a label larger than the canvas cannot be placed",
    {"canvas": {"width": 40, "height": 30},
     "items": [pt("long", 20, 15, "A label much wider than the whole canvas")]},
    {"placed": 0, "unplaced_ids": ["long"], "reasons": {"long": "no_feasible_candidate"}})

CASES["hard-obstacle"] = case(
    "a hard vector obstacle above the point pushes the label elsewhere",
    {"canvas": {"width": 200, "height": 140},
     "obstacles": {"vector": [{"class": "blocker", "rects": [[60, 20, 80, 45]]}]},
     "avoid": {"label": {"blocker": "hard"}},
     "items": [pt("a", 100, 70, "Alpha")]},
    {"placed": 1, "inside_canvas": True})

CASES["blocked-everywhere"] = case(
    "a point surrounded by hard obstacles is reported with its blocking reason",
    {"canvas": {"width": 200, "height": 140}, "placement": {"models": ["adjacent", "slider"]},
     "obstacles": {"vector": [{"class": "wall", "rects": [[0, 0, 200, 64], [0, 76, 200, 64],
                                                          [0, 64, 94, 12], [106, 64, 94, 12]]}]},
     "avoid": {"label": {"wall": "hard"}},
     "degrade": ["omit"],
     "items": [pt("a", 100, 70, "Alpha")]},
    {"placed": 0, "reasons": {"a": "no_feasible_candidate"}})

# --- priority and omission ------------------------------------------------------------
# one allowed position per item: co-located items compete for the same box
ONE_SLOT = {"models": ["adjacent"], "position_order": ["right"]}

CASES["priority-strict"] = case(
    "co-located items: the highest priority keeps its label, omissions lowest first",
    {"canvas": {"width": 200, "height": 60}, "placement": ONE_SLOT, "degrade": ["omit"],
     "items": [pt("low", 60, 30, "Low", priority=1.0), pt("high", 60, 30, "High", priority=3.0),
               pt("mid", 60, 30, "Mid", priority=2.0)]},
    {"placed": 1, "placed_ids": ["high"], "unplaced_ids": ["low", "mid"],
     "omission_order": ["low", "mid"], "reasons": {"low": "omitted_by_priority"}})

CASES["prefix-mode"] = case(
    "prefix omission: the placed set is a prefix of the priority order",
    {"problem_file": "../problems/priority-prefix.json"},
    {"prefix": True})

CASES["max-labels"] = case(
    "a label budget keeps the highest priorities",
    {"canvas": {"width": 600, "height": 200}, "priority": {"budget": {"max_labels": 2}},
     "items": [pt(f"i{k}", 60 + 110 * k, 100, f"Item {k}", priority=float(k)) for k in range(5)]},
    {"placed": 2, "placed_ids": ["i4", "i3"], "unplaced_ids": ["i0", "i1", "i2"],
     "reasons": {"i0": "omitted_by_priority"}})

CASES["required-first"] = case(
    "a required item outranks higher scores",
    {"canvas": {"width": 200, "height": 60}, "placement": ONE_SLOT, "degrade": ["omit"],
     "items": [pt("big", 60, 30, "Big", priority=100.0), pt("must", 60, 30, "Must", priority=0.0, required=True)]},
    {"placed": 1, "placed_ids": ["must"], "unplaced_ids": ["big"]})

CASES["tiers"] = case(
    "tiers outrank scores",
    {"canvas": {"width": 200, "height": 60}, "placement": ONE_SLOT, "degrade": ["omit"],
     "priority": {"tiers": [{"where": "attrs.capital", "tier": 1}]},
     "items": [pt("town", 60, 30, "Town", priority=50.0, attrs={"capital": False}),
               pt("capital", 60, 30, "Capital", priority=1.0, attrs={"capital": True})]},
    {"placed": 1, "placed_ids": ["capital"], "unplaced_ids": ["town"]})

CASES["keep-with-none"] = case(
    "a keep_with set is placed completely or not at all",
    {"canvas": {"width": 300, "height": 120},
     "obstacles": {"vector": [{"class": "wall", "rects": [[0, 0, 60, 120]]}]},
     "avoid": {"label": {"wall": "hard"}}, "placement": {"models": ["adjacent", "slider"]},
     "degrade": ["omit"],
     "items": [pt("a", 200, 60, "Free", keep_with="pair"),
               pt("b", 30, 60, "Walled in", keep_with="pair")]},
    {"placed": 0, "reasons": {"a": "keep_with", "b": "no_feasible_candidate"}})

CASES["group-fan"] = case(
    "near-duplicate anchors in a group share one label with fan leaders",
    {"canvas": {"width": 300, "height": 200},
     "items": [pt("g1", 150, 100, "Cluster", group="c"), pt("g2", 153, 101, "Cluster", group="c"),
               pt("g3", 151, 104, "Cluster", group="c")]},
    {"placed_min": 1, "reasons": {"g2": "grouped", "g3": "grouped"}})

# --- text layout -----------------------------------------------------------------------
CASES["wrap-class-name"] = case(
    "wrapping at the dots of a qualified name (bundled font, simple shaping)",
    {"canvas": {"width": 400, "height": 200},
     "items": [pt("c", 200, 100, "org.example.package.ClassName",
                  label={"type": "text", "text": "org.example.package.ClassName",
                         "wrap": {"max_width": 90, "max_lines": 3}})]},
    {"placed": 1, "text_lines": {"c": ["org.example.", "package.", "ClassName"]}})

CASES["truncate-middle"] = case(
    "middle truncation keeps both ends of the name",
    {"canvas": {"width": 400, "height": 200},
     "items": [pt("t", 200, 100, "x", label={"type": "text", "text": "org.example.package.ClassName",
                                                "wrap": {"max_width": 90, "max_lines": 1},
                                                "truncate": "middle"})]},
    {"placed": 1})

CASES["truncate-none-keeps-lines"] = case(
    "without truncation the text keeps max_lines and may exceed max_width",
    {"canvas": {"width": 400, "height": 200},
     "items": [pt("n", 200, 100, "x", label={"type": "text", "text": "aaa bbb ccc ddd",
                                                "wrap": {"max_width": 20, "max_lines": 2},
                                                "truncate": "none"})]},
    {"placed": 1, "text_lines": {"n": ["aaa bbb", "ccc ddd"]}})

# --- leaders and models ----------------------------------------------------------------
CASES["distant-when-crowded"] = case(
    "a point whose neighbourhood is hard-blocked gets a distant label with a leader",
    {"canvas": {"width": 300, "height": 200}, "placement": {"models": ["adjacent", "slider", "distant"]},
     "obstacles": {"vector": [{"class": "ring", "circles": [[150, 100, 40]]}]},
     "avoid": {"label": {"ring": "hard"}, "leader": {"ring": 0.5}},
     "items": [pt("a", 150, 100, "Alpha", label={"type": "text", "text": "Alpha"})]},
    {"placed": 1, "has_leader": {"a": True}, "model": {"a": "distant"}})

CASES["boundary-labels"] = case(
    "boundary model: labels in the margins with leaders",
    {"canvas": {"width": 400, "height": 240}, "placement": {"models": ["boundary"],
                                                            "boundary": {"sides": ["left", "right"]}},
     "leaders": {"style": "orthogonal"},
     "items": [pt(f"b{k}", 120 + 40 * k, 60 + 30 * k, f"B{k}") for k in range(4)]},
    {"placed": 4, "model": {"b0": "boundary"}, "has_leader": {"b0": True}, "inside_canvas": True})

CASES["area-internal"] = case(
    "an area anchor gets its label inside the polygon",
    {"canvas": {"width": 300, "height": 200},
     "items": [{"id": "lake", "anchor": {"type": "area", "polygon": [[60, 40], [240, 50], [250, 160], [50, 150]]},
                "label": {"type": "text", "text": "Lake"}}]},
    {"placed": 1, "model": {"lake": "internal"}})

CASES["leader-angles"] = case(
    "angle-restricted leaders on a crowded sample",
    {"problem_file": "../problems/leaders-angles.json"},
    {"placed_min": 8})

CASES["elbow-boundary"] = case(
    "elbow leaders to boundary labels",
    {"problem_file": "../problems/elbow-boundary.json"},
    {"placed_min": 8, "inside_canvas": True})

# --- backgrounds and coordinates ------------------------------------------------------
CASES["svg-background"] = case(
    "SVG background geometry is avoided",
    {"problem_file": "../problems/svg-background.json"},
    {"placed": 2})

CASES["raster-background"] = case(
    "raster background ink is avoided",
    {"problem_file": "../problems/raster-ink.json"},
    {"placed": 1})

CASES["y-up-transform"] = case(
    "y-up input coordinates",
    {"problem_file": "../problems/y-up-transform.json"},
    {"placed_min": 9, "inside_canvas": True})

CASES["many-points"] = case(
    "200 labels over dense points (deterministic)",
    {"problem_file": "../problems/many-points.json"},
    {"placed_min": 190})

CASES["region"] = case(
    "labels stay inside canvas.region",
    {"problem_file": "../problems/region.json"},
    {"placed_min": 9})

CASES["scatter-basic"] = case(
    "scatter preset over points and a trend line",
    {"problem_file": "../problems/scatter-basic.json"},
    {"placed": 20})

CASES["weighted-coverage"] = case(
    "weighted omission with coverage reservation",
    {"problem_file": "../problems/weighted-coverage.json"},
    {"placed_min": 36})

CASES["outliers-hard"] = case(
    "hard outlier class is never covered",
    {"problem_file": "../problems/outliers-hard.json"},
    {"placed": 12})


def main():
    check = "--check" in sys.argv
    OUT.mkdir(parents=True, exist_ok=True)
    stale = False
    for name, c in sorted(CASES.items()):
        p = OUT / f"{name}.json"
        text = json.dumps(c, indent=2, ensure_ascii=False) + "\n"
        if check:
            if not p.exists() or p.read_text() != text:
                print(f"stale: {p.relative_to(ROOT)}")
                stale = True
        else:
            p.write_text(text)
    names = {f"{n}.json" for n in CASES}
    for p in OUT.glob("*.json"):
        if p.name not in names:
            print(f"{'stale' if check else 'extra'}: {p.relative_to(ROOT)}")
            stale = stale or check
    if check and stale:
        sys.exit(1)
    if not check:
        print(f"wrote {len(CASES)} cases to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
