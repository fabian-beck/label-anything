# 0050 — Stubs for labels in a crowd

* Status: accepted (new option `placement.stubs`, spec §6.9; Rust `la-core`, TypeScript `@label-anything/core`)
* Date: 2026-10-23

## Context
In a dense scatterplot an adjacent label touches its own mark, but other marks are often
just as close to it: they keep only the label margin (0.2 em) from its box. On the
economies chart of the home page, Mali, Senegal, Guinea and Benin sit among a dozen small
bubbles, and which label belongs to which point takes a careful look. The ambiguity term
of the cost (§8) prefers positions away from other marks, but in a crowd every position is
near one. A distant label with a leader settles the question, but it is costly (a leader,
at least `min_distance`, 1.5 em, away) and looks like a different kind of label.

## Decision
A new option `placement.stubs` (`off`, the default, or `auto`) gives a label that could be
read as a neighbour's a **stub**: a short straight leader from its mark, with the label
standing a little farther out.

* Only where needed: an adjacent or slider candidate is ambiguous when another item's mark
  (not of its own group) comes closer than `placement.stub_reach` (0.75 em) to its box.
  Labels of marks larger than their font size have none: a label against a large bubble
  reads as attached to its outline. On the economies chart, stubs on the large bubbles
  (Germany, the United Kingdom, France) pushed their labels into the room of Canada's and
  Spain's, which were then left out (143 labels instead of 147, at 1 em reach and 0.6 em
  length).
* An ambiguous candidate is replaced, not joined, by the same position with the offset
  `offset + stub_length` (0.5 em): the rule "an ambiguous label has a stub" holds for every
  placed label, and the candidate count stays the same. Keeping the plain candidate as
  well (it costs its ambiguity, up to 1) would let the solver leave labels ambiguous
  wherever that is a little cheaper.
* The stub runs from the mark (`anchor_gap` outside it) to the box point nearest that
  start, straight whatever the leader style: on axis positions it is horizontal or
  vertical, on diagonal ones it ends at the box corner. It is reported as the label's
  `leader` with `stub: true`, the model stays `adjacent` or `slider`, so hosts that draw
  leaders draw stubs and hosts that know them draw them more lightly.
* A stub is a leader for the hard rules (no crossings, not through labels), except that it
  keeps the label's margin from other marks instead of `leaders.clearance` (0.4 em): it
  lies in the space between the mark and the label, which the label keeps anyway; with
  the clearance, most stubs in a crowd would be infeasible.
* Costs: the stub costs `w_leader_length · len / em` (term `stub`, about 0.1), not the
  fixed `w_leader` (1): with it a stub label would cost more than the plain candidates of
  its item by over 1 and the pruning of §6.7 (`prune_factor × best + 1`) would drop it
  whenever the item has a free plain position. The label keeps the distance term (its gap
  includes the stub) and has no ambiguity term. A free position that needs no stub thus
  stays cheaper than one that does, and stubs stay cheaper than distant labels.
* Warm starts keep a label with its stub (a box up to `stub_length` farther out than an
  adjacent one is a slider-kind candidate with a stub); an ambiguous warm-start box that
  touches the mark, and such nudges, are not kept.

The defaults (0.75 em reach, 0.5 em length) were measured on the economies chart:

| reach / length | labels (of 195) | stubs |
|---|---|---|
| off | 150 | 0 |
| 0.5 em / 0.5 em | 149 | 28 |
| 0.75 em / 0.5 em | 149 | 43 |
| 0.75 em / 0.6 em | 146 | 30 |
| 1 em / 0.6 em | 147 | 47 |

0.5 em draws a stub of about 5 px at 11.5 px text: short, but a clear line.

## Consequences
* On the economies chart (now with `stubs: "auto"`) 43 of 149 labels have stubs, all in
  the crowds of small economies; 14 labels need a distant leader instead of 23, and the
  total cost falls from 133 to 105. Which of the small economies get a label changes: 15
  give way (Burkina Faso, Benin, Ghana, Bulgaria among them) and 14 others get one (Iraq,
  Niger, Zambia, Georgia among them), with no priority inversion.
* Stubs take room: on 2,000 random points in two Gaussian blobs (`scatter` preset), 186
  and 199 labels fit instead of 233 and 225, and the greedy pass takes about twice as long
  (leader conflict tests for most candidates instead of box tests). The option is off by
  default, and no result changes without it: every parity fixture stays as it was.
* Rust and TypeScript generate, cost and report stubs identically (three place cases,
  `stubs-near-other-marks`, `stubs-warm-start` and `stubs-mark-shapes`, the last with
  concave polygon, rectangle, ellipse and circle marks, with their parity fixtures; a
  validate case). The random problems of both test suites turn stubs on for a third of the seeds
  (108 of the first 300, with 598 labels on stubs): no hard violation, crossing or
  priority inversion, and the TypeScript results equal the Rust CLI's. The playground's scatter scene uses stubs and has a switch for them;
  `@label-anything/extras` gives stub paths the class `la-stub`; the Python and Java result
  types report `stub`.
* Only items' marks count as neighbours: points drawn as obstacles (vector points, SVG or
  raster ink) do not make a label ambiguous.
