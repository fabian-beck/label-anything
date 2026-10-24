#!/usr/bin/env python3
"""Generate the `place` conformance cases in conformance/place/ (format: conformance/README.md).

Every case is a small problem plus expected *properties* that any correct implementation
must satisfy (hard guarantees, forced outcomes, exact text layout), not one particular
solution. Usage: python3 tools/conformance/make_place_cases.py [--check]
"""
import base64
import json
import math
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

# t1's name is wider than the canvas and fits only wrapped (the ladder's wrap step): without
# the ladder the prefix would end at t1, and t2, which fits, would go without a label
CASES["prefix-ladder"] = case(
    "prefix omission runs the degradation ladder before it cuts the order",
    {"canvas": {"width": 120, "height": 160}, "priority": {"omission": "prefix"},
     "items": [pt("t0", 60, 30, "Alpha", priority=3.0),
               pt("t1", 60, 80, "Federal Republic of Germany", priority=2.0),
               pt("t2", 60, 130, "Gamma", priority=1.0)]},
    {"prefix": True, "placed": 3, "text_lines": {"t1": ["Federal Republic", "of Germany"]}})

# low has only distant candidates, generated once high's label fills the canvas: every one is
# dropped while generated (spec §6.7) but statically fine, and counts for the explanation (the
# strips beside high's label, 8.3 px wide, are too narrow even for low's shrunk label)
CASES["explain-blocked-by-labels"] = case(
    "an item whose statically feasible candidates placed labels block is omitted_by_priority",
    {"canvas": {"width": 396, "height": 296},
     "items": [{"id": "high", "anchor": {"type": "point", "x": 10, "y": 10},
                "label": {"type": "box", "width": 368, "height": 268}, "priority": 2.0},
               pt("low", 388, 288, "Low", priority=1.0, placement={"models": ["distant"]})]},
    {"placed_ids": ["high"], "reasons": {"low": "omitted_by_priority"}})

# found by a search over random problems: before the priority repair (spec §10.3) the local
# search left one item omitted whose position only a label of lower priority occupied
CASES["strict-repair"] = case(
    "strict omission: no omitted item is blocked only by labels of lower priority",
    {"problem_file": "../problems/strict-repair.json"},
    {"placed_min": 50})

# the hub's only position covers the mark of a minor item: by default the mark blocks it; with
# lower_items soft the hub is labeled and the minor item, whose top position is free, is not
LOWER = {"canvas": {"width": 200, "height": 80}, "placement": ONE_SLOT, "degrade": ["omit"],
         "items": [pt("hub", 60, 50, "Hub", priority=2.0),
                   {**pt("minor", 85, 50, "Minor", priority=1.0, placement={"position_order": ["top"]}),
                    "anchor": {"type": "point", "x": 85, "y": 50, "mark": {"shape": "circle", "r": 12}}}]}
CASES["lower-items-default"] = case(
    "by default a label avoids the marks of less important items",
    LOWER, {"placed": 1, "placed_ids": ["minor"], "unplaced_ids": ["hub"], "reasons": {"hub": "no_feasible_candidate"}})
CASES["lower-items-cover"] = case(
    "with lower_items soft a label covers the mark of a less important item, which stays unlabeled",
    {**LOWER, "avoid": {"label": {"lower_items": 2.0}}},
    {"placed": 1, "placed_ids": ["hub"], "unplaced_ids": ["minor"], "reasons": {"minor": "omitted_by_priority"}})

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

CASES["hard-line-breaks"] = case(
    "a line feed breaks the line; the given lines are never rewrapped (CRLF too)",
    {"canvas": {"width": 400, "height": 200},
     "items": [pt("p", 100, 100, "Paris\n2.1M"), pt("c", 300, 100, "Line one\r\nLine two")]},
    {"placed": 2, "text_lines": {"p": ["Paris", "2.1M"], "c": ["Line one", "Line two"]}})

CASES["wrap-no-short-lines"] = case(
    "the wrap step never strands a line narrower than 1.5 em (France / 3)",
    {"canvas": {"width": 50, "height": 200}, "degrade": ["wrap", "omit"],
     "items": [pt("sa", 25, 50, "Saudi Arabia"), pt("fr", 25, 150, "France 3")]},
    {"placed": 1, "text_lines": {"sa": ["Saudi", "Arabia"]}, "reasons": {"fr": "no_feasible_candidate"}})

# --- shapes ------------------------------------------------------------------------------
_RING = [[30, 130], [180, 130], [180, 300], [30, 300]]
_HOLE = [[50, 150], [160, 150], [160, 280], [50, 280]]
CASES["area-hole-either-winding"] = case(
    "a hole wound like its outer ring is still a hole: both areas label the same band",
    {"canvas": {"width": 500, "height": 400},
     "items": [{"id": "same", "anchor": {"type": "area", "polygon": [[x + 300, y] for x, y in _RING],
                                         "holes": [[[x + 300, y] for x, y in _HOLE]]},
                "label": {"type": "text", "text": "Holey"}},
               {"id": "opp", "anchor": {"type": "area", "polygon": _RING, "holes": [_HOLE[::-1]]},
                "label": {"type": "text", "text": "Holey"}}]},
    {"placed": 2, "model": {"same": "adjacent", "opp": "adjacent"},
     "box": {"same": {"x": 323.97075, "y": 123.11875, "w": 35.496, "h": 15.6, "tol": 0.01},
             "opp": {"x": 23.97075, "y": 123.11875, "w": 35.496, "h": 15.6, "tol": 0.01}}})

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

CASES["orthogonal-boundary-one-bend"] = case(
    "orthogonal leaders to boundary labels bend once: along the side, then into the label",
    {"canvas": {"width": 400, "height": 240}, "placement": {"models": ["boundary"],
                                                            "boundary": {"sides": ["left", "right"]}},
     "leaders": {"style": "orthogonal"},
     "items": [pt(f"o{k}", 170 + 12 * k, 104 + 6 * k, f"Item {k}") for k in range(6)]},
    {"placed": 6, "model": {f"o{k}": "boundary" for k in range(6)},
     "has_leader": {f"o{k}": True for k in range(6)}, "max_bends": 1, "inside_canvas": True},
    "Six anchors 6 px apart: their labels stack in the margins away from the anchors' heights, so "
    "the leaders bend. An orthogonal leader to a boundary label runs parallel to the side to the "
    "label's height, then straight into the label (po, spec §7) — the one-bend shape that "
    "Barth et al. (2019) found the best compromise between reading performance and preference.")

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

_GREEK = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta", "Eta", "Theta", "Iota", "Kappa"]
CASES["boundary-column"] = case(
    "boundary labels for crowded line ends: one column, aligned toward the picture",
    {"canvas": {"width": 320, "height": 240},
     "placement": {"models": ["adjacent", "boundary"], "position_order": ["right"], "fan": "off",
                   "boundary": {"sides": ["right"]}},
     "items": [pt(n.lower(), 150, 100 + 3 * k, n) for k, n in enumerate(_GREEK)]},
    {"placed": 10, "inside_canvas": True,
     "model": {n.lower(): "boundary" for n in _GREEK},
     "has_leader": {n.lower(): True for n in _GREEK},
     "box": {"alpha": {"x": 263.76, "y": 35.567, "w": 35.892, "h": 15.6, "tol": 0.01},
             "kappa": {"x": 263.76, "y": 175.607, "w": 39.252, "h": 15.048, "tol": 0.01}}},
    "Ten ends 3 px apart that allow only `right`; no fans. Next to the ends a label would come "
    "closer to the other ends' marks than the label margin, even shrunk, and boundary labels at "
    "their ends' heights leave no room for each other. The right side's column takes all ten (spec §6.6): stacked around the ends' heights, "
    "matched to the slots by leader length and left-aligned on one line, x = 320 − 4 (canvas "
    "padding) − 4 (boundary margin) − 48.24 (Gamma, the widest label) = 263.76; its leaders leave "
    "the crowd past the neighbouring marks, which they only must not cross.")

CASES["boundary-column-full-size"] = case(
    "a label the search shrank takes its full size in a boundary column",
    {"canvas": {"width": 320, "height": 240},
     "placement": {"models": ["adjacent", "boundary"], "position_order": ["right"], "fan": "off",
                   "boundary": {"sides": ["right"]}},
     "items": [pt(n.lower(), 150, 100 + 4 * k, n) for k, n in enumerate(_GREEK)]},
    {"placed": 10, "model": {n.lower(): "boundary" for n in _GREEK},
     "font": {n.lower(): {"size": 12} for n in _GREEK}},
    "The ends of `boundary-column` 4 px apart: the search labels iota beside its end, shrunk "
    "to 0.7225 (8.67 px; the ends 8 px away keep the label margin from so low a box). The "
    "column takes it with the others at its full size, 12 px (spec §6.6).")

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
                   '<text x="100" y="41.4" font-size="40" text-anchor="middle">MMMM</text></svg>',
         "classes": [{"selector": "text", "class": "text"}]}}},
    {"placed": 1, "anchor_side": {"a": "right"}, "inside_canvas": True},
    "The top position (box top at y = 51.4: the label box fits the ink of `Alpha`) is free of "
    "the text's box only if the box ends 0.2 em below the baseline (49.4); with the descender of "
    "the bundled font (0.293 em, 53.12) it is blocked and the label goes right.")

CASES["distant-keeps-sides"] = case(
    "distant labels keep to the sides of an explicit position order",
    {"canvas": {"width": 400, "height": 160}, "placement": {"position_order": ["right"]},
     "avoid": {"label": {"wall": "hard", "box": "hard"}, "leader": {"wall": "hard"}},
     "obstacles": {"vector": [{"class": "wall", "rects": [[103, 0, 297, 80]]},
                              {"class": "box", "rects": [[103, 105, 60, 30]]}]},
     "items": [pt("a", 100, 40, "Alpha"), pt("b", 100, 120, "Beta")]},
    {"placed": 1, "unplaced_ids": ["a"], "reasons": {"a": "no_feasible_candidate"},
     "model": {"b": "distant"}, "has_leader": {"b": True},
     "box": {"b": {"x": 143.884, "y": 89.535, "w": 29.232, "h": 12.288, "tol": 0.01}}},
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
    "Six ends 5 px apart that allow only `right`: the search labels three of them (beta and "
    "zeta beside their ends, alpha with a leader) and leaves the others without one. The crowd's "
    "column (placement.fan = auto, the default) takes all six, the three placed labels in its "
    "way included, stacked in the order of the ends (spec §6.8).")

CASES["fan-always"] = case(
    "fan labels with placement.fan = always: a crowd's labels move into a column",
    {"canvas": {"width": 240, "height": 140}, "placement": {"fan": "always"},
     "items": [pt("a", 100, 70, "Alpha"), pt("b", 104, 76, "Beta")]},
    {"placed": 2, "model": {"a": "fan", "b": "fan"}, "has_leader": {"a": True, "b": True},
     "box": {"a": {"x": 124.0, "y": 57.028, "w": 35.892, "h": 15.6, "tol": 0.01},
             "b": {"x": 124.0, "y": 75.028, "w": 29.232, "h": 12.288, "tol": 0.01}}},
    "Both points get adjacent labels (top and bottom; their centers count as right of the "
    "anchors). With `always` the crowd's column takes them: right of the marks' boxes "
    "(x1 = 106) by the least run of 1.5 em (18 px), stacked around the anchors' heights with "
    "the labels' margin (0.2 em = 2.4 px, more than the boundary gap of 2 px): centers 64.828 "
    "and 81.172.")

CASES["fan-max-labels"] = case(
    "fan labels keep to the label budget",
    {"canvas": {"width": 320, "height": 200}, "placement": {"position_order": ["right"]},
     "priority": {"budget": {"max_labels": 4}},
     "items": [pt(n.lower(), 150, 88 + 3 * k, n)
               for k, n in enumerate(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])]},
    {"placed": 4, "unplaced_ids": ["epsilon", "zeta"],
     "model": {k: "fan" for k in ("alpha", "beta", "gamma", "delta")}},
    "The ends of `fan-line-ends`, 3 px apart, with at most 4 labels: the search labels none of "
    "them (beside the ends a label would come closer to other ends than the label margin, and "
    "no leader leaves the crowd with its clearance); the column, which keeps to the budget, "
    "gives labels to the four most important ends (alpha to delta, in input order) and leaves "
    "the others out.")

CASES["fan-full-size"] = case(
    "labels the search shrank take their full size in a fan column",
    {"canvas": {"width": 320, "height": 200}, "placement": {"position_order": ["right"]},
     "items": [pt(n.lower(), 150, 88 + 4 * k, n)
               for k, n in enumerate(["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"])]},
    {"placed": 6, "model": {k: "fan" for k in ("alpha", "beta", "gamma", "delta", "epsilon", "zeta")},
     "font": {k: {"size": 12} for k in ("alpha", "beta", "gamma", "delta", "epsilon", "zeta")}},
    "The ends of `fan-line-ends` 4 px apart: the search labels beta and zeta beside their ends, "
    "shrunk to 0.7225 (8.67 px), and no other. The crowd's column takes all six, the two "
    "shrunk labels at their full size, 12 px, like the others (spec §6.8).")

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
     "box": {"a": {"x": 49.5, "y": 92.2975, "w": 23.865, "h": 15.405},
             "b": {"x": 148.0, "y": 93.838, "w": 18.0, "h": 12.324},
             "c": {"x": 246.5, "y": 95.3785, "w": 13.5, "h": 9.243}}},
    "Four items ranked by `pop`: the first class takes rank 0 (bold, 1.5 × 10 px), the second "
    "ends at ceil(50 % × 4) = 2 and takes rank 1 (1.2 ×), the last the rest (0.9 ×). The offset "
    "(0.5 em) and the padding (0.15 em) follow each label's font size: the label of a starts at "
    "40 + 2 (mark) + 7.5, of b at 140 + 2 + 6, of c at 240 + 2 + 4.5; 'Aa' is 1.2 em wide "
    "(regular) and 0.727 em high (the ink from the top of A to the bottom of a), plus twice the "
    "padding.")

CASES["font-class-shrink-floor"] = case(
    "the shrink step stops at min_scale of the size before a smaller font class",
    {"canvas": {"width": 53, "height": 60, "padding": 0}, "defaults": {"font": {"size": 10}},
     "degrade": ["shrink:0.85", "omit"], "placement": {"models": ["adjacent"], "position_order": ["right"]},
     "priority": {"font_classes": [{"first": 1, "scale": 1}, {"scale": 0.9}]},
     "items": [pt("a", 10, 15, "Abcdefghij", priority=2), pt("b", 10, 45, "Abcdefghij", priority=1)]},
    {"placed": 1, "placed_ids": ["a"], "unplaced_ids": ["b"], "reasons": {"b": "no_feasible_candidate"},
     "font": {"a": {"size": 7.225, "class": 0}, "b": {"class": 1}}},
    "The text fits the canvas only at 0.7225 of 10 px (0.85², the last shrink factor above "
    "min_scale 0.7): a, in a class of scale 1, gets it; b's class (0.9) keeps it at or above "
    "0.7 × 10 px, i.e. factors down to 0.7 / 0.9 = 0.778: 0.85 × 9 px is too wide.")

# --- own mark nearest, stubs -------------------------------------------------------------
# Beta's mark overlaps Alpha's, so the label margin does not keep it from Alpha's label; above
# its mark (Alpha's only position) the label would be 0.5 px from Beta's mark but 1 px from
# its own.
NEAREST = {"canvas": {"width": 200, "height": 120}, "degrade": ["omit"],
           "items": [pt("a", 100, 60, "Alpha", priority=2,
                        placement={"models": ["adjacent"], "position_order": ["top"]}),
                     pt("b", 103.5, 59.5, "Beta", priority=1,
                        placement={"models": ["adjacent"], "position_order": ["right"]})]}
CASES["own-nearest"] = case(
    "a label comes no closer to another item's mark than to its own",
    NEAREST,
    {"placed_ids": ["b"], "unplaced_ids": ["a"], "reasons": {"a": "no_feasible_candidate"},
     "own_nearest": True})
CASES["own-nearest-off"] = case(
    "without own_nearest a label may come closer to another item's mark than to its own",
    {**NEAREST, "placement": {"own_nearest": False}},
    {"placed_ids": ["a"], "anchor_side": {"a": "top"}})

# Alpha may only stand right of its point; Beta's point, 16 px below it, comes within the
# stub reach (0.75 em = 9 px) of that place: Alpha stands 0.5 em farther right, joined to its
# mark by a horizontal stub to the middle of its left side, and Beta's mark is still farther
# from it than Alpha's. Gamma's point has no other mark near: its label touches its mark.
STUBS = {"canvas": {"width": 240, "height": 160}, "placement": {"stubs": "auto"},
         "items": [pt("a", 100, 100, "Alpha", priority=3,
                      placement={"models": ["adjacent"], "position_order": ["right"]}),
                   pt("b", 100, 116, "Beta", priority=2), pt("g", 60, 40, "Gamma", priority=1)]}
CASES["stubs-near-other-marks"] = case(
    "a label that another mark comes near stands farther out with a stub; others touch their mark",
    STUBS,
    {"placed": 3, "anchor_side": {"a": "right"}, "model": {"a": "adjacent", "g": "adjacent"},
     "has_leader": {"a": True, "g": False}, "stub": {"a": True}, "own_nearest": True,
     "box": {"a": {"x": 109, "y": 92.2, "w": 35.892, "h": 15.6, "tol": 0.01}}},
    "Without the stub Alpha's box would start at x = 103 (mark radius 2, offset 1); with it "
    "the box starts 6 px (0.5 em) farther right, and the stub runs from 1.5 px outside the "
    "mark to (109, 100).")
CASES["stubs-not-nearer"] = case(
    "no stub where the label would come nearer to another mark than to its own",
    {**STUBS, "items": [STUBS["items"][0], pt("b", 120, 116, "Beta", priority=2), STUBS["items"][2]]},
    {"placed": 3, "anchor_side": {"a": "right"}, "has_leader": {"a": False}, "own_nearest": True,
     "box": {"a": {"x": 103, "y": 92.2, "w": 35.892, "h": 15.6, "tol": 0.01}}},
    "Beta's mark is 6.2 px below the middle of Alpha's label: 0.5 em farther right it would "
    "still be 6.2 px away, nearer than Alpha's own mark (7 px), so Alpha keeps its place "
    "against its mark, without a stub.")

# Small marks of every shape in a crowd (the concave L is pushed in, spec §4.5): the parity
# fixture of this case holds every stub of the Rust core, which TypeScript must reproduce.
STUB_MARKS = [{"shape": "polygon", "points": [[-5, -5], [5, -5], [5, 0], [0, 0], [0, 5], [-5, 5]]},
              {"shape": "rect", "w": 8, "h": 6}, {"shape": "ellipse", "rx": 5, "ry": 3, "rotation": 30},
              {"shape": "circle", "r": 3}]
CASES["stubs-mark-shapes"] = case(
    "stubs from marks of every shape in a crowd keep the guarantees",
    {"canvas": {"width": 320, "height": 240},
     "placement": {"stubs": "auto", "models": ["adjacent", "slider", "distant"]},
     "items": [pt(f"m{k}", round(160 + 70 * math.sin(2.4 * k) * (k / 32) ** 0.5, 2),
                  round(120 + 55 * math.cos(2.4 * k) * (k / 32) ** 0.5, 2),
                  ["Ash", "Birch", "Cedar", "Elm", "Fir", "Hazel", "Oak", "Pine", "Yew"][k % 9],
                  priority=32 - k)
               for k in range(32)]},
    {"placed_min": 12, "own_nearest": True})
for k, it in enumerate(CASES["stubs-mark-shapes"]["problem"]["items"]):
    it["anchor"]["mark"] = STUB_MARKS[k % 4]

# --- warm starts -------------------------------------------------------------------------
CASES["warm-start-follows-anchor"] = case(
    "a previous box that comes with its anchor moves with the item",
    {"canvas": {"width": 240, "height": 160},
     "items": [pt("a", 150, 100, "Alpha")],
     "warm_start": {"placements": [
         {"id": "a", "placed": True, "anchor": [100, 80],
          "box": {"x": 104, "y": 72.2, "w": 35.892, "h": 15.6}}]}},
    {"placed": 1, "anchor_side": {"a": "right"}, "model": {"a": "slider"},
     "box": {"a": {"x": 154, "y": 92.2, "w": 35.892, "h": 15.6, "tol": 0.01}}},
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
          "box": {"x": 104, "y": 93.37, "w": 30.508, "h": 13.26}}]}},
    {"placed": 1, "anchor_side": {"a": "right"}, "model": {"a": "slider"},
     "font": {"a": {"size": 10.2}},
     "box": {"a": {"x": 104, "y": 93.37, "w": 30.508, "h": 13.26, "tol": 0.01}}},
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
          "box": {"x": 82.054, "y": 61.4, "w": 35.892, "h": 15.6}}]}},
    {"placed": 1, "anchor_side": {"a": "top"}, "model": {"a": "slider"},
     "box": {"a": {"x": 82.654, "y": 61.4, "w": 35.892, "h": 15.6, "tol": 0.01}}},
    "The previous result placed Alpha above its point; a hard obstacle now covers the "
    "box's left 0.5 px. The box slides 0.05 em (0.6 px, the smallest nudge) to the right "
    "along the top of the mark; the nearest slider candidate would be 4.1 px away.")

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
          "box": {"x": 147.83, "y": 41.57, "w": 35.892, "h": 15.6},
          "leader": {"points": [[112.475, 92.525], [147.83, 57.17]], "style": "angles",
                     "port": [147.83, 57.17]}}]}},
    {"placed": 1, "model": {"a": "distant"}, "has_leader": {"a": True},
     "box": {"a": {"x": 157.83, "y": 46.57, "w": 35.892, "h": 15.6, "tol": 0.01}}},
    "Walls that labels may not overlap (leaders may cross them) surround the point, so "
    "its label needs a leader. The previous result had a 50 px leader at 45°, between "
    "the distant rings (44 and 70 px from the leader start); the point moved by (10, 5) "
    "and the label keeps that leader, moved by the same: the box is the previous one "
    "moved, which no ring candidate reproduces.")

CASES["raster-background"] = case(
    "raster background ink is avoided",
    {"problem_file": "../problems/raster-ink.json"},
    {"placed": 1})

# a black 10 × 12 raster at scale 0.1: canvas x 0–100, the full height
BLACK_STRIP = {"rgba": {"width": 10, "height": 12, "data": base64.b64encode(bytes([0, 0, 0, 255]) * 120).decode()},
               "scale": 0.1}

CASES["contrast-border"] = case(
    "a label does not straddle the edge between a black raster and the white canvas",
    {"canvas": {"width": 300, "height": 120}, "obstacles": {"raster": BLACK_STRIP},
     "items": [pt("a", 100, 60, "Border")]},
    {"placed": 1, "anchor_side": {"a": "right"}, "inside_canvas": True},
    "The point lies on the raster's right edge. The first position (top) would be half on "
    "black, half on white (contrast cost 0.5 per em² of the box); the right position lies "
    "on the white canvas only.")

CASES["contrast-off"] = case(
    "without the contrast weight the label takes the first position across the edge",
    {"canvas": {"width": 300, "height": 120}, "obstacles": {"raster": BLACK_STRIP},
     "weights": {"contrast": 0}, "items": [pt("a", 100, 60, "Border")]},
    {"placed": 1, "anchor_side": {"a": "top"}})

CASES["contrast-canvas-background"] = case(
    "a black canvas behind a black raster is no contrast border",
    {"canvas": {"width": 300, "height": 120, "background": "#000000"}, "obstacles": {"raster": BLACK_STRIP},
     "items": [pt("a", 100, 60, "Border")]},
    {"placed": 1, "anchor_side": {"a": "top"}})

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

CASES["search-restore-true-total"] = case(
    "local search keeps the best state it saw only when its total cost is lower than the walk's (leaders in "
    "other labels' buffer rings make the running sum drift)",
    {"canvas": {"width": 400, "height": 300}, "placement": {"models": ["adjacent", "slider", "distant"]},
     "items": [pt("p0", 205.8, 159, "Ash"), pt("p1", 203.2, 179, "Birch"), pt("p2", 189.1, 62.1, "Cedar"),
               pt("p3", 156.3, 140.7, "Elm"), pt("p4", 169.7, 105.9, "Fir"), pt("p5", 138.8, 165.7, "Hazel"),
               pt("p6", 267.4, 158.1, "Larch"), pt("p7", 192, 156.6, "Maple"), pt("p8", 189.4, 119.9, "Oak"),
               pt("p9", 216, 101.7, "Pine"), pt("p10", 219.2, 179.3, "Rowan"), pt("p11", 231.4, 214.5, "Yew"),
               pt("p12", 160, 156.3, "Alder"), pt("p13", 250.4, 155.3, "Aspen"),
               pt("p14", 163.3, 137.6, "Beech"), pt("p15", 164.9, 166.8, "Holly")]},
    {"placed": 16})


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
