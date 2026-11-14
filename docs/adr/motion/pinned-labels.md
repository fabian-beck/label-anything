# Pinned labels

With `warm_start.pin` every label keeps its box exactly, whatever its priority, and the
solve only adds labels around them: while a view is only panned, no label moves.

## Context
A pan changes nothing about a map but the part in view: every label could stay where it
is. Warm starts prefer that and do not promise it (ADR motion/warm-starts). In a window
(ADR motion/windows) labels still moved while the map was panned, for reasons that have
nothing to do with the pan:

- a more important item that comes in takes its place first, and a label in its way
  moves or goes;
- the local search starts at a temperature that follows the cost differences it finds, so
  under a short budget it moves labels it does not bring back;
- a point that comes in at the edge of the overscan can lie under a label placed before
  the engine knew of it.

On a pan over 600 points in a window (160 steps of 6 px, warm-started), 1,265 of about
8,700 labels in view changed their place between two steps; with 1,500 points, 1,538 of
21,000. In the playground's world map at zoom 6, 120 of 2,312.

## Decision
- **`warm_start.pin`**: before the first band, every item takes its warm-start box in
  total order, where the box is statically feasible, free of the labels pinned before it
  and within the label budgets: the level-0 candidate, else that of a ladder variant, so
  an abbreviated or wrapped label stays as it is. The bands then run for the other items;
  `evict_lower` removes no pinned label.
- **The greedy pass is the whole solve** once a label is pinned: no local search, no
  exact search, no fans, no boundary columns, no repairs. All of them move labels; what a
  pan needs is places for the items that came in.
- **Priority gives way.** An item more important than a pinned label in its way waits
  until the host solves without the pin, as after a zoom. `stats.priority_inversions`
  counts such items; `stats.pinned` the pinned labels.
- **Marks beyond the overscan.** In a window, a point whose mark lies beyond the working
  extent gets no label (reason `outside`) and its mark counts. A host passes the points a
  label's reach farther than the overscan, so that labels there keep off marks before
  these come in. Such a point keeps a label that still reaches into the canvas.
- **Hosts pin after a pan, not after a zoom.** The Leaflet, MapLibre and sigma helpers
  compare the zoom (bearing, pitch, camera ratio and angle, the graph) with that of the
  labels shown, pin when it is the same, and pass the points up to three times the
  overscan (`pin: false`: warm starts alone). The playground's world map and the map of
  Europe do the same, run no settle solve after a pan, pass unrounded coordinates (a
  rounded outline has its pole elsewhere in the next view) and keep an item whose label
  still shows.

## Consequences
On the two pans, no label in view moves and none is lost (one of 21,000 without the marks
beyond the overscan). In the world map, over four zoom levels and 200 solves while
panning, none of 16,000 labels in view moves or is lost, and none of 7,000 in the map of
Europe; browser tests hold both at zero. A pinned solve costs what the greedy pass costs:
8 ms instead of 9 ms for the 600 points in TypeScript.

The layout now depends on the way the view came: labels placed during a pan are those of
a greedy pass, a label that was abbreviated stays abbreviated, and a more important
newcomer can be without a label next to a pinned one. A zoom, or any solve without the
pin, puts that right, and may then move labels. A pin holds only what the problem holds
still: labels sized by `priority.font_classes` change with the items of each problem, and
a hard obstacle that moves under a label unpins it. Results have a reason more
(`outside`), and counts that include the marks.

## Alternatives
- **A high `weights.stability`**: the search's temperature rises with it, and a more
  important newcomer still takes its place first.
- **The pin as a rule inside every pass** (the search, the repairs, fans and columns each
  skipping pinned labels): many guards for passes that have little left to do.
- **Pinned labels that a more important item may remove**: the removed label comes back
  elsewhere at the next solve, a move in two steps.
- **Holding labels in the display**: the result is laid out for the labels as moved, so
  held ones overlap it (ADR motion/label-motion).
- **Solving only the new items**, the labels shown as obstacles: every host would have to
  rebuild the rules between labels, marks and leaders.
- **A wider overscan instead of marks**: 2.2 times the items of the view instead of 1.75.
