# Priority repair

When strict omission leaves an item without a label, the repair may move one more
important label aside to make room, removing at most one less important label.

## Context
On the benchmark's airport maps, large hubs lost their labels to slightly larger hubs
nearby: Amsterdam, Munich, Zurich, Palma. Each time, a more important label covered the
corner of the hub's mark, which lower items allow (ADR priority/lower-items), because that
position was a little cheaper; and pruning had left the label positions on that side only,
so nothing later could move it. The local search moves a label only to a candidate it
already has, and the repair only removed labels of lower key.

## Decision
The repair after the search (spec §10.3) gets a second option for an omitted item that has
no candidate blocked only by labels of lower key: cheapest first, it tries the first 8 of
its usable candidates whose conflicts are one label `b` of a key not lower than its own
and at most one removable label. `b` moves to one of its 16 cheapest usable candidates or
to a level-0 position that pruning had dropped, regenerated for `b` alone. At most one
label is removed in all, so a move never lowers the number of labels and always raises the
priority-weighted placement. Fan and boundary labels do not move. A pass that moved a
label is followed by one without moves, after which the removal test again finds no
inversion.

## Consequences
The full benchmark places 71 more labels (+0.5 %); every problem that changes rises in
priority-weighted placement, none loses labels, and the runtime is unchanged within noise.
Munich, Toronto, Xiamen and Detroit get labels. Amsterdam stays unlabeled on the
1,000-airport map, because making room removes two labels: here the rule keeps the label
count over the strict order.

## Alternatives
- **Counting the exclusion of covered marks fully in the lookahead**: Amsterdam still
  unlabeled, other hubs traded away.
- **Keeping the cheapest candidate of every side through pruning**: fewer labels (526 →
  519 on the 1,000-airport map).
- **Removing any number of less important labels**: Amsterdam and Munich labeled, 45
  labels lost in all.
