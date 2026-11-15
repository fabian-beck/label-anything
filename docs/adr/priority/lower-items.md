# Lower items

A label may hide the marks of less important items, which then go unlabeled; where a place
beside its mark allows it, it stands neither beside such a mark nor partly on it. Maps and
the plotting helpers let labels cover such marks by default.

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
- **Only where it can be met.** The rule holds for an item when one of the 8 fixed
  positions (spec §6.1) of its first variant hides or keeps clear of the less important
  marks by it, as the rule for unlabeled points does. Among minor marks so dense that none
  does, the item keeps the place its priority gives it: that is the hub in a crowd of
  minor marks, which `lower_items` is for.
- The rule has no option of its own: `placement.own_nearest: false` gives the labels
  before.
- Marks that are soft through `items` alone stay outside the rule: hiding one does not
  stop its item from being labeled.
- With `prefix` omission a covered item does not end the prefix, as the removal test of
  strict omission does not count it: it has no candidate, whatever its place in the
  order. A member of a group label does not end it either. The greedy pass goes on past
  such an item; the local search inserts the item that ends the prefix; no move of the
  local search, the exact search or the passes after it leaves a mark before the end of
  the prefix uncovered that a moved label covered — that item would end the prefix, and
  the labels after it would be inversions.
- The `map` preset and the Python and JavaScript plotting helpers, whenever a priority is
  given, set 10 for labels and 2.5 for leaders; the caller's own `avoid` wins key by key.
  The engine's default stays as before.

## Consequences
Important places keep their labels: 28 of the 30 busiest airports on the 1,000-airport
map, against 16 with every mark hard. The price: a less important point whose mark a more
important label covers goes unlabeled even where it had room of its own. Problems that do
not let labels cover less important marks keep their results.

Where a clear place exists, labels take it. On the quick suite (12 problems, 2,319 items,
the default aggressiveness) the labels that an item's mark makes unclear fall from 81 to
32, unclear labels in all from 130 to 84; 874 labels are placed and usable instead of 875,
171 of them on leaders (148), in 266 ms instead of 278 (the sum of the median solve
times). Of the full suite's 66 problems the 28 with the `map` preset change (75,214
items): there such labels fall from 4,021 to 2,347 — the rest belong to items among marks
too dense for the rule — and 12,836 labels are placed instead of 13,325 (3.7 % fewer),
4,181 of them on leaders (3,440). The most important labels stay as they were: of the 10
most important items of each of these problems, 272 are labeled (273 before), 23 of them
on leaders (22). With `high` 4.1 % fewer labels are placed, with `low`, which has no
leaders to fall back on, 6.8 % fewer.

Before covered items stopped ending the prefix, one covered mark cut it: on the world's
airports ordered by outlierness, Rota's label covered Guam's mark and the prefix ended
after 24 of 3,221 airports. When they stopped (2026-10-25), the four benchmark problems
with `prefix` omission on the `map` preset kept 193 instead of 24, 47 instead of 20 and 67
instead of 16 of 3,221 airports, and 247 instead of 193 of Europe's 250; problems with
other omission modes, and without covering labels, kept their results. Group members
ended the prefix as well, which the verification counted as inversions.

With `prefix` omission the first label without a clear place ends the prefix, one whose
mark a more important label hides does not (above): 192 instead of 135 of 250 European
cities, where Manchester's label, 0.3 px beside Liverpool's dot before, now hides it and
the prefix goes on past Liverpool; 126 instead of 168 of the airports ordered by
outlierness (31 and 67 of the airports ordered otherwise, as before).

Between the frames of a zoom, marks move in and out from under labels: over 1,000
airports labels move 3.3 px per frame instead of 2.8, and 235 disappear over 30 frames
instead of 191. Solve times stay as they were (117 ms for the 1,000 airports). The release
gate's allow-list names the configurations whose measures this moves by more than 2 %.

## Alternatives
- **The rule for every item**: no label is unclear because of an item's mark, but the
  important labels pay. Over the 28 map problems 8.7 % fewer labels are placed, and of the
  10 most important items of each, 140 of 278 labels stand on leaders (22 of 273 before);
  with `low`, without leaders, 130 of those items keep a label instead of 251, and 27 % of
  all labels are lost.
- **Partly covered marks allowed**, as they conflict with their item's label anyway, the
  rule only against marks beside the label: on five map problems it left 189 of 314 such
  labels unclear and lost as many labels as the rule for every item (52 and 53 of 1,913).
- **Marks soft through `items` too**: with no priority between the two items, a hidden
  mark's item may still be labeled, so hiding the mark would not settle whose the label is.
