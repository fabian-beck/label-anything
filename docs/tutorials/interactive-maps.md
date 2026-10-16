# Interactive maps and stability

A map is re-labeled after every pan and zoom. Two things matter besides a good layout in
each frame: labels should not **jump** from one side of their point to the other while
the view moves, and when zooming in, the labels already shown should stay — the label
set should **nest**, growing as space appears.

## Warm starts

`warm_start` passes the previous frame's result. For each item, its previous box — moved
with its anchor — becomes a candidate of the new solve and is **kept first** if it is still
free; otherwise the `weights.stability` term (1.0 per em of displacement, capped at 1)
pulls the label towards it. The result reports `stats.flicker` (`moved`, `added`,
`removed`, `mean_displacement`) and each placement's `displacement` in px.

A camera moving over the 40 cities of the [priority tutorial](priority.md), first panning,
then zooming in:

```python
--8<-- "examples/tutorials/python/stability.py:frames"
```

```text
zoom 1.0: <Result placed=38/40 hard_violations=0 omitted=2> None
zoom 1.0: <Result placed=38/40 hard_violations=0 omitted=2> {'moved': 3, 'added': 0, 'removed': 0, 'mean_displacement': 2.2...}
zoom 1.3: <Result placed=39/40 hard_violations=0 omitted=1> {'moved': 14, 'added': 1, 'removed': 0, 'mean_displacement': 15.1...}
zoom 1.7: <Result placed=36/36 hard_violations=0 omitted=0> {'moved': 11, 'added': 1, 'removed': 0, 'mean_displacement': 9.6...}
zoom 2.2: <Result placed=25/25 hard_violations=0 omitted=0> {'moved': 7, 'added': 0, 'removed': 0, 'mean_displacement': 6.7...}
```

Measured as the change of each label's offset from its point between frames, the labels
move 8.6 px per frame with warm starts against 19.3 px without (the program computes
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
