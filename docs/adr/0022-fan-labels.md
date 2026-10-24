# 0022 — Fan labels: a crowd's labels in a column with fanning leaders

* Status: accepted
* Date: 2026-10-17
* Area: Candidates, leaders and costs
* Affects: spec §6.8, §7, §10.3; new behaviour, on by default
* Amends: [ADR 0019](0019-visual-quality-defaults.md) (clearances near a leader's start)

## Context
Where anchors crowd, adjacent positions run out and the ladder's distant labels have few
places left: they must keep the leader clearance from every other mark and leader
(ADR 0019), and with an explicit position order they keep to its sides (ADR 0021). The
line charts of the benchmark show the result: in `09-line-end-labels/unemployment-14-vector`
4 of 14 series ends stay unlabeled, in `life-62-boundary` 40 of 62. The usual remedy in
hand-made charts is a column of labels beside the crowd, in the crowd's order, with one
leader per label fanning out of it (excentric labeling, line-end label columns). The
search cannot find such columns: every candidate is one label, and a column only works
when all its labels move together.

## Decision
A post-search pass (`placement.fan`, default `auto`; spec §6.8) builds columns for crowds:

* **Where.** In priority order, items left without a label (`auto`; `always`: every item)
  seed crowds: anchors within half the two label heights vertically and one em
  horizontally (between the mark boxes) of a member, breadth first, at most 24. Crowds
  can be global (a dense plot) or local (a few line ends): the pass needs no global
  "crowded" switch.
* **What.** For the sides the seed's positions allow, the unlabeled members are stacked
  like boundary labels (isotonic stacking around the anchors' heights, the anchors' order
  kept unless a matching is shorter) at `max(min(rise, room), 1.5 em)` beyond the crowd,
  so leaders are at most 45° steep. Placed labels in the way whose items stand in the
  crowd's strip join the column; placed members that cannot move keep their labels; the
  lowest-priority failing member leaves. A column is applied only when it places more
  labels (`always`: at least as many), within the label budgets (`priority.budget`:
  unlabeled members leave, lowest priority first), and not when it inverts priorities (an
  omitted item placeable once less important labels were removed, which it was not
  before: a column's labels, or the room a moved label leaves, can cause that); it never
  removes a placed label without placing it again.
* **Leaders** are built like boundary leaders, are at most `leaders.max_length` long and
  keep every hard rule, with two changes for leaders that leave a crowd of touching marks
  (§7): a fan leader ignores marks containing its start and only must not cross marks
  closer than the clearance to its start; and for all leaders, a start is exempt from the
  leader spacing when the other leader starts within the clearance (before: only when
  the other leader's start was the point of that leader nearest to it — leaders of
  neighbouring marks 0.2 px apart along the other leader failed).
* **Not** with `prefix` omission, after a cancellation or the time guard, for items that
  may not get leaders (models and ladder without `distant`/`boundary`), `keep_with`
  members, area anchors, grouped items, and not with the `angles` leader style.
* **Budget:** `max(20 000, 20 × n)` label evaluations.

## Alternatives considered

* *Fan candidates in the search*: a column is a joint decision; per-label candidates
  cannot express that one label's slot depends on the others.
* *A global "crowded" mode switch*: crowds are local (one bundle of line ends in an
  otherwise sparse chart); seeding from unlabeled items finds them wherever they are.
* *Leaders along the allowed rays for `angles`* (a 45° segment, then horizontal): built
  and measured, no fan formed in any of four test problems — the diagonals from close
  ends are parallel and closer than the leader clearance. `elbow` columns (the same shape
  via boundary leaders) form in dense point clusters but not at line ends either.
* *A quarter of the clearance between a fan leader and the marks near its start*: removes
  the life-expectancy fan entirely (19 labels → 0); the ends there touch.
* *Exempting fan leaders from `leaders.max_length`* like boundary leaders: 29 instead of 26
  labels in the life chart, with leaders up to 12.4 em. Fans are on by default, so they
  keep the documented limit; raising it allows taller columns.
* *A column relaxing the clearance for all leaders*: changed many unrelated solutions.

## Consequences
Full suite, deterministic solves (no clock), default budgets, against the previous engine:

* placed 12 990 → 13 042 (+52), 0 hard violations in both; leaders 2 124 → 2 270.
* Line charts: unemployment 10 → 14 of 14 (12 in a fan column), life expectancy
  22 → 26 of 62 (19 in a column; its longest-leader p90 drops from 14.5 to 7.2 em because
  the margin label is gone). Dense random points (`10-stress`) +1 to +16, airports and
  city pins +1 each, `many-points` 199 → 200. Two-dimensional scatter crowds (gapminder,
  software metrics, citations, cities) get few or no columns: their leaders would cross
  the marks and labels around the crowd, and those rules stay hard.
* Visual metrics: leader–mark touches (within 1.5 px) 0 → 31 — fan leaders grazing the
  neighbouring marks of their crowd, which the relaxed rule allows; near crossings 0 → 2
  (two leaders of one column starting 5.4 px apart, closest 3.7 px: under the metric's
  fixed 4 px, above the engine's clearance at that font size); the ambiguity rate of the
  line charts 0 → 0.14 / 0.19 (it is measured at the leader's start, inside the crowd).
  The changed start exemption alters the gapminder solutions slightly (one label more
  counted ambiguous, position rank 1.57 → 1.62, 0.7 em less line under labels).
* Stability (`11-stability`, warm starts): displacement +3 to 4 %, flip rate +4 to 5 %,
  nesting rate 15.8 → 10.5 % for 1 000 items — columns are built anew in each frame from
  the crowds the search left.
* Time: the pass takes under 1.2 ms on small problems, 7 ms on the life chart, 38 ms on
  3 000 airports, 64 ms on 5 000 and 0.5 s on 20 000 random points (of about 9 s).
* The leader styles: in the tutorial's asteroid cluster `straight` places 10 → 11,
  `elbow` 8 → 10, `orthogonal` and `curved` are unchanged; `angles` has no fans.

The release-gate allow list (`bench/gates-allow.json`) names this ADR for the metric
changes above. Conformance: `fan-line-ends` (six crowded ends, all in a column),
`fan-always` (two adjacent labels moved into a column, boxes checked) and `fan-max-labels`
(the budget holds); the parity fixtures include all three.
