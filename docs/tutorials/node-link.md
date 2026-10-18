# Node-link diagrams

In a node-link diagram, labels compete with nodes of very different sizes and with edges
that run everywhere. The approach: every node is an item whose mark is its true shape,
large nodes hold their labels inside, small ones get theirs next to them, and the edges
are soft obstacles that labels avoid where they can.

```json
--8<-- "examples/tutorials/problems/graph.json:1:12"
  "items": [ ... ]
}
```

![A service graph: hubs and servers labeled inside, small nodes outside](../assets/gallery/node-link.png)

* **Nodes are items.** Circle nodes have a radius that grows with their degree, the two
  servers are rounded rectangles. Labels never overlap a node (`items` is hard).
* **Internal labels.** The `graph` preset enables the `internal` model first: rectangles
  take their labels inside, circles when their radius is at least 1.5 label heights, as
  for the two hubs. Small nodes get adjacent labels.
* **Edges are obstacles.** They are `obstacles.vector` polylines of class `lines`, which
  the `graph` preset makes cost 1.0 for labels and 0.5 for leaders. Draw them as a
  renderer does — from outline to outline — so that a label inside a node does not pay for
  edges hidden under the node.
* **Priority by degree.** The built-in `degree` term counts the polyline ends that touch
  each node's mark (or reads `attrs.degree`): hubs are labeled first when space runs out.

The `graph` preset also uses `angles` leaders at multiples of 45° for labels that must move
away ([presets](../reference/presets.md)).

## In Python

```python
--8<-- "examples/tutorials/python/node_link.py:graph"
```

The program checks that this builds the same problem as `graph.json`.

## Cytoscape.js

`labelCytoscape` keeps Cytoscape drawing its own node labels and sets their positions
(`text-margin-x/y`); omitted labels are hidden. It solves in model coordinates, so panning
and zooming keep the layout valid, and it re-solves after layouts, node drags and graph
changes. Unlabeled nodes are hard obstacles (`nodes`), edges soft ones (`edges`); leaders,
if enabled, go into an SVG overlay.

```js
--8<-- "examples/tutorials/js/browser/cytoscape.mjs:cytoscape"
```

## sigma.js

`labelSigma` replaces sigma's label renderer. Sigma draws labels at a fixed pixel size
while nodes move under the camera, so the solve runs in viewport pixels after camera moves
(debounced), warm-started from the previous result; in between, labels follow their
nodes, and after a solve they move to their new places and fade in and out calmly
([smooth transitions](interactive-maps.md#smooth-transitions)).

```js
--8<-- "examples/tutorials/js/browser/sigma.mjs:sigma"
```

## Edges as obstacles

The edge geometry can come from anywhere: straight segments as above, polylines of
orthogonal or bundled edges, or the edges of an SVG drawing (classified as `lines` by the
`graph` preset's SVG rules). Make edges hard (`"avoid": {"label": {"lines": "hard"}}`) when
labels must never cross them; expect more leaders and omissions then.

## Layouts that move

While a force-directed layout runs or the user drags a node, solve every few ticks with
the previous result as `warm_start`: each label follows its node (a label with a leader
keeps its leader) and moves on only when its place is taken, then to a place nearby. Draw
the labels with `LabelMotion` so that they hold their places a moment, glide or fade
into new ones and make way for each other instead of jumping and blinking. [Moving points](interactive-maps.md#moving-points) has
d3-force examples and the measurements.
