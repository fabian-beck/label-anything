# 0040 — Labels may cover the marks of less important items

* Status: accepted
* Date: 2026-10-18
* Area: Priority
* Affects: spec §4.4 `lower_items`, §9.2; Rust `la-core`, TypeScript
  `@label-anything/core`, benchmark evaluator
* Amends: [ADR 0033](0033-gallery-vector-images-data-colors-hubs-first.md) (the hub maps)
* Amended by: [ADR 0045](0045-important-labels-win-by-default.md) (on by default on maps
  and in the helpers)

## Context
With `avoid.label.items` hard, every mark blocks every label, whatever the two items' priorities.
In a dense region this inverts the intent of a priority: the label of a hub airport has no
position free of the marks of the small airports around it, so the hub is omitted while
the small airports keep theirs. The gallery's world map of 1000 airports lost ATL, ORD,
LHR, CDG and FRA this way. Making `items` soft does not help: labels then cover marks
whose items are labeled elsewhere, and a reader attributes the covering label to the
wrong mark.

## Decision
`avoid.label.lower_items` and `avoid.leader.lower_items` (not classes; `"*"` does not set
them) give the policy for the marks of items of lower priority key; without them, those
marks follow `items`. When `avoid.label.lower_items` is given and not hard, a label of
item `i` that overlaps the mark of a less important item `j` conflicts with every label
of `j`, like two overlapping labels: a covered mark stays unlabeled. The strict omission
test (§9.2) counts a covering label of higher key as blocking. Group members are exempt
(a group's label may cover its members).

The rule is a pairwise conflict in the solver's state (a second index over the marks):
the greedy kill lists, the lookahead, the exact search and the verification all see it
through the conflict queries. Committing or removing a label also refreshes the alive
flags of the candidates of the items whose marks it covers, since the conflict is not
local to the label's neighbourhood. The benchmark evaluator applies the same rule to its
hard tests (`label_lower`: a labeled item whose mark a more important label covers) and
to its removal test.

## Consequences
Hubs keep their labels in dense regions. On the world map of the 1,000 busiest airports
(benchmark config `05-airports/world-iata-1000-lower-vector`: `lower_items` 10 for labels,
2.5 for leaders) 9 of the 10 busiest airports and 28 of the 30 busiest are labeled, against
5 and 16 without the option (`world-iata-1000-vector`): ATL, ORD, LHR, CDG and FRA are back;
AMS stays out, its dot under LHR's label at 5 px per degree. The hub maps use the option
too and label all of their 30 hubs. Problems without `lower_items` are unchanged (the
parity fixtures of the sample problems did not change). The label of a less important item
disappears when a more important label covers its mark, even where it had room — the
price of keeping covered marks unlabeled.
