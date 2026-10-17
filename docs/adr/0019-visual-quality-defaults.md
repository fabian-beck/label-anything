# 0019 — Leaders keep clear of marks and of each other; no margin labels by default; coverage costs count what is hidden

* Status: accepted (behaviour change; spec §4.4, §7, §8, defaults.md); the `illustration`
  preset's label ink weight is 1.0 since ADR 0029
* Date: 2026-10-17

## Context
Renderings of the benchmark (the gallery) showed clutter that broke no hard constraint:
leaders across half the picture, leaders passing within a pixel or two of another
leader (which reads as a crossing), leaders running through other data points, and
labels on top of line-chart lines and scatterplot points. To measure it, the evaluator
got visual metrics (`bench/eval/visual.py`): leader length relative to the canvas
diagonal, near crossings (two leaders closer than 4 px without crossing, the approach of
two leaders starting at neighbouring marks exempt), parallel leaders of neighbouring
marks, leaders passing other items' marks and other classes' primitives, and the points
and line length hidden by labels. On the full suite (deterministic solves, `--no-clock`,
default budgets) the engine before this change produced:

* 169 leaders longer than a quarter of the canvas diagonal (up to 147 em) — all of them
  boundary labels from the `boundary` step of the default ladder;
* 1,424 near crossings; 1,074 of 1,084 analysed were one leader passing the start of
  another, i.e. passing another item's mark: `avoid.leader.items` was soft (2.0), and the
  leader–leader `clearance` only a soft buffer cost;
* 25,505 leader–mark touches (a leader within 1.5 px of another item's mark), up to 8 per
  leader in dense maps;
* `leaders.min_angle_between` (10°) was documented but implemented nowhere;
* label coverage cost `w · covered / area(label)` and leader coverage cost
  `w · covered_len / len`: a 1 px line across a long label is a small fraction of it
  (≈ 0.07 · w for the line-chart labels), so covering data was cheaper than any
  alternative; a long label could hide more for the same cost than a short one.

The objective is lexicographic: priority first, cost second. A soft cost therefore never
prevents a placement — it only chooses among feasible candidates. What must not happen
has to be a hard rule; what should happen rarely needs a cost that is large compared with
the other terms.

## Decision
* **No `boundary` in the default ladder** (`["alternatives", "wrap", "distant",
  "evict_lower", "shrink:0.85", "soft_overlap", "omit"]`; the `scatter` preset had this
  ladder already and now inherits it). Margin labels stay available as a model
  (`placement.models`, the `illustration` preset) and as an explicit ladder step.
* **Leaders keep `leaders.clearance` from other items' marks** (`avoid.leader.items`
  hard). Exempt are the marks of the item's group and marks containing the leader's
  anchor (no leader of the item avoids them, e.g. a small bubble inside a large one).
* **Leaders keep `leaders.clearance` from each other** (with `avoid.leader.leaders` hard):
  two leaders conflict when they intersect or when a vertex of one (start, bends, port,
  underline ends) is closer than the larger of the two clearances to the other — leaders
  that do not intersect are closest at such a vertex — except the start of one leader
  when the other's start is its nearest point (leaders of neighbouring marks start close
  together and diverge).
* **`leaders.min_angle_between` is implemented**: distant leaders starting closer than the
  larger font size of the two items must diverge by at least that angle
  (`u·v ≤ cos(α)·|u|·|v|`, cos from the deterministic math). Boundary leaders are exempt.
* **`leaders.clearance` = 0.4 em** (was 3 px; 4.8 px at the default 12 px).
* **Coverage costs count the covered amount**: `w · covered / em²` for labels (also
  `canvas_edge`, soft `items`, relaxed classes and the dynamic label terms) and
  `w · covered_len / em` for leaders. A weight is now the cost of hiding one em² of a class;
  `weights.leader` = 1 costs as much as hiding one em² of weight 1.
* **Internal labels of marks pay no soft class costs**: the mark is drawn over what lies
  under it (graph edges converging under a node), so an internal label hides only its own
  mark. Hard classes still apply.
* **Ink weights recalibrated** for the em² scale: `avoid.label.ink` 0.5 → 0.1 (defaults,
  `auto`, `scatter`, `map`, `graph`), `illustration` 2.0 → 0.15 (long labels), and
  `avoid.leader.ink` 0.2 → 0.05 (`illustration` 0.1 → 0.025).

The TypeScript core mirrors every rule bit for bit (`leadersConflict`, `leadersParallel`,
`candLeadersConflict`; the parity fixtures are regenerated). The evaluator checks the new
hard rules (`leader_near`, `leader_angle`, `leader_item` with the clearance).

Considered and rejected:
* *A relaxable leader–mark rule* (`soft_overlap` lets a leader pass a mark before the
  label is omitted): +119 labels (+0.9 %) over the suite, but 11,170 leader–mark touches
  and 40 near crossings came back.
* *Leaders never touching unlabeled points* (`avoid.leader.points: "hard"`): no
  measurable effect (227 point touches either way, within 1.5 px but not through).
* *3 px clearance*: 4 near crossings and 10 parallel pairs left instead of 1 and 0, for
  0.6 % more labels.

## Consequences
Full suite, deterministic solves, default budgets, before → after:

| | before | after |
|---|---|---|
| labels placed | 13,307 | 13,000 (−2.3 %) |
| `placed_weighted` (sum over problems) | 32.1 | 30.8 |
| leaders longer than ¼ of the canvas diagonal | 169 | 0 |
| near crossings (< 4 px) | 1,424 | 1 |
| parallel leaders of neighbouring marks | 75 | 0 |
| leader–mark touches (< 1.5 px) | 25,505 | 0 |
| leaders touching unlabeled points / lines | 1,222 / 5,630 | 227 / 1,107 |
| points hidden by labels | 1,862 | 1,524 (−18 %) |
| line length hidden by labels | 3,506 em | 2,855 em (−19 %) |
| ambiguity rate (sum over problems) | 12.2 | 9.6 |
| mean position rank (sum over problems) | 152.7 | 152.8 |

The labels that are lost are those whose only positions needed a leader through a dense
cluster or across the picture: Cora 89 → 74 of 150 (its 26 boundary labels had leaders of
up to 113 em), the life-expectancy line ends 42 → 27 of 62 (their leaders started inside a
stack of line ends), Monaco 228–244 → 208–231 of 375, and the prefix-mode priority
problems, where the first label that finds no clean leader ends the prefix (airports 9 →
0, outlier airports 152 → 107). Dense crowds of overlapping marks keep fewer labels with
leaders; this is the intended trade: an omitted label is reported (`omitted_by_priority`
or `no_feasible_candidate`), a leader through other marks misleads.

Costs are on a new scale: user weights tuned for the old fractions are about 3–10 times
stronger now for typical labels (a weight `w` of the old scale corresponds to roughly
`w / (label area in em²)`). The conformance cases `prefix-ladder` and
`explain-blocked-by-labels` got problems that still exercise the ladder in prefix mode and
the explanation of label-blocked items under the new rules; `leader-angles` expects 6
labels (was 8) on its cluster of overlapping marks.
