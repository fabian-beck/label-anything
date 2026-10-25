# Lower items

A label may cover the marks of less important items, which then go unlabeled; maps and the
plotting helpers do this by default.

## Context
With `avoid.label.items` hard, every mark blocks every label, whatever the items'
priorities. In dense regions this inverts priority: a hub airport finds no position free
of the small airports' marks around it, so the hub is omitted while they keep their labels
— the 1,000-airport world map lost ATL, ORD, LHR, CDG and FRA. Every priority-driven
helper use tried showed the same with default settings: Essen and Düsseldorf unlabeled on
a map of Germany's largest cities, China and India missing from a chart of the most
populous countries. Soft `items` does not help: labels then cover marks whose items are
labeled elsewhere, and readers attribute them to the wrong mark.

## Decision
- `avoid.label.lower_items` and `avoid.leader.lower_items` set the policy for the marks of
  items of lower key (without them, those marks follow `items`). When the label policy is
  given and not hard, a label that covers a less important item's mark excludes every
  label of that item, like two overlapping labels: a covered mark stays unlabeled and is
  never misattributed. A group's label may cover its members.
- The exclusion is a pairwise conflict in the solver's state, so the greedy pass, the
  lookahead, the exact search, the verification and the strict removal test all see it.
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
Important places keep their labels: 28 of the 30 busiest airports on the 1,000-airport map
instead of 16, Essen and Düsseldorf on the city map, China and India in the chart. The
price: a less important point whose mark a more important label covers goes unlabeled even
where it had room of its own. Problems without the `map` preset keep their results.

Before covered items stopped ending the prefix, one covered mark cut it: on the world's
airports ordered by outlierness, Rota's label covered Guam's mark and the prefix ended
after 24 of 3,221 airports. With the rule the four benchmark problems with `prefix`
omission on the `map` preset keep 193 instead of 24, 47 instead of 20 and 67 instead of 16
of 3,221 airports, and 247 instead of 193 of Europe's 250; problems with other omission
modes, and without covering labels, keep their results. Group members ended the prefix as
well, which the verification counted as inversions.
