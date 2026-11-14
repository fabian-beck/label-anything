# Lower items

A label may hide the marks of less important items, which then go unlabeled, but stands
neither beside such a mark nor partly on it; maps and the plotting helpers do this by
default.

## Context
With `avoid.label.items` hard, every mark blocks every label, whatever the items'
priorities. In dense regions this inverts priority: a hub airport finds no position free
of the small airports' marks around it, so the hub is omitted while they keep their labels
— the 1,000-airport world map lost ATL, ORD, LHR, CDG and FRA. Every priority-driven
helper use tried showed the same with default settings: Essen and Düsseldorf unlabeled on
a map of Germany's largest cities, China and India missing from a chart of the most
populous countries. Soft `items` does not help: labels then cover marks whose items are
labeled elsewhere, and readers attribute them to the wrong mark.

Covering alone left labels that could be another mark's. The own-mark rule (ADR
placement/margin) saw only the marks a label may not cover, so a label could stand beside
the dot of a less important item or lie partly on it. On the benchmark's quick suite
(2026-10-24), all 91 labels that an item's mark made unclear (ADR
project/benchmark-measures) stood by such a mark: 42 lay partly on the mark of an
unlabeled item, 16 beside one, and 33 beside the mark of an item labeled elsewhere, so
that two labels competed for one dot.

## Decision
- `avoid.label.lower_items` and `avoid.leader.lower_items` set the policy for the marks of
  items of lower key (without them, those marks follow `items`). When the label policy is
  given and not hard, a label that covers a less important item's mark excludes every
  label of that item, like two overlapping labels: a covered mark stays unlabeled and is
  never misattributed. A group's label may cover its members.
- The exclusion is a pairwise conflict in the solver's state, so the greedy pass, the
  lookahead, the exact search, the verification and the strict removal test all see it.
- **Hidden or clear.** With `placement.own_nearest`, the own-mark rule holds against such
  a mark as against one a label may not cover, unless the label hides it: an adjacent or
  slider label is infeasible when the mark comes nearer to it than its own mark plus `s`
  (the margin, at most the distance between the two marks; 0 with a stub). A mark is
  hidden when its bounding box lies inside the label box. A label thus hides a minor mark
  entirely or keeps clear of it, as with unlabeled points (ADR placement/unlabeled-points).
  Internal labels and labels on distant leaders are exempt, as from the rule itself.
- The rule holds for every item, and has no option of its own: `placement.own_nearest:
  false` gives the labels before.
- Marks that are soft through `items` alone stay outside the rule: hiding one does not
  stop its item from being labeled.
- The `map` preset and the Python and JavaScript plotting helpers, whenever a priority is
  given, set 10 for labels and 2.5 for leaders; the caller's own `avoid` wins key by key.
  The engine's default stays as before.

## Consequences
Important places keep their labels: all of the 30 busiest airports on the 1,000-airport
map, against 17 with every mark hard and 28 before the own-mark rule reached these marks
(AMS lay partly under LHR's label). The price: a less important point whose mark a more
important label hides goes unlabeled even where it had room of its own. Problems that do
not let labels cover less important marks keep their results.

No label is unclear because of another item's mark any more. On the quick suite (12
problems, 2,319 items) unclear labels fall from 132 to 47, those caused by an item's mark
from 80 to 0, the rest by unlabeled points alone (52 before); 898 labels are placed and
usable instead of 901, 232 of them on leaders (165), in 404 ms instead of 414 (the sum of
the median solve times). Of the full suite's 66 problems the 28 with the `map` preset
change (75,214 items): there such labels fall from 4,223 to 0 and the data points under
labels from 18,550 to 12,046.

Dense maps pay for it: those 28 problems place 12,416 labels instead of 13,703 (9.4 %
fewer), 5,843 of them on leaders (3,450), and 2,732 labels on leaders end within 0.2 em
of another point (1,226). The most important labels gain, as above, and the tail loses:
of the 100 busiest airports 87 are labeled (83), of all 1,000 543 (563); of 3,000
airports 966 (1,063); of 20,000 stress anchors, where the time guard leaves most items
only the places beside their marks, 706 (914). The densest solves take longer, as more
items run the ladder: 175 ms instead of 155 for the 1,000 airports. With `prefix` omission
one such item ends the prefix: 89 instead of 193 of 250 European cities, where Manchester's
label, 2 px from two minor dots before, now hides Liverpool's dot. Between the frames of
a zoom a hidden mark comes out at a label's edge: over 1,000 airports labels move 4.2 px
per frame instead of 3.7, and 288 disappear over 30 frames instead of 237. The release
gate's allow-list names the configurations whose measures this moves by more than 2 %.

## Alternatives
- **Partly covered marks**, which conflict with their item's label anyway (the state
  before): 42 of the 91 unclear labels lay on such a mark, which shows from under the
  label's edge like one beside it.
- **Only where a fixed position can meet it**, as for unlabeled points: on 11 map problems
  it left 158 of 383 such labels unclear and saved 20 of the 153 labels the rule costs
  there.
- **Marks soft through `items` too**: with no priority between the two items, a hidden
  mark's item may still be labeled, so hiding the mark would not settle whose the label is.
