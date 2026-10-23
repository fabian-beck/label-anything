# Candidates and the degradation ladder

The engine does not move labels around continuously: it generates **candidate** positions
for every label, computes what each costs, and chooses one candidate per item so that no
hard constraint is violated, the priority is respected and the total cost is low. When an
item has no usable candidate, the **degradation ladder** generates more — shorter, wrapped,
distant, smaller — before the label is given up.

## Candidate models

`placement.models` lists the models to use (default `adjacent`, `slider`, `distant`; the
`auto` preset starts without `distant` and adds it when more than 30 % of the items have
no free adjacent position).

**`adjacent`** — 8 fixed positions around the mark: the label's corner or side midpoint
touches the mark inflated by `placement.offset` (1 px), in the direction of the position.
`position_order` ranks them, which matters through the position cost:

* `perceptual` (default): top, right, bottom, left, top-right, bottom-right, top-left,
  bottom-left;
* `cartographic` (the `map` preset, after Imhof): top-right, top-left, bottom-right,
  bottom-left, right, left, top, bottom;
* a list of position names: only those positions, in that order. Distant labels then keep
  to the same sides: only directions within 22.5° of a listed position (`["right"]` keeps
  the end labels of a line chart off the lines, ADR 0021).

**`slider`** — `slider_per_quadrant` (4) positions between each pair of neighbouring fixed
positions, sliding along the mark while touching it.

With `placement.stubs: "auto"`, an adjacent or slider position that another item's mark
comes near (closer than `stub_reach`, 0.75 em) stands `stub_length` (0.5 em) farther out
instead, where that is feasible, joined to its mark by a short **stub** at a right angle to
its side, so that a label in a crowd of points cannot be read as a neighbour's
([leaders](../tutorials/leaders.md#stubs-for-labels-in-a-crowd)). Adjacent and slider labels
are never nearer to another item's mark than to their own (`placement.own_nearest`,
[avoidance](avoidance.md#the-four-maps)).

**`internal`** — inside the mark or area, at the pole of inaccessibility and the reference
point, when the label fits with `inner_padding` (0.2 em) to spare; `placement.internal`
(`auto`, `prefer`, `allow`, `never`) decides when ([shapes](../tutorials/shapes.md#internal-labels)).

**`distant`** — away from the mark, with a leader: `distant_rings` (4) rings between
`min_distance` (1.5 em) and `max_distance` (8 em), in `distant_directions` (16) directions
(or the leader style's angles), plus free-space seeds; the `k_distant` (24) cheapest are
kept ([leaders](../tutorials/leaders.md)).

**`boundary`** — in the canvas margins along `placement.boundary.sides`, stacked or
spread, with leaders. The labels of a side form one column, aligned toward the picture;
after the search, items left without a label join it while it stays feasible.

Candidates that violate a hard constraint by themselves (a hard class, the canvas edge,
the own mark) are infeasible; candidates far more expensive than the item's best
(`prune_factor`, 4) are dropped.

## Costs

The cost of a candidate is a sum of terms, each with a weight in `weights`:

| Term | Weight (default) | |
|---|---|---|
| obstacles | `avoid.label` weights | covered area of each soft class in em² (font size²): what the label hides, whatever its size |
| buffer | `avoid.buffer` | covered area of the ring around the label / ring area |
| leader | `leader` (1.0), `leader_length` (0.25 per em), `bends` (0.3 per bend), `avoid.leader` (per em of leader over a class) | a leader costs; longer and bent ones more, and those running over soft classes |
| position | `position` (0.6) | rank of the position in `position_order` / number of positions |
| distance | `distance` (0.3) | gap between label and mark, in em |
| shape | `shape` (0.5) | wrapped lines, alternatives, truncation, shrinking, relaxed overlap |
| edge | `edge` (0.2) | proximity to the label area's edge (1 at the edge, 0 at ≥ 1 em) |
| ambiguity | `ambiguity` (1.0) | the label is closer to another item's shape than to its own |
| contrast | `contrast` (0.5) | with raster backgrounds: how much the backdrop's luma varies under the label (4 × its variance, per em²): 1 per em² for a label half on black, half on white, 0 on any uniform backdrop |
| stability | `stability` (1.0) | displacement from the `warm_start` box: 1 per em up to 1 em, then 1/4 per em up to 5 em |
| lookahead | `lookahead` (0.3), `starve` (2.0) | how many candidates of unplaced items the choice would take away |

Costs of overlaps between soft classes of labels and leaders (only when you make
`labels` or `leaders` soft) are added the same way. With `output.cost_breakdown`, the
result reports each placed label's cost per term.

## The degradation ladder

`degrade` lists what to try, in order, for an item without a usable candidate:

| Step | |
|---|---|
| `alternatives` | the label's `alternatives` (shorter texts), in order |
| `wrap` | the text in 2 … `degrade_options.wrap_max_lines` (3) balanced lines, broken between words, no line narrower than 1.5 em |
| `truncate` | truncation per the label's `truncate` setting |
| `distant` | distant candidates with leaders, also when `distant` is not in `models` |
| `boundary` | boundary labels in the margins |
| `evict_lower` | remove placed labels of strictly lower priority that conflict, and re-queue them |
| `shrink:f` | the font scaled by f, f², … down to `degrade_options.min_scale` (0.7) |
| `soft_overlap` | turn the hard classes of `avoid.relaxable` into weight `soft_overlap_weight` (10) |
| `omit` | give up: the label is reported with its reason |

The default ladder is `["alternatives", "wrap", "distant", "evict_lower", "shrink:0.85",
"soft_overlap", "omit"]`. Each step adds to the label's shape cost, so a degraded label
wins only when nothing better is free. The result lists the steps tried per label
(`degrade_steps`) and counts degraded labels per kind (`stats.degraded`).

`boundary` is not in the default ladder: a label that fits nowhere near its point would
get a leader across half the picture. Add it where margin labels are intended (or use the
`boundary` model, as the `illustration` preset does). Shorten the ladder to forbid what
your output cannot show: without `shrink`, all labels keep their size; `["omit"]` alone
keeps every label as specified or omits it.

## Fan labels

Where anchors crowd — the ends of a bundle of lines, a cluster of points — there is
seldom room for each label next to its mark. After the search, the engine therefore
stacks the labels of a crowd in a **column** beside it, in the crowd's order, each with
its own leader fanning out of the crowd (`model: "fan"` in the result):

* A crowd is the items whose anchors lie within about a label height vertically and an
  em horizontally of each other (up to 24 items). The column stands on a side the items'
  `position_order` allows, far enough out that no leader is steeper than 45°, and its
  labels are stacked around the anchors' heights like boundary labels.
* With `placement.fan: "auto"` (default), only crowds with items the search left without
  a label get a column, and only when the column places more labels: labels in its way
  move into it, labels that cannot stay where they are. `"always"` gives every crowd of
  two or more items a column; `"off"` none. Columns keep to the label budgets
  (`priority.budget`): the least important items stay without a label first.
* Fan leaders follow the leader style (straight, `orthogonal` or `elbow`) and keep every
  hard rule, except that they may pass close to the marks of their own crowd (they must
  not cross them); they are at most `leaders.max_length` long. The `angles` style, whose
  leaders keep to the allowed rays, gets no columns, nor do items that may not have
  leaders at all (no `distant` or `boundary` in their models or the ladder).

Columns work best at the crowded ends of line charts and in tight point clusters; in a
two-dimensional crowd surrounded by other marks, the leaders would cross those marks and
no column forms (ADR 0022). (A group's label is different: one label with a leader to
each member of the group.)

## How the solver chooses

The greedy pass processes items in priority order, band by band (items of equal priority
key form a band, in which the most constrained item goes first) and takes each item's
cheapest free candidate, counting what it would take away from items still waiting; after
a band, its unplaced items run the ladder. Local search then relocates, swaps and
re-inserts labels, accepting changes that keep every hard constraint and never make the
priority outcome worse. An exact branch-and-bound search runs for small problems with a
large budget. Crowds with items left without a label then get [fan labels](#fan-labels).
With `strict` omission, a priority repair then gives every omitted item a
position that only lower-priority labels hold (those labels are tried again), so no
label is missing in favour of a less important one; an item kept out by one more
important label may also move that label to another of its positions, when at most one
less important label gives way ([ADR 0049](../adr/0049-move-one-label-aside.md)). Finally, a verification pass
re-checks every hard constraint exactly. The [explainer](../explainer.md) steps through
these phases on a real solve.
[The solver](solver.md) describes budgets and determinism; the
[specification](../reference/spec.md#10-solver) the algorithms.
