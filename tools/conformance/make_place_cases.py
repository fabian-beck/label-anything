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

# a row of long labels: from the third item on, the positions next to the mark are taken by
# the labels before it, so the prefix grows only through the ladder (wrapped and distant)
CASES["prefix-ladder"] = case(
    "prefix omission runs the degradation ladder before it cuts the order",
    {"canvas": {"width": 480, "height": 120}, "priority": {"omission": "prefix"},
     "items": [pt(f"t{k}", 40 + 36 * k, 60, f"Top item number {k}", priority=100.0 - k) for k in range(10)]},
    {"prefix": True, "placed_min": 5, "model": {"t2": "distant"}})

# low has only distant candidates, generated once high's label fills the canvas: every one is
# dropped while generated (spec §6.7) but statically fine, and counts for the explanation
CASES["explain-blocked-by-labels"] = case(
    "an item whose statically feasible candidates placed labels block is omitted_by_priority",
    {"canvas": {"width": 400, "height": 300},
     "items": [{"id": "high", "anchor": {"type": "point", "x": 10, "y": 10},
                "label": {"type": "box", "width": 370, "height": 270}, "priority": 2.0},
               pt("low", 388, 288, "Low", priority=1.0, placement={"models": ["distant"]})]},
    {"placed_ids": ["high"], "reasons": {"low": "omitted_by_priority"}})

# found by a search over random problems: before the priority repair (spec §10.3) the local
# search left one item omitted whose position only a label of lower priority occupied
CASES["strict-repair"] = case(
    "strict omission: no omitted item is blocked only by labels of lower priority",
    {"problem_file": "../problems/strict-repair.json"},
    {"placed_min": 50})

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

CASES["leader-baseline-port"] = case(
    "baseline port: the leader ends on the box side at an underline below the first line",
    {"canvas": {"width": 300, "height": 200}, "placement": {"models": ["adjacent", "slider", "distant"]},
     "leaders": {"port": "baseline"},
     "obstacles": {"vector": [{"class": "ring", "circles": [[150, 100, 40]]}]},
     "avoid": {"label": {"ring": "hard"}, "leader": {"ring": 0.5}},
     "items": [pt("a", 150, 100, "Alpha"), pt("b", 150, 95, "Beta")]},
    {"placed": 2, "has_leader": {"a": True, "b": True}, "underline": {"a": True, "b": True},
     "model": {"a": "distant", "b": "distant"}})

CASES["leader-baseline-elbow"] = case(
    "elbow leaders into the baseline port: horizontal last run into the underline",
    {"canvas": {"width": 300, "height": 200}, "placement": {"models": ["adjacent", "slider", "distant"]},
     "leaders": {"port": "baseline", "style": "elbow"},
     "obstacles": {"vector": [{"class": "ring", "circles": [[150, 100, 40]]}]},
     "avoid": {"label": {"ring": "hard"}, "leader": {"ring": 0.5}},
     "items": [pt("a", 150, 100, "Alpha"), pt("b", 150, 95, "Beta")]},
    {"placed": 2, "has_leader": {"a": True, "b": True}, "underline": {"a": True, "b": True}})

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

# leaders keep their clearance from the other marks of the cluster (spec §7)
CASES["leader-angles"] = case(
    "angle-restricted leaders on a crowded sample",
    {"problem_file": "../problems/leaders-angles.json"},
    {"placed_min": 6})

CASES["elbow-boundary"] = case(
    "elbow leaders to boundary labels",
    {"problem_file": "../problems/elbow-boundary.json"},
    {"placed_min": 8, "inside_canvas": True})

# --- backgrounds and coordinates ------------------------------------------------------
CASES["svg-background"] = case(
    "SVG background geometry is avoided",
    {"problem_file": "../problems/svg-background.json"},
    {"placed": 2})

CASES["svg-text-box"] = case(
    "SVG text boxes span the bundled font's ascender and descender",
    {"canvas": {"width": 200, "height": 120}, "items": [pt("a", 100, 70, "Alpha")],
     "obstacles": {"svg": {
         "source": '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120">'
                   '<text x="100" y="36.056" font-size="40" text-anchor="middle">MMMM</text></svg>',
         "classes": [{"selector": "text", "class": "text"}]}}},
    {"placed": 1, "anchor_side": {"a": "right"}, "inside_canvas": True},
    "The top position (box top at y = 46.056) is free of the text's box only if the box ends 0.2 em "
    "below the baseline (44.056); with the descender of the bundled font (0.293 em, 47.776) it is "
    "blocked and the label goes right.")

CASES["distant-keeps-sides"] = case(
    "distant labels keep to the sides of an explicit position order",
    {"canvas": {"width": 400, "height": 160}, "placement": {"position_order": ["right"]},
     "avoid": {"label": {"wall": "hard", "box": "hard"}, "leader": {"wall": "hard"}},
     "obstacles": {"vector": [{"class": "wall", "rects": [[103, 0, 297, 80]]},
                              {"class": "box", "rects": [[103, 105, 60, 30]]}]},
     "items": [pt("a", 100, 40, "Alpha"), pt("b", 100, 120, "Beta")]},
    {"placed": 1, "unplaced_ids": ["a"], "reasons": {"a": "no_feasible_candidate"},
     "model": {"b": "distant"}, "has_leader": {"b": True},
     "box": {"b": {"x": 143.884, "y": 81.879, "w": 29.232, "h": 19.944, "tol": 0.01}}},
    "Both items allow only `right`. Left of them everything is free, but distant labels keep to "
    "directions within 22.5° of the listed positions: a, walled in on the right for labels and "
    "leaders, is omitted; b goes up-right, its leader over the soft-for-leaders box.")

CASES["fan-line-ends"] = case(
    "fan labels: crowded line ends get a column of labels with fanning leaders",
    {"canvas": {"width": 320, "height": 200}, "placement": {"position_order": ["right"]},
     "items": [pt(n.lower(), 150, 88 + 5 * k, n)
               for k, n in enumerate(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])]},
    {"placed": 6, "inside_canvas": True,
     "model": {k: "fan" for k in ("alpha", "beta", "gamma", "delta", "epsilon", "zeta")},
     "anchor_side": {k: "fan" for k in ("alpha", "beta", "gamma", "delta", "epsilon", "zeta")},
     "has_leader": {k: True for k in ("alpha", "beta", "gamma", "delta", "epsilon", "zeta")}},
    "Six ends 5 px apart that allow only `right`: beside them there is room for two labels, the "
    "others are left without one by the search. The crowd's column (placement.fan = auto, the "
    "default) takes all six, the two placed labels in its way included, stacked in the order of "
    "the ends (spec §6.8).")

CASES["fan-always"] = case(
    "fan labels with placement.fan = always: a crowd's labels move into a column",
    {"canvas": {"width": 240, "height": 140}, "placement": {"fan": "always"},
     "items": [pt("a", 100, 70, "Alpha"), pt("b", 104, 76, "Beta")]},
    {"placed": 2, "model": {"a": "fan", "b": "fan"}, "has_leader": {"a": True, "b": True},
     "box": {"a": {"x": 124.0, "y": 52.056, "w": 35.892, "h": 19.944, "tol": 0.01},
             "b": {"x": 124.0, "y": 74.0, "w": 29.232, "h": 19.944, "tol": 0.01}}},
    "Both points get adjacent labels (top and bottom; their centers count as right of the "
    "anchors). With `always` the crowd's column takes them: right of the marks' boxes "
    "(x1 = 106) by the least run of 1.5 em (18 px), stacked around the anchors' heights with "
    "the boundary gap (2 px): centers 62.028 and 83.972.")

CASES["fan-max-labels"] = case(
    "fan labels keep to the label budget",
    {"canvas": {"width": 320, "height": 200}, "placement": {"position_order": ["right"]},
     "priority": {"budget": {"max_labels": 4}},
     "items": [pt(n.lower(), 150, 88 + 5 * k, n)
               for k, n in enumerate(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])]},
    {"placed": 4, "unplaced_ids": ["delta", "zeta"],
     "model": {k: "fan" for k in ("alpha", "beta", "gamma", "epsilon")}},
    "The ends of `fan-line-ends` with at most 4 labels: the column gives labels to the two "
    "most important ends left without one (input order) and leaves the others out.")

CASES["font-classes"] = case(
    "font classes scale labels by priority",
    {"canvas": {"width": 480, "height": 200}, "defaults": {"font": {"size": 10}},
     "placement": {"position_order": ["right"], "offset": "0.5em"},
     "priority": {"terms": [{"attr": "pop"}],
                  "font_classes": [{"first": 1, "scale": 1.5, "weight": "bold"},
                                   {"first": "50%", "scale": 1.2}, {"scale": 0.9}]},
     "items": [pt(k, 40 + 100 * i, 100, "Aa", attrs={"pop": 40 - 10 * i}) for i, k in enumerate("abcd")]},
    {"placed": 4,
     "font": {"a": {"size": 15, "weight": 700, "class": 0}, "b": {"size": 12, "weight": 400, "class": 1},
              "c": {"size": 9, "weight": 400, "class": 2}, "d": {"size": 9, "class": 2}},
     "box": {"a": {"x": 49.5, "y": 87.535, "w": 23.865, "h": 24.93},
             "b": {"x": 148.0, "y": 90.028, "w": 18.0, "h": 19.944},
             "c": {"x": 246.5, "y": 92.521, "w": 13.5, "h": 14.958}}},
    "Four items ranked by `pop`: the first class takes rank 0 (bold, 1.5 × 10 px), the second "
    "ends at ceil(50 % × 4) = 2 and takes rank 1 (1.2 ×), the last the rest (0.9 ×). The offset "
    "(0.5 em) and the padding (0.15 em) follow each label's font size: the label of a starts at "
    "40 + 2 (mark) + 7.5, of b at 140 + 2 + 6, of c at 240 + 2 + 4.5; regular 'Aa' is 1.2 em wide "
    "and 1.362 em high, plus twice the padding.")

CASES["font-class-shrink-floor"] = case(
    "the shrink step stops at min_scale of the size before a smaller font class",
    {"canvas": {"width": 54, "height": 60, "padding": 0}, "defaults": {"font": {"size": 10}},
     "degrade": ["shrink:0.85", "omit"], "placement": {"models": ["adjacent"], "position_order": ["right"]},
     "priority": {"font_classes": [{"first": 1, "scale": 1}, {"scale": 0.9}]},
     "items": [pt("a", 10, 15, "Abcdefghij", priority=2), pt("b", 10, 45, "Abcdefghij", priority=1)]},
    {"placed": 1, "placed_ids": ["a"], "unplaced_ids": ["b"], "reasons": {"b": "no_feasible_candidate"},
     "font": {"a": {"size": 7.225, "class": 0}, "b": {"class": 1}}},
    "The text fits the canvas only at 0.7225 of 10 px (0.85², the last shrink factor above "
    "min_scale 0.7): a, in a class of scale 1, gets it; b's class (0.9) keeps it at or above "
    "0.7 × 10 px, i.e. factors down to 0.7 / 0.9 = 0.778: 0.85 × 9 px is too wide.")

# --- warm starts -------------------------------------------------------------------------
CASES["warm-start-follows-anchor"] = case(
    "a previous box that comes with its anchor moves with the item",
    {"canvas": {"width": 240, "height": 160},
     "items": [pt("a", 150, 100, "Alpha")],
     "warm_start": {"placements": [
         {"id": "a", "placed": True, "anchor": [100, 80],
          "box": {"x": 104, "y": 70.028, "w": 35.892, "h": 19.944}}]}},
    {"placed": 1, "anchor_side": {"a": "right"}, "model": {"a": "slider"},
     "box": {"a": {"x": 154, "y": 90.028, "w": 35.892, "h": 19.944, "tol": 0.01}}},
    "The previous result placed Alpha right of its point at (100, 80); the point is now at "
    "(150, 100), and the box moves by the same (50, 20): it stays right of the point (top "
    "would be first otherwise). Without the shift the old box, 50 px away, would be "
    "kept as a distant label.")

CASES["warm-start-degraded"] = case(
    "a label shrunk in the previous solve keeps its box instead of running the ladder again",
    {"canvas": {"width": 240, "height": 180},
     "placement": {"models": ["adjacent", "slider"]},
     "obstacles": {"vector": [{"class": "walls", "rects": [
         [60, 60, 34, 80], [94, 60, 24, 28], [94, 112, 60, 28], [138, 88, 16, 24]]}]},
     "avoid": {"label": {"walls": "hard"}, "leader": {"walls": "hard"}},
     "items": [pt("a", 100, 100, "Alpha")],
     "warm_start": {"placements": [
         {"id": "a", "placed": True, "anchor": [100, 100],
          "box": {"x": 104, "y": 91.524, "w": 30.508, "h": 16.952}}]}},
    {"placed": 1, "anchor_side": {"a": "right"}, "model": {"a": "slider"},
     "font": {"a": {"size": 10.2}},
     "box": {"a": {"x": 104, "y": 91.524, "w": 30.508, "h": 16.952, "tol": 0.01}}},
    "Walls (hard for labels and leaders) leave a pocket around the point: the full-size "
    "label fits nowhere next to it, the label shrunk to 0.85 (the box in warm_start) fits "
    "on its right. An opening in the top wall lets the ladder's distant step place the "
    "full-size label with a leader, but the previous, shrunk box is still free and is "
    "kept (ADR 0025).")

CASES["warm-start-nudge"] = case(
    "a previous box that an obstacle now clips slides along the mark instead of jumping",
    {"canvas": {"width": 200, "height": 140},
     "obstacles": {"vector": [{"class": "blocker", "rects": [[70, 50, 12.554, 20]]}]},
     "avoid": {"label": {"blocker": "hard"}},
     "items": [pt("a", 100, 80, "Alpha")],
     "warm_start": {"placements": [
         {"id": "a", "placed": True, "anchor": [100, 80],
          "box": {"x": 82.054, "y": 56.056, "w": 35.892, "h": 19.944}}]}},
    {"placed": 1, "anchor_side": {"a": "top"}, "model": {"a": "slider"},
     "box": {"a": {"x": 82.654, "y": 56.056, "w": 35.892, "h": 19.944, "tol": 0.01}}},
    "The previous result placed Alpha above its point; a hard obstacle now covers the "
    "box's left 0.5 px. The box slides 0.05 em (0.6 px, the smallest nudge) to the right "
    "along the top of the mark; the nearest slider candidate would be 4.2 px away.")

CASES["warm-start-keeps-leader"] = case(
    "a previous leadered label keeps its leader, moved with the anchor",
    {"canvas": {"width": 240, "height": 180},
     "placement": {"models": ["adjacent", "slider", "distant"]},
     "leaders": {"style": "angles"},
     "obstacles": {"vector": [{"class": "walls", "rects": [
         [90, 70, 60, 24], [90, 106, 60, 24], [90, 94, 24, 12], [126, 94, 24, 12]]}]},
     "avoid": {"label": {"walls": "hard"}, "leader": {"walls": "ignore"}},
     "items": [pt("a", 120, 100, "Alpha")],
     "warm_start": {"placements": [
         {"id": "a", "placed": True, "anchor": [110, 95],
          "box": {"x": 147.83, "y": 37.226, "w": 35.892, "h": 19.944},
          "leader": {"points": [[112.475, 92.525], [147.83, 57.17]], "style": "angles",
                     "port": [147.83, 57.17]}}]}},
    {"placed": 1, "model": {"a": "distant"}, "has_leader": {"a": True},
     "box": {"a": {"x": 157.83, "y": 42.226, "w": 35.892, "h": 19.944, "tol": 0.01}}},
    "Walls that labels may not overlap (leaders may cross them) surround the point, so "
    "its label needs a leader. The previous result had a 50 px leader at 45°, between "
    "the distant rings (44 and 70 px from the leader start); the point moved by (10, 5) "
    "and the label keeps that leader, moved by the same: the box is the previous one "
    "moved, which no ring candidate reproduces.")

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
