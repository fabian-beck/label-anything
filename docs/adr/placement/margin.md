# Margin

A label touches its own mark, keeps a margin of 0.2 em from other items' marks and twice
that from other labels, and is clearly nearer its own mark than any other — by up to 0.5 em
from a point that lies more squarely beside one of its sides than its own mark.

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

Distance alone also missed where the other mark lies. On the Europe map of the home page,
Luxembourg's label hung below and left of its dot, touching it with a corner (1 px), and
began 4.3 px from Paris's dot, level with it: more than the margin (1.6 px at 8 px), so the
rule let it stand, yet it read as Paris's second label, in the place where a label of Paris
would go. A mark beside the middle of a side is where that mark's own label would stand;
one at a corner is not.

## Decision
- `defaults.margin` = 0.2 em is a hard distance from other items' marks
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
- **Side margin** (`defaults.side_margin`, 0.5 em): from a point's mark that lies more
  squarely beside a side of the label than the label's own mark, the label must be farther
  by up to the side margin: `m` becomes `m + (k − m) · max(0, f_j − f_i)`, where
  `f = |dx² − dy²| / (dx² + dy²)` for the offset of a mark's reference point from the box is
  1 straight across a side and 0 on a corner's diagonal. A label whose own mark faces a
  side as squarely keeps the margin; area items' dots, which a host need not draw, keep it
  too. The arithmetic is `+ − × ÷` only, identical in Rust and TypeScript.
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

The side margin, over the benchmark's full suite (62 problems, 87,307 items; measured
2026-10-25 against the engine without it): labels without a leader that begin beside
another point within the side margin, 1,529 → 774 (the rest lie beside the dots of less
important items, which the `map` preset lets labels cover and the rule leaves alone);
weak, unclear and misattributed labels (ADR project/benchmark-measures, label-weighted)
−2.7 %, −1.6 % and −1.4 %; 0.5 % fewer labels placed and more leaders. Prefix omission
amplifies a single loss: on `12-priority/airports-outlier-prefix` Rota's label leaves
Saipan's dot for one that covers Guam's (a less important mark, which the `map` preset
allows), Guam goes unlabeled, and the prefix ends there, at 24 labels instead of 167.
Solve times stay the same except on dense problems, where more labels run the ladder: the
2,000-label performance problem takes 3–6 % longer in Rust and about 3 % in TypeScript. On
the Europe map Luxembourg's label hangs below its dot, clear of Paris's, with 88 of 90
labels placed as before. `defaults.side_margin` equal to the margin restores the rule
without it.

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
- **A side margin whatever the own mark's place**: labels squarely beside their own mark
  lost positions to points 0.5 em away beside another side, where no reader would mistake
  them (Alpha's label right of its point in the conformance case `stubs-not-nearer`).
- **Area items' dots as points too**: their dots are not drawn on a map; Pristina lost every
  position to Kosovo's.
- **A side margin of 0.4 em** (the spacing): Luxembourg's label still passes (4.3 px against
  1 + 3.2 px).
