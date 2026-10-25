# Leaders

Leaders keep 0.4 em from other marks and from each other, diverge where they start
together, stay on the sides an item's position order allows, and bend at most once.

## Context
Renderings of the benchmark showed clutter that broke no hard rule: leaders passing within
a pixel or two of each other, which reads as a crossing, and leaders running through other
data points, which seem to point at them. The objective is lexicographic, priority first
and cost second, so a soft cost never prevents a placement: what must not happen has to be
a hard rule.

## Decision
- **Clearance from marks** (`avoid.leader.items` hard): every segment stays
  `leaders.clearance` (0.4 em) from the marks of other items. Exempt are the marks of the
  item's own group and marks that contain its anchor. A mark closer than the clearance to
  the leader's start that touches the bounding box of the leader's own mark (for a group
  label's leader to a member, the member's) must only not be crossed: where marks touch,
  no leader could start clear of both.
- **Spacing between leaders** (`avoid.leader.leaders` hard): two leaders conflict when
  they cross or when a vertex of one comes within the clearance of the other. A leader's
  start is exempt when the other starts within the clearance, since leaders of
  neighbouring marks start close together.
- **Diverging starts**: distant leaders that start within one font size of each other must
  differ in direction by `leaders.min_angle_between` (10°).
- **Leaving a crowd**: fan and boundary leaders (ADR placement/columns) ignore marks that
  contain their start and must only not cross marks closer than the clearance to it; they
  run in parallel by design and are exempt from the angle rule.
- **Position order**: when an item lists fewer than the 8 positions, its distant
  candidates keep within 22.5° of the listed directions, so the end labels of a line chart
  restricted to `right` never go left across the lines.
- **One bend**: orthogonal leaders to boundary and fan labels are `po` (parallel to the
  side, then straight into the label), the shape Barth et al. (2019) recommend; never the
  twice-bent `opo`.

## Consequences
On the benchmark, near crossings fell from 1,424 to 1 and leaders touching other marks
from 25,505 to 0. Labels whose only positions needed a leader through a crowd are now
omitted and reported: with the ladder's change (ADR placement/ladder), 2.3 % fewer labels
over the suite. Restricted to the right, a line chart loses some end labels, which fan
columns win back (ADR placement/columns).

Before touching marks were exempt, a mark that touched another could get no label at all:
no position beside it was clearly its own (ADR placement/margin), and every leader started
within the clearance of the other mark. The scatterplot of the design brief's example
(§6.2) begins with such a point, and with prefix omission it placed none of its 90 labels.
Exempt, it places 82. Of 49 static benchmark problems solved within their time guards, 17
change, 10 with more labels and 2 with fewer, 0.5 % more labels in all (the 62 lines of the
life-expectancy chart: 41 labels instead of 37). On the economies chart of the home page,
Norway's bubble overlaps Ireland's; its label now sits on a leader.

## Alternatives
- **A leader–mark rule that the ladder may relax**: 0.9 % more labels, but 11,170 touches
  and 40 near crossings came back.
- **A clearance of 3 px**: 0.6 % more labels, with near crossings and parallel pairs left.
- **Exempting every mark near the start**: leaders would pass close to marks that do not
  touch their own, which seem to point at them.
- **Ties beside touching marks** for labels without a leader: such a label reads as
  either mark's (ADR placement/margin).
- **A soft cost for distant labels on unlisted sides**: soft costs never prevent a
  placement; ±45° per listed position would allow straight up and down, over the lines.
- **`opo` leaders**: a second bend per leader, for a shape the study does not recommend.
