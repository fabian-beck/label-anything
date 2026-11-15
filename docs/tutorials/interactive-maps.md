# Interactive maps and stability

A map is labeled again after every pan and zoom. Besides a good layout in each frame,
three things matter. While the map is only **panned**, no label should move at all: the
map is the same, only another part of it shows. A label at the **border** of the view
should stay where it is and be cut there, not be pushed inside as its point comes to the
edge: whoever wants to read it pans a little. And zooming in should keep the labels
already shown: the set of labels should **nest**, growing as space appears.

## Warm starts

Pass the previous result as `warm_start`. Each label then keeps its place, moving with its
point, while the place is free. A label whose place is taken first slides a little along
its mark. Only if that fails does it move on, and then to a nearby place rather than to the
other side of its point: the `weights.stability` cost grows with the distance
([ADR motion/warm-starts](../adr/motion/warm-starts.md) has the rules).

## The view is a window

A canvas keeps its labels inside: right for a chart, wrong for a view that moves. A label
would change sides when its point comes near the edge, and a point that leaves the view
would take its label along while half of it still shows. `canvas.overscan` makes the canvas
a **window** on a larger drawing ([ADR motion/windows](../adr/motion/windows.md)):

* labels are placed up to `overscan` beyond the view as in it, about a label's width;
  they cross its edges and are cut there by whatever draws them (an SVG or a canvas does
  that by itself);
* pass the points farther than that, three times the overscan say: those beyond the
  overscan are **marks only** (reason `outside`). The labels in the overscan keep off
  them, so that none has to make way when they come in. Pass areas and lines whole: an
  area is labeled where it shows, and a [street](#street-names) on its longest piece in
  the view;
* `canvas.region`, if the drawing has bounds of its own (a map that ends somewhere),
  gives them in view coordinates: labels stay on the map, however far it reaches beyond
  the view.

## A pan moves no label

A warm start prefers the previous places; `warm_start.pin` keeps them
([ADR motion/pinned-labels](../adr/motion/pinned-labels.md)). Every label that is still
allowed where it is stays there exactly, whatever its priority, and the solve only adds
labels around them, where the view has moved on. Pin when the view was only panned since
the previous result, not after a zoom: then the labels have to be placed anew, and the
warm start alone keeps them close.

A camera over the 40 cities of the [priority tutorial](priority.md) pans, zooms in twice,
pans and zooms in again:

```python
--8<-- "examples/tutorials/python/stability.py:frames"
```

```text
zoom 1.0: <Result placed=34/40 hard_violations=0 omitted=6> None
zoom 1.0: <Result placed=34/40 hard_violations=0 omitted=6> {'moved': 0, 'added': 0, 'removed': 0, 'mean_displacement': 0.0}
zoom 1.3: <Result placed=39/40 hard_violations=0 omitted=1> {'moved': 10, 'added': 5, 'removed': 0, 'mean_displacement': 6.1}
zoom 1.7: <Result placed=40/40 hard_violations=0 omitted=0> {'moved': 1, 'added': 1, 'removed': 0, 'mean_displacement': 1.7}
zoom 1.7: <Result placed=40/40 hard_violations=0 omitted=0> {'moved': 0, 'added': 0, 'removed': 0, 'mean_displacement': 0.0}
zoom 2.2: <Result placed=38/40 hard_violations=0 omitted=2> {'moved': 1, 'added': 0, 'removed': 2, 'mean_displacement': 0.6}
```

`stats.flicker` counts the labels moved, added and removed since the previous frame; each
placement reports its `displacement`. The counts include the labels in the overscan and
the cities that are marks only (the two without a label at zoom 2.2 have left the
overscan). The two frames after a pan are pinned: nothing moved. Over the zooms, measured
by how much each label's offset from its point changes, labels move 1.6 px per frame with
warm starts and 8.6 px without. Those moves come from labels whose place a newly shown
label takes, or that find a better place as space opens: here mostly at the first zoom
step, where five more labels fit, as 40 cities at 14 px leave little room once labels keep
their margin from other cities and twice that from each other. A smaller margin
(`defaults.margin`) trades spacing for steadier labels.

On a pan in steps of 6 px, the same cities pinned, warm-started in a window, and with
every label kept inside the view:

```python
--8<-- "examples/tutorials/python/stability.py:border"
```

```text
pinned: of 307 labels in view, 0 moved and 0 went
window: of 307 labels in view, 0 moved and 0 went
contained: of 310 labels in view, 8 moved and 3 went
```

Kept inside the view, eight labels change their place beside their point as it comes to
the border, and three go while still in view, with their points. In the window none
does on this small map; on a dense one the warm start alone still moves labels, and the
pin does not ([ADR motion/pinned-labels](../adr/motion/pinned-labels.md) has the
numbers).

A pin has a price. An item that is more important than a pinned label in its way waits
without a label until the next solve without the pin (`stats.priority_inversions` counts
them), and what a pan adds is placed by the greedy pass alone. And it holds only what the
problem holds still: give every label its size yourself rather than through
`priority.font_classes`, which ranks the items of each problem, and pass the same
unrounded outlines in every view.

## Nesting

Labels nest when the priority is the same in every frame (stable `ids`, the same priority
values, `strict` omission): a label shown at one zoom level is more important than every
label omitted there, and zooming in only adds space.

```python
--8<-- "examples/tutorials/python/stability.py:nesting"
```

Use a priority that does not depend on the view (population, rank, a category), not one
computed from the positions on screen (`outlierness` and `centrality` change as you pan).
In a dense region, also let important labels cover the dots of less important places
([important labels over minor marks](priority.md#important-labels-over-minor-marks)); the
map helpers below do that whenever you give them a priority.

## Street names

Streets and rivers are items with a `line` anchor, like the
[edges of a graph](node-link.md#edge-labels): the name runs along the line, turned to its
direction.

```json
{
  "canvas": { "width": 800, "height": 600, "overscan": "8em" },
  "preset": "map",
  "items": [
    { "id": "main-street",
      "anchor": { "type": "line", "points": [[-340, 420], [180, 395], [520, 310], [1150, 240]], "width": 18 },
      "label": { "type": "text", "text": "Main Street" } },
    { "id": "mill-lane",
      "anchor": { "type": "line", "points": [[300, 40], [330, 180], [410, 290]], "width": 4 },
      "label": { "type": "text", "text": "Mill Lane" } }
  ]
}
```

* `width` is the width the street is drawn with. A name fits on a street at least as wide
  as the label is high ("Main Street"); a narrower one has its name above or below it
  ("Mill Lane"), 1 px clear of the stroke.
* The name lies on a stretch that is straight enough for it: a label is a straight box,
  and text is not bent along a curve. A street that winds everywhere under its name gets
  the name beside a dot halfway along it.
* Pass a street whole, however far it runs beyond the view. In a window the name is
  placed on the longest piece inside the view and its overscan, so it stays readable
  while the street's ends are far away; with a [pinned](#a-pan-moves-no-label) pan it
  keeps its place like every label.
* A street is not an obstacle by being labeled. If the place names should keep off the
  streets, the streets are part of the background (`obstacles`) as before.

## Moving points

The same works when the points move: a running force-directed layout, a node the user
drags, animated data. A d3-force layout, labeled every 4th tick:

```js
--8<-- "examples/tutorials/js/force.mjs:force"
```

```text
30 frames; labels move 0.7 px per frame warm-started, 5.0 px from scratch
```

The [benchmark](../project/benchmark.md) measures this on larger sequences — a running
force layout, a dragged node, a camera path over 1,000 airports — where warm starts more
than halve the share of labels that jump.

### Smooth transitions

Each solve still moves some labels and adds or removes others, and a label that
disappears often returns a solve or two later. Drawn as they come, these changes jump and
blink. `LabelMotion` from `@label-anything/extras` draws the results calmly:

* a moved label stays put until its new place has held for a moment (`moveDelay`), then
  moves once — at once if another label needs its room;
* a label that leaves the results stays a moment longer (`holdTime`), and a new one appears
  only if it is still placed a moment later (`appearDelay`), so labels that come and go do
  not blink;
* short moves glide (`duration`); long ones (`jump`) fade out and in at the new place;
* between solves, labels follow their points, and where two meet, the less important one
  makes way.

Give it every result, and draw what it returns on every frame:

```js
--8<-- "examples/tutorials/js/browser/force.mjs:force-motion"
```

When the simulation ends, `settle` solves once more with a lower `weights.stability`, so
that the few labels with a clearly better place move there. `frame()` returns the
placements as drawn at that moment, with the opacities of fading labels; `renderLabels`
draws them, or any renderer can. The Leaflet, MapLibre and sigma.js helpers do this
themselves (option `transition`, in ms; 0 draws each result unchanged;
[ADR motion/label-motion](../adr/motion/label-motion.md)). The [playground](https://fabian-beck.github.io/label-anything/playground/) has
these options in its Motion section.

## Leaflet

`labelLayer` from `@label-anything/extras/leaflet` is a Leaflet layer. It collects the
points in view and a little beyond it in container pixels, solves, and draws the labels in
an SVG pane, again after each move. The map is a window as above: `overscan` is how far
beyond its edge points are labeled as well, in px (default: 8 times the font size, 96 px at
12 px; `false` keeps every label inside the map, as on a canvas). After a pan the labels
are pinned, after a zoom placed anew (`pin: false`: warm starts alone).

```js
--8<-- "examples/tutorials/js/browser/leaflet.mjs:leaflet"
```

The icon mark matches Leaflet's default pin (25 × 41 px, tip at the bottom center), so
labels avoid the whole pin. Pass the geometry of other layers as `obstacles`.

## MapLibre GL and Mapbox GL

`labelMapLibre` draws labels in an SVG overlay that follows the map while it moves and
solves again on `moveend`; the map is a window, with the same `overscan` and `pin` options
as the Leaflet layer (a pan is a move with the same zoom, bearing and pitch). `avoidLayers` turns the rendered
features of style layers into obstacle classes named after the layers.

```js
--8<-- "examples/tutorials/js/browser/maplibre.mjs:maplibre"
```

## Keeping it fast

* **Solve every few frames** (about ten times per second), not on every frame, and draw
  smooth transitions in between.
* **Keep the overscan to a label's width.** What lies in it is solved like the view: 100 px
  around a view of 800 × 600 px are two thirds more area, and about as many more labels.
* **Use a short time budget.** With `solver.time_budget_ms: 10`, a frame of a 77-node graph
  takes about 12 ms natively and 20 ms in JavaScript, and the labels move about as little
  as with the default budget. Results stay deterministic for a given budget
  ([the solver](../concepts/solver.md)).
* **Solve in a worker** for large maps (`createWorkerEngine`), so the page stays responsive
  ([JavaScript](../getting-started/javascript.md#web-workers)); the helpers abort an
  outdated solve when a new one starts. `@label-anything/wasm` runs the Rust core in the
  page ([WebAssembly](../getting-started/javascript.md#webassembly)).
