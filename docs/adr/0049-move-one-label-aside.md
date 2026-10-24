# 0049 — The priority repair moves one label aside

* Status: accepted
* Date: 2026-10-18
* Area: Priority
* Affects: spec §10.3 (the priority repair); Rust `la-core`, TypeScript
  `@label-anything/core`

## Context
On the airport maps of the benchmark, large hubs lose their labels to slightly larger
ones nearby: Amsterdam (rank 9 of 1,000 by routes) on the 1,000- and 3,000-airport maps,
Munich (16), Zurich (47), Palma (36). The mechanism is the same each time. The `map`
preset lets a label cover the marks of less important places (`lower_items`, ADR 0040),
and a label that covers a mark excludes every label of that item. Heathrow's label sits
top right of its dot, over the corner of Amsterdam's dot 26 px away, because that is
cheaper by about 10 than its other positions. The greedy lookahead weighs what a label
takes from its neighbours (`weights.starve` = 2 for an item left without a candidate), so
saving 10 wins. The pruning of §6.7 then left Heathrow only five candidates, all above
its dot, so nothing later could move it out of the way: the local search moves a label
only to a free candidate it already has, and the priority repair only removes labels of
lower key. On the four airport and POI maps, 40–60 % of the omitted items have a mark
that a more important label covers.

## Decision
The priority repair of strict omission gets a second option for an item that has no
candidate held only by labels of lower key: it may **move one label aside**. Of the
item's usable candidates, cheapest first, the first 8 whose conflicts are a single label
`b` of a key not lower than its own, plus at most one removable label, are tried. `b`
moves to one of the 16 cheapest of its own usable candidates and its level-0 candidates
that the pruning dropped. Those are generated again for `b` alone, because pruning
compares an item's positions with each other before any label is placed, and a label
that has to make room needs exactly the ones it dropped. The place must conflict with
neither the item's candidate nor any placed label but removable ones.

At most one label is removed in all, so a move never lowers the number of labels and
always raises the priority-weighted placement (the item ranks above the label it
displaces). The choice is fewest removed, then the smallest gain removed, then the
smallest cost change. Fan and boundary labels do not move, because they are arranged
jointly.

A moved label can free a position for an item the pass has already visited, so a pass
that moved a label is followed by one more pass without such moves. That pass only
removes labels of lower key, and after it the removal test of §9.2 again finds no
inversion. The freed position may be one the pruning dropped for the earlier item: on the
5,000-point stress problem a label moved aside cleared the costly position of a more
important item, which the evaluator then reported as an inversion. In that pass an item
near the old place of a moved label therefore also tries its dropped level-0 candidates
by the same rule.

## Alternatives considered

Measured on the full suite without the clock (61 problems):

* Counting the `lower_items` exclusion fully in the lookahead (all candidates of the item
  whose mark the label covers, as a commit counts them) left Amsterdam unlabeled and
  traded hubs for others on the 3,000-airport priority maps.
* Keeping the cheapest candidate of every side through the pruning lowered the number of
  labels (526 → 519 on the 1,000-airport map).
* A repair that lets an omitted item move one more important label to another of its
  positions, removing any number of less important labels in the way, gives Amsterdam and
  Munich their labels, but removes 45 labels in all (635 → 616 on one priority map).
* With at most one label removed per move, the suite gains 73 labels. With labels in the
  way also moved aside instead of removed, it gains 79, for a deeper search.

## Consequences
* Full suite, no clock: 14,463 → 14,534 labels (+0.5 %). On every one of the 20 problems
  that change, the priority-weighted placement rises: the 1,000-airport map 526 → 531
  labels, the 3,000-airport map 936 → 946, the 2,000-point stress problem 852 → 855,
  20,000 points 1,131 → 1,145, Monaco 203 → 204. No problem loses labels. Hard violations
  and inversions stay 0, by the engine's own test and by the evaluator's. Runtime is
  unchanged within the noise: the repair runs once over the omitted items, and the
  regeneration runs only for moved labels and the items near them.
* Xiamen (rank 53), Detroit (58) and Faro (156) get labels on the 300-airport map, and
  Munich (16) and Toronto (27) on the 3,221-airport priority map. Others give way, mostly
  less important ones, but not only: Vienna (30) loses its label on that map, where one
  move leads to others. Amsterdam stays unlabeled on the 1,000-airport map, because making
  room for it removes two labels (Gatwick and Bergen). There the rule keeps the label
  count rather than the strict lexicographic order.
* The evaluator's removal test now keeps the label margin of §4.4, as the engine does.
  Without it, it reported inversions (Trollhättan, Skardu, Tirana on unchanged results)
  that are positions closer than the margin to a more important label.
* Rust and TypeScript run the same repair; the solve traces (ADR 0046) record a move as a
  `relocate` pass, and the explainer narrates it.
