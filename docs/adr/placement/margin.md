# Margin

A label touches its own mark, keeps a margin of 0.2 em from other items' marks and twice
that from other labels, and is clearly nearer its own mark than any other.

## Context
A label is read as belonging to what it is closest to. With overlaps forbidden but nothing
more, labels touched each other and the marks of other items: on six test scenes 38–43 %
of the labels came within 0.25 em of another label, and 2–12 % of the adjacent labels were
closer to another item's mark than to their own. Soft costs could not fix it: where space
is short, a cost trades against other costs.

A margin alone left two gaps, both seen on the economies chart of the home page. It never
asks more than the other mark keeps from the own one, so a label could stand about as near
another mark as its own: North Korea's stood 1.0 px from its bubble and 1.4 px from
Cameroon's. And labels kept only the margin from each other: with the padding their
letters stood about 0.5 em apart, closer than the lines of one label, so that neighbouring
labels read as one.

## Decision
- `defaults.margin` = 0.2 em (0.3 em with `placement.aggressiveness` `low`, ADR
  placement/aggressiveness) is a hard distance from other items' marks
  (`avoid.label.items` hard). From another mark a label keeps at most what that mark keeps
  from the bounding box of its own mark, so that items on top of or next to each other
  can still be labeled.
- `defaults.spacing` (`null`: twice the margin, 0.4 em) is the hard distance between
  labels (`avoid.label.labels` hard): two labels keep the larger spacing of their items,
  at least their margin, so that with the padding their letters stand 0.7 em apart. Boxes
  exactly that far apart do not conflict, so columns stack at that gap; stubs (ADR
  placement/stubs) keep it from other labels too.
- `placement.offset` = 1 px brings adjacent labels close to their own mark.
- **Own mark nearest** (`placement.own_nearest`, default on): an adjacent or slider label
  is never nearer to the mark of another item (one it may not cover, outside its group)
  than to its own. Without a stub it must be nearer its own by its margin, capped by the
  distance between the two marks: infeasible when
  `dist(mark_j, box) < dist(mark_i, box) + min(m, |p_j − p_i|) − EPS`. Internal labels and
  labels on distant leaders are exempt.
- Warm-start candidates need only half the margin and spacing (ADR motion/warm-starts).

## Consequences
On the six scenes, labels sit about 0.1 em from their own mark and at most 0.3 % of them
are ambiguous (2–12 % before). On the economies chart no label covers another bubble or
stands about as near another as its own; Austria and Hong Kong have no clear place and
stay unlabeled. Space costs labels where it is short: over 49 sample, tutorial, home
page and playground problems, the spacing and the clear margin place 1,380 labels instead
of 1,427, more of them on leaders, and the local search meets more conflicts (the 62
line-end labels of the life-expectancy chart solve in 65 ms instead of 41).
`defaults.margin: 0` with `placement.offset: 2` gives the results before the margin, and
`placement.own_nearest: false` drops the rule.

## Alternatives
- **0.1 em**: half the labels of the city map still crowd each other.
- **A margin of 0.3 or 0.4 em from marks**: more labels lost for little visible gain, as
  label padding already adds 0.15 em around the text.
- **The margin between labels too**: their letters stand closer than the lines of one
  label.
- **An offset of 2 px**: labels farther from their mark and more often ambiguous.
- **Ties allowed** (no other mark nearer, but as near): kept labels beside a column of
  touching points, which then read as either point's; they now need a stub or a leader.
- **Stronger soft terms** (four times the ambiguity weight, a buffer ring): labels stayed
  as close, or were pushed against other marks.
