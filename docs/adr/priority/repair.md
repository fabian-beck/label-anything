# Priority repair

When strict omission leaves an item without a label, the repair tries the positions that
pruning dropped, and may move one more important label aside to make room, removing at
most one less important label.

## Context
On the benchmark's airport maps, large hubs lost their labels to slightly larger hubs
nearby: Amsterdam, Munich, Zurich, Palma. Each time, a more important label covered the
corner of the hub's mark, which lower items allow (ADR priority/lower-items), because that
position was a little cheaper; and pruning had left the label positions on that side only,
so nothing later could move it. The local search moves a label only to a candidate it
already has, and the repair only removed labels of lower key.

Pruning (spec §6.7) drops the candidates that cost more than four times an item's best.
Where the cheap side is taken by a more important label, an item's only free position can
be among them: one over the dots of less important airports, which the `map` preset lets
labels cover at a cost. Without the ladder's later steps, which made smaller variants with
candidates of their own, the benchmark's own removal test found such omitted items on 10
of the 59 static problems at `placement.aggressiveness` `low`, 4 at `medium` and 1 at
`high` (ADR placement/aggressiveness).

## Decision
The repair after the search (spec §10.3) first tries, for an omitted item without a
candidate blocked only by labels of lower key, its level-0 positions that the pruning
dropped, regenerated for that item by the same rule. Only items that lost a position to
pruning regenerate, and a position is evaluated only when no label of at least the item's
priority is in its way. The repair then gets a second option for an omitted item that has
no such candidate either: cheapest first, it tries the first 8 of
its usable candidates whose conflicts are one label `b` of a key not lower than its own
and at most one removable label. `b` moves to one of its 16 cheapest usable candidates or
to a level-0 position that pruning had dropped, regenerated for `b` alone. At most one
label is removed in all, so a move never lowers the number of labels and always raises the
priority-weighted placement. Fan and boundary labels do not move. A pass that moved a
label is followed by one without moves, after which the removal test again finds no
inversion.

## Consequences
Trying the pruned positions removes every inversion the benchmark's removal test found on
the 59 static problems (25 at `low`, 6 at `medium`, 1 at `high`) and places 10 more labels
in all, at about 30 ms of repair on the 20,000-point stress problem. The moves aside placed
71 more labels on the full benchmark (+0.5 %) when they came: every problem that changed
rose in priority-weighted placement, none lost labels, and the runtime stayed the same
within noise. Munich, Toronto, Xiamen and Detroit get labels. Amsterdam stays unlabeled on the
1,000-airport map, because making room removes two labels: here the rule keeps the label
count over the strict order.

## Alternatives
- **Counting the exclusion of covered marks fully in the lookahead**: Amsterdam still
  unlabeled, other hubs traded away.
- **Keeping the cheapest candidate of every side through pruning**: fewer labels (526 →
  519 on the 1,000-airport map).
- **Removing any number of less important labels**: Amsterdam and Munich labeled, 45
  labels lost in all.
