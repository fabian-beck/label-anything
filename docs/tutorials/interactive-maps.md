# Interactive maps and stability

A map is re-labeled after every pan and zoom. Two things matter besides a good layout in
each frame: labels should not **jump** from one side of their point to the other while
the view moves, and when zooming in, the labels already shown should stay — the label
set should **nest**, growing as space appears.

## Warm starts

`warm_start` passes the previous frame's result, as it is. Every placed label in a result
reports the `anchor` of its item; the next solve moves each previous box by the distance its
anchor moved, makes it a candidate and **keeps it first** if it is still free. Otherwise
the `weights.stability` term (1.0 per em of displacement, capped at 1) pulls the label
towards it. A label the previous solve had to shrink, wrap or shorten keeps its box the
same way while it is free, unless the full label fits again ([ADR 0025](../adr/0025-warm-starts-follow-anchors.md)).
Boxes without `anchor` (made by the host) are used where they are. The result reports
`stats.flicker` (`moved`, `added`, `removed`, `mean_displacement`) and each placement's
`displacement` in px.

A camera moving over the 40 cities of the [priority tutorial](priority.md), first panning,
then zooming in:

```python
--8<-- "examples/tutorials/python/stability.py:frames"
```

```text
zoom 1.0: <Result placed=34/40 hard_violations=0 omitted=6> None
zoom 1.0: <Result placed=35/40 hard_violations=0 omitted=5> {'moved': 0, 'added': 1, 'removed': 0, 'mean_displacement': 0.0}
zoom 1.3: <Result placed=40/40 hard_violations=0 omitted=0> {'moved': 12, 'added': 5, 'removed': 0, 'mean_displacement': 9.8}
zoom 1.7: <Result placed=36/36 hard_violations=0 omitted=0> {'moved': 11, 'added': 0, 'removed': 0, 'mean_displacement': 12.6}
zoom 2.2: <Result placed=25/25 hard_violations=0 omitted=0> {'moved': 6, 'added': 0, 'removed': 0, 'mean_displacement': 7.5}
```

Measured as the change of each label's offset from its point between frames, the labels
move 7.6 px per frame with warm starts against 12.5 px without (the program computes
both). The remaining moves are labels whose old place collides with a label that appeared,
or that gain a better position as space opens up.

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
30 frames; labels move 1.1 px per frame warm-started, 4.9 px from scratch
```

The [benchmark](../benchmark.md)'s stability sequences (scenario 11) measure this on
larger cases: the Les Misérables graph (77 nodes) under a force simulation from its start
and with one node dragged through the settled layout, and a camera path over 1,000
airports. Jumps are labels whose offset from their point changes by more than 1 em
between frames:

| sequence | | mean move | side changes | jumps |
|---|---|---|---|---|
| force layout running, 61 frames | from scratch | 4.9 px | 12 % | 11 % |
| | warm-started | 2.9 px | 8 % | 6 % |
| node dragged, 41 frames | from scratch | 7.5 px | 18 % | 17 % |
| | warm-started | 3.0 px | 9 % | 6 % |
| pan and zoom, 30 frames | from scratch | 9.1 px | 32 % | 28 % |
| | warm-started | 3.0 px | 12 % | 8 % |

For animation:

* **Re-solve every few ticks** (or ~10 times per second) rather than on every frame, and
  let the labels follow their nodes in between: draw each box moved by its node's
  movement since the solve.
* **Use a short time budget.** `solver.time_budget_ms: 10` makes a frame of the 77-node
  graph take about 12 ms natively, 18 ms with `@label-anything/wasm` and 22 ms with
  `@label-anything/core` in Node (31 and 42 ms with the default budget), and the labels
  move about as little (6.6 % jumps instead of 6.0 %).
* **Solve once more without `warm_start` when the layout has settled** if you want the
  best static layout: warm-started labels that had to shrink keep that size while their
  place stays free.

## Leaflet

`labelLayer` from `@label-anything/extras/leaflet` is a Leaflet layer that collects the
visible points in container pixels, solves, draws the labels in an SVG pane, and after
every move re-solves warm-started from the previous result.

```js
--8<-- "examples/tutorials/js/browser/leaflet.mjs:leaflet"
```

The icon mark matches Leaflet's default pin (25 × 41 px, tip at the bottom center): labels
avoid the whole pin. Other layers' geometry can be passed as `obstacles`.

## MapLibre GL and Mapbox GL

`labelMapLibre` draws labels in an SVG overlay that follows the map while it moves and
re-solves on `moveend`. `avoidLayers` turns the rendered features of style layers into
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
