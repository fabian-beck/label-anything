# Leaders and leader styles

When the space next to a feature is taken, a label can sit at a distance and point back
with a **leader**. Label Anything generates such *distant* candidates on rings around the
feature, draws the leader in one of five styles, and guarantees that leaders never cross
each other, never pass through labels and keep clear of other marks and other leaders —
a leader that grazes a dot seems to point at it, and two leaders closer than a few pixels
read as a crossing. With *boundary* labels, the labels line up in the margins instead.

All examples label the same dense cluster of twelve asteroids among 60 unlabeled dots
(`points`, soft obstacles). Only the `leaders` line differs between the problems:

```json
--8<-- "examples/tutorials/problems/leaders-straight.json:1:6"
      ...
```

`placement.models` enables the candidate models: `adjacent` (next to the mark) and
`distant` (at a distance, with a leader). `max_distance` bounds how far a label may move
(here 9 em, 108 px at the default 12 px font).

## The five styles

=== "straight"

    ```json
    --8<-- "examples/tutorials/problems/leaders-straight.json:5:5"
    ```

    One segment from the mark to the nearest point of the label box (`port: "nearest"`).

    ![Straight leaders](../assets/gallery/leaders-straight.png)

=== "angles"

    ```json
    --8<-- "examples/tutorials/problems/leaders-angles.json:5:5"
    ```

    Straight, but only in the listed directions (degrees, 0 = right, 90 = up): distant
    candidates are generated along these rays.

    ![Leaders at multiples of 45°](../assets/gallery/leaders-angles.png)

=== "orthogonal"

    ```json
    --8<-- "examples/tutorials/problems/leaders-orthogonal.json:5:5"
    ```

    Horizontal and vertical segments with at most one bend, also to labels in the
    margins (along the side, then into the label); fewer bends first.

    ![Orthogonal leaders](../assets/gallery/leaders-orthogonal.png)

=== "elbow"

    ```json
    --8<-- "examples/tutorials/problems/leaders-elbow.json:5:5"
    ```

    A first segment at one of the `angles`, then horizontal into the middle of the
    label's side (`port: "side-center"`) — the classic callout of illustrations.

    ![Elbow leaders](../assets/gallery/leaders-elbow.png)

=== "curved"

    ```json
    --8<-- "examples/tutorials/problems/leaders-curved.json:5:5"
    ```

    A quadratic Bézier curve; the result reports its control points in `leader.curve`
    and a flattened polyline in `leader.points` (used for the collision tests).

    ![Curved leaders](../assets/gallery/leaders-curved.png)

A red cross marks a label that was omitted. In a cluster this dense, a leader leaving
an inner asteroid passes close to its neighbours; such leaders are not generated, so up
to three asteroids find no candidate free of the other labels, marks and leaders — none
with curved leaders, which bend around them, the most with orthogonal ones, whose first
segments run in four directions only. With straight and elbow leaders, the labels on the
cluster's right stand in a column: after the search, a crowd with labels left over gets
a column of [fan labels](../concepts/candidates.md#fan-labels) beside it, in the crowd's
order, when that places more labels (`placement.fan`; not with `angles`, whose leaders
keep to their rays). Each omitted placement says why —
`reason: "omitted_by_priority"` (all items have the same priority here, so it lost to
items processed before it) or `"no_feasible_candidate"`, `blocking` lists the classes
that rejected its candidates and `blocked_by` the labels in its way. See
[priority and omission](priority.md).

## Leader options

| Option | Default | |
|---|---|---|
| `style` | `"straight"` | `straight`, `angles`, `orthogonal`, `elbow`, `curved` |
| `angles` | multiples of 45° | allowed directions for `angles` and the first segment of `elbow` |
| `port` | `"nearest"` | where the leader meets the label: `nearest` point, `side-center`, or `baseline` (the end of an underline below the first text line, reported as `leader.underline`) |
| `attach` | `"auto"` | where it leaves the feature: the mark's `boundary`, its `center`, or an icon's `tip` (`auto`: tip for icons, else boundary) |
| `anchor_gap` | 1.5 px | gap between the mark and the leader's start |
| `min_length` / `max_length` | 6 px / 10 em | shorter leaders are dropped (the label counts as adjacent); longer ones are not generated (fan labels included; boundary labels excepted) |
| `clearance` | 0.4 em | distance from other items' marks and from other leaders (except where two leaders of neighbouring marks start) |
| `min_angle_between` | 10° | distant leaders starting within 1 em of each other diverge at least this much |
| `width` | 1 px | stroke width for the collision tests |

Where distant labels go is set in `placement`: `min_distance` / `max_distance` (1.5 em /
8 em), `distant_rings` (4) and `distant_directions` (16, for straight leaders),
`free_space_seeds` (also try the centres of empty regions) and `k_distant` (candidates
kept per item, 24).

What leaders may cross is a separate map, `avoid.leader`: by default other leaders
(crossings and approaches closer than `clearance`), labels and other items' marks are
hard, everything else costs 0.2 per em of leader length over it (ink 0.05).
[Avoidance](../concepts/avoidance.md) has the details.

## Boundary labels

Technical illustrations and some charts put the labels into the margins and connect them
with leaders. The `boundary` model stacks them along the chosen sides, as close to their
anchors' heights as possible (`align: "stack"`) or evenly spread (`"spread"`), and assigns
items to slots so that the total leader length is minimal — which also keeps straight
leaders from crossing. The labels of a side form one column, aligned on its side facing
the picture, where every leader ends. After the search, items left without a label join
their side's column while it stays feasible (a label in the way moves into the column
too), so that crowded line ends get a whole column
([ADR 0030](../adr/0030-boundary-columns.md)).

```json
--8<-- "examples/tutorials/problems/leaders-boundary.json:1:5"
```

![Boundary labels on both sides](../assets/gallery/leaders-boundary.png)

`placement.boundary` also has `gap` (between stacked labels, 2 px) and `margin` (distance
from the canvas edge, 4 px). The `illustration` preset combines boundary and distant labels
with elbow leaders ([presets](../reference/presets.md)). Boundary is also a step of the
degradation ladder that you can add to `degrade`; it is not in the default ladder, because
a label that fits nowhere else would get a leader across the picture
([candidates](../concepts/candidates.md#the-degradation-ladder)).

## In Python

```python
--8<-- "examples/tutorials/python/leaders.py:styles"
```

```python
--8<-- "examples/tutorials/python/leaders.py:boundary"
```

Each placement's `leader` has the polyline from the feature to the label (`points`), its
`style`, the `port` on the label, and for curved leaders the Bézier control points:

```python
--8<-- "examples/tutorials/python/leaders.py:read"
```

The program checks that each Python call gives the same placements as its JSON problem.
