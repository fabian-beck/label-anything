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
- The `map` preset and the Python and JavaScript plotting helpers, whenever a priority is
  given, set 10 for labels and 2.5 for leaders; the caller's own `avoid` wins key by key.
  The engine's default stays as before.

## Consequences
Important places keep their labels: 28 of the 30 busiest airports on the 1,000-airport map
instead of 16, Essen and Düsseldorf on the city map, China and India in the chart. The
price: a less important point whose mark a more important label covers goes unlabeled even
where it had room of its own. Problems without the `map` preset keep their results.
