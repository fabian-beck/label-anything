# Interactive maps and stability

A map is re-labeled after every pan and zoom. Two things matter besides a good layout in
each frame: labels should not **jump** from one side of their point to the other while
the view moves, and when zooming in, the labels already shown should stay — the label
set should **nest**, growing as space appears.

## Warm starts

`warm_start` passes the previous frame's result, as it is. Every placed label in a result
reports the `anchor` of its item; the next solve moves each previous box (and its leader)
by the distance its anchor moved, makes it a candidate and **keeps it first** if it is
still free. A box that something now overlaps slightly **slides** along its mark instead,
by the smallest of a few steps (0.05 to 0.8 em) that frees it. Otherwise the
`weights.stability` term pulls the label towards its old place: 1.0 per em of
displacement up to 1 em, then 0.25 per em up to 5 em, so a label that has to move goes
to a near place rather than to the other side of its point
([ADR motion/warm-starts](../adr/motion/warm-starts.md)). A label the previous solve
had to shrink, wrap or shorten keeps its box the same way while it is free, unless the
full label fits again ([ADR motion/warm-starts](../adr/motion/warm-starts.md)). Boxes
without `anchor` (made by the host) are used where they are. The result reports
`stats.flicker` (`moved`, `added`, `removed`, `mean_displacement`) and each placement's
`displacement` in px.

A camera moving over the 40 cities of the [priority tutorial](priority.md), first panning,
then zooming in:

```python
--8<-- "examples/tutorials/python/stability.py:frames"
```

```text
zoom 1.0: <Result placed=35/40 hard_violations=0 omitted=5> None
zoom 1.0: <Result placed=35/40 hard_violations=0 omitted=5> {'moved': 7, 'added': 0, 'removed': 0, 'mean_displacement': 13.5}
zoom 1.3: <Result placed=39/40 hard_violations=0 omitted=1> {'moved': 14, 'added': 4, 'removed': 0, 'mean_displacement': 16.9}
zoom 1.7: <Result placed=36/36 hard_violations=0 omitted=0> {'moved': 15, 'added': 1, 'removed': 0, 'mean_displacement': 12.3}
zoom 2.2: <Result placed=25/25 hard_violations=0 omitted=0> {'moved': 7, 'added': 0, 'removed': 0, 'mean_displacement': 8.4}
```

Measured as the change of each label's offset from its point between frames, the labels
move 13.1 px per frame with warm starts against 21.1 px without (the program computes
both). The remaining moves are labels whose old place collides with a label that appeared,
or that gain a better position as space opens up — here mostly the few that need a leader
at the first zoom levels: 40 cities at 14 px leave little room once labels keep their
margin (`defaults.margin`, 0.2 em). A smaller margin trades spacing for steadier labels
(0.1 em: 6.9 px warm-started; 0: 4.5 px).

## Nesting

Labels nest when the priority is the same in every frame — stable `ids`, the same
priority values, `strict` omission: a label shown at one zoom level is more important than
every label omitted there, and zooming in only adds space.

```python
--8<-- "examples/tutorials/python/stability.py:nesting"
```

Use a priority that does not depend on the view (population, rank, a category), not one
computed from the current screen positions (`outlierness`, `centrality` change as you
pan).

In a dense region the priority alone is not enough: if every dot kept every other label
away, a big city in a cluster of small towns could be left without a label while the
towns at the cluster's edge kept theirs. So the helpers, given a `priority`, let
important labels cover the dots of less important items, and the towns under them make
way instead (`avoid: {label: {lower_items: 10}, leader: {lower_items: 2.5}}`, as in the
`map` preset; pass `avoid: {label: {lower_items: "hard"}}` to keep every dot clear;
[important labels over minor marks](priority.md#important-labels-over-minor-marks)).

## Moving points

The same works when the points move on their own: a force-directed graph layout that is
still running, a node the user drags, animated data. Solve the frames with the previous
result as `warm_start`; every label follows its point and moves on only when its place
is taken (by a label, or by a node that moved into it), leaves the canvas, or a clearly
better place opens up. A d3-force layout, re-solved every 4th tick:

```js
--8<-- "examples/tutorials/js/force.mjs:force"
```

```text
30 frames; labels move 0.7 px per frame warm-started, 5.0 px from scratch
```

The [benchmark](../project/benchmark.md)'s stability sequences (scenario 11) measure this on
larger cases: the Les Misérables graph (77 nodes) under a force simulation from its start
and with one node dragged through the settled layout, and a camera path over 1,000
airports. Jumps are labels whose offset from their point changes by more than 1 em
between frames:

| sequence | | mean move | side changes | jumps |
|---|---|---|---|---|
| force layout running, 61 frames | from scratch | 5.7 px | 13.1 % | 13.1 % |
| | warm-started | 2.6 px | 7.4 % | 5.1 % |
| node dragged, 41 frames | from scratch | 8.7 px | 20.5 % | 19.8 % |
| | warm-started | 2.3 px | 7.1 % | 4.8 % |
| pan and zoom, 30 frames | from scratch | 9.8 px | 32.2 % | 29.4 % |
| | warm-started | 3.4 px | 12.5 % | 9.1 % |

For animation:

* **Re-solve every few ticks** (or ~10 times per second) rather than on every frame, and
  draw the labels with smooth transitions in between (next section).
* **Use a short time budget.** `solver.time_budget_ms: 10` makes a frame of the 77-node
  graph take about 12 ms natively, 18 ms with `@label-anything/wasm` and 22 ms with
  `@label-anything/core` in Node (31 and 42 ms with the default budget), and the labels
  move about as little (6.1 % jumps instead of 5.5 %).
* **Solve once more with a lower `weights.stability` when the layout has come to rest**:
  warm-started labels keep places that a fresh solve would improve on (labels that had
  to shrink keep that size while their place stays free). With `weights: { stability:
  0.3 }` and the last result as `warm_start`, a few labels move to clearly better places
  (4 or 5 of the 77 on the graph); without `warm_start`, a third of them would move.

### Smooth transitions

Warm starts keep most labels in place, but each solve still moves some and adds or
removes others; about half of the labels that disappear come back a solve or two later,
and a label that moved often moves again soon. Drawn as they come, these changes jump and
blink. `LabelMotion` from `@label-anything/extras` draws the results calmly:

* a shown label that the solver moved stays where it is until its new place has held for
  `moveDelay` (500 ms), then moves once; it moves at once when a label at its new place
  needs the room or it covers another item's point (a node being dragged);
* a label that leaves the results stays for `holdTime` (500 ms), and a new one waits
  `appearDelay` (250 ms) and shows only if it is still placed: labels that come and go
  within a few solves neither blink nor flash;
* short moves glide (a critically damped spring, `duration` 300 ms: no overshoot, and a
  move that changes direction mid-way bends into the new one); moves further than two
  label heights (`jump`) fade out and in at the new place instead of sweeping across the
  drawing;
* labels follow their points between solves, and where two meet, the less important
  makes way (`collisions`); labels in a column (fan and boundary labels) stay with their
  column, and their leaders follow the points.

Give it every result, and draw what it returns on every frame:

```js
--8<-- "examples/tutorials/js/browser/force.mjs:force-motion"
```

When the simulation ends, `settle` solves once more with a lower `weights.stability`, and
the few labels that a better place awaits move there half a second later (see the tips
above).

`frame()` returns the placements as they are drawn at that moment (the text scaled with a
box that grows or shrinks, leaders attached to the gliding box) and the opacities of the
labels and leaders that fade; `renderLabels` draws them, or any renderer reads them. The
Leaflet, MapLibre and sigma.js helpers below do this after every solve (option
`transition`, in ms; 0 draws each solve as it is; [ADR motion/label-motion](../adr/motion/label-motion.md)). The
[playground](../try.md) has the options in its Motion section.

## Leaflet

`labelLayer` from `@label-anything/extras/leaflet` is a Leaflet layer that collects the
visible points in container pixels, solves, draws the labels in an SVG pane, and after
every move re-solves warm-started from the previous result; the labels move to their
new places and fade in and out calmly (above).

```js
--8<-- "examples/tutorials/js/browser/leaflet.mjs:leaflet"
```

The icon mark matches Leaflet's default pin (25 × 41 px, tip at the bottom center): labels
avoid the whole pin. Other layers' geometry can be passed as `obstacles`.

## MapLibre GL and Mapbox GL

`labelMapLibre` draws labels in an SVG overlay that follows the map while it moves and
re-solves on `moveend`, with the same transitions. `avoidLayers` turns the rendered features of style layers into
obstacle classes named after the layers.

```js
--8<-- "examples/tutorials/js/browser/maplibre.mjs:maplibre"
```

## Keeping it fast

* Lower `solver.time_budget_ms` for interactive use; the solve is deterministic for a
  given budget ([time budget](../concepts/solver.md)).
* The helpers abort an outdated solve when a new one starts and apply only the newest
  result; for large maps, pass a Web Worker engine (`createWorkerEngine`) so the page
  stays responsive ([JavaScript](../getting-started/javascript.md#web-workers)).
* `@label-anything/wasm` runs the Rust core in the page, the same API as the TypeScript
  engine ([WebAssembly](../bindings/wasm.md)).
