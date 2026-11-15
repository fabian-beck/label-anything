# Pinned labels

With `warm_start.pin` every label keeps its box exactly, whatever its priority, and the
solve only adds labels around them: while a view is only panned, no label moves. After a
zoom, with `pin: "yield"`, the labels that sit at their items stay there, and give way
only to more important ones.

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
  `evict_lower` removes no pinned label. A label is its box with its rotation and its
  leader: a warm start without the rotation of a turned label names an upright box, which
  is another label or none.
- **The region map does not unpin a label.** The `regions` class (ADR obstacles/regions)
  is decided on a raster, whose cells lie elsewhere on the map once the view has moved: a
  name with just a quarter of its box in other countries would lose its place to a pan of
  one pixel. The warm-start box of a pinned solve is exempt from that class; no other
  hard rule is decided on a raster of vector data.
- **The greedy pass is nearly the whole solve** once a label is pinned: no local search,
  no exact search, no fans, no boundary columns, no repairs but the first rule of the
  priority repair, which removes no pinned label. All the others move labels; what a pan
  needs is places for the items that came in, and a label a newcomer evicted comes back
  beside it by that rule.
- **Priority gives way.** An item more important than a pinned label in its way waits
  until the host solves without `pin: true`. `stats.priority_inversions` counts such
  items; `stats.pinned` the pinned labels.
- **`pin: "yield"` for a view that was zoomed or turned.** The labels move with their
  items, so most can stay; but the distances between them have changed, and a label's
  box may no longer be good. The items that had a label take their boxes first, band by
  band: a label whose box no longer holds is placed anew in its turn, before any less
  important label is confirmed, and a newcomer takes what is left. A pinned label may be
  evicted like any label of lower priority, and the `regions` class applies: the map
  under a label has changed.
- **`pin: false` for a label** in the warm start: that item is warm-started, not pinned.
  Hosts say so for labels on leaders after a zoom: they were put aside for lack of room,
  which has changed.
- **Marks beyond the overscan.** In a window, a point whose mark lies beyond the working
  extent gets no label (reason `outside`) and its mark counts. A host passes the points a
  label's reach farther than the overscan, so that labels there keep off marks before
  these come in. Such a point keeps a label that still reaches into the canvas.
- **Hosts pin after a pan and after a zoom.** The Leaflet, MapLibre and sigma helpers
  compare the zoom (bearing, pitch, camera ratio and angle, the graph) with that of the
  labels shown: the same, `pin: true`; another, `pin: "yield"` with the labels on leaders
  free. They pass the points up to three times the overscan (option `pin: false`: warm
  starts alone). `LabelMemory` passes each label's rotation
  and its leader, moved with the box. The playground's world map and the map of
  Europe do the same, run no settle solve after a pinned solve, pass unrounded
  coordinates (a rounded outline has its pole elsewhere in the next view) and keep an
  item whose label still shows.
- **A name inside its area goes with its own middle.** A label moves with its item's
  anchor between solves and into the next warm start: a city's name with its dot. For a
  name inside a country that anchor would be the pole, and a zoom would shift the name
  by its distance from the pole, times the change of scale. The two maps anchor such a
  name at its own middle, a place of the map (`LabelMotion.target` takes the host's
  points before the placements' anchors). The map of Europe keeps its names when it is
  zoomed out to the whole map; "Whole map" places the first labels afresh.

## Consequences
On the two pans, no label in view moves and none is lost (one of 21,000 without the marks
beyond the overscan). In the world map, over four zoom levels and 200 solves while
panning, none of 16,000 labels in view moves or is lost, and none of 11,800 in the map
of Europe (240 pans at three zoom levels, its countries regions, 260 of the names turned;
before the region map was kept from unpinning labels, a name at the limit slid by a pixel
once in some hundred pans); browser tests hold both at zero. A pinned solve costs what the greedy pass costs:
8 ms instead of 9 ms for the 600 points in TypeScript.

On a zoom, placed anew from a warm start, 28 of the 53 names the map of Europe shows
before and after its first zoom step were elsewhere (up to 115 px), 12 of 32 at the
second, 9 of 31 zooming out. With `pin: "yield"`, drawn frame by frame: of the names that
sit at their item, 1 or 2 of 39 move at the first step (a new city's dot lies where a
capital's name was), none of 37 at the second, none of 12 at the third or zooming back
out, 4 of 39 at the step out after that (countries that have become too small for their
names). A name on a leader goes where it is better: into its country once that has room.
In the world map, a zoom out by 0.7 keeps 99 of the 105 names that stay labeled where
they were, the next one 87 of 119.

The layout now depends on the way the view came: labels placed during a pan are those of
a greedy pass, a label that was abbreviated stays abbreviated, and a more important
newcomer can be without a label next to a pinned one. A zoom, or any solve without the
pin, puts that right, and may then move labels. A pin holds only what the problem holds
still: labels sized by `priority.font_classes` change with the items of each problem, and
a hard obstacle that moves under a label unpins it. Results have a reason more
(`outside`), and counts that include the marks.

## Alternatives
- **Placing anew after a zoom**, warm-started, as the first version of this decision did:
  half of the names moved at each zoom step.
- **`pin: true` after a zoom as well**: every label that can keep its box does, also a
  less important one where a more important label, whose own box no longer holds, has
  its best place. On the map of Europe a country's name went out on a leader because a
  capital's name kept its place inside the country.
- **Giving way to every more important item**, newcomers included (the bands in one
  round): zooming out of the world map, the countries that came into view pushed the
  names shown aside.
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
