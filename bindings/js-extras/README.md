# @label-anything/extras

> **Experimental:** Label Anything is still experimental and under active development.
> The API, the problem format and the placements can change in any 0.x release, without
> deprecation.

Label placement helpers for JavaScript visualization libraries. Each helper turns what the
library already knows (marks, scales, map projections, graph layouts) into a Label Anything
problem, solves it, and draws or applies the result:

| Import | For | What it does |
|---|---|---|
| `@label-anything/extras/d3` | d3 | `labelSelection(selection, text, options)` labels the selected SVG elements; the rest of the `<svg>` is the obstacle background |
| `@label-anything/extras/plot` | Observable Plot | `labelAnything(data, options)`: a text mark whose labels avoid each other and the marks drawn before it |
| `@label-anything/extras/vega` | Vega | `registerVegaTransform(vega)` adds a `labelAnything` transform (a drop-in for Vega's `label`) |
| `@label-anything/extras/leaflet` | Leaflet | `labelLayer(L, data, options)`: a layer re-solved after every move, warm-started from the previous result |
| `@label-anything/extras/maplibre` | MapLibre GL / Mapbox GL | `labelMapLibre(map, data, options)`: an SVG overlay that follows the map and avoids rendered features of chosen layers |
| `@label-anything/extras/cytoscape` | Cytoscape.js | `labelCytoscape(cy, options)` positions Cytoscape's own node labels |
| `@label-anything/extras/sigma` | sigma.js v2/v3 | `labelSigma(renderer, options)` replaces sigma's label renderer |
| `@label-anything/extras/worker` | any | `createWorkerEngine(worker)` / `serveEngine(engine)`: solve in a Web Worker |

None of the libraries is a dependency: the helpers use only the methods listed in their
`…Like` interfaces (Observable Plot is an optional peer dependency of `/plot`).

The helpers that draw the labels themselves render what the engine returns, including
wrapped lines and shrunk fonts. Vega and Cytoscape draw their own text and the helpers
only move it, so there labels are never wrapped or shrunk: the degradation ladder leaves
out `wrap`, `truncate` and `shrink`, and a label that does not fit is left out instead.

## Engine

By default the helpers solve with `@label-anything/core` (pure TypeScript). To use the
WebAssembly build or a worker, pass `engine` or set it once:

```js
import * as wasm from "@label-anything/wasm";
import { setDefaultEngine } from "@label-anything/extras";
setDefaultEngine(wasm);
```

Interactive helpers (maps, graphs, the Plot mark) also accept asynchronous engines such as
`createWorkerEngine(...)`; only the newest solve is applied when updates overlap.

## Examples

```js
// d3: label the dots of a scatterplot; axes, grid and title are obstacles
import { labelSelection } from "@label-anything/extras/d3";
labelSelection(dots, (d) => d.name, { priority: (d) => d.population, preset: "scatter", leaders: "straight" });

// Observable Plot
import * as Plot from "@observablehq/plot";
import { labelAnything } from "@label-anything/extras/plot";
Plot.plot({ marks: [Plot.dot(cars, { x: "power", y: "economy" }), labelAnything(cars, { x: "power", y: "economy", text: "name" })] });

// Leaflet: labels next to the default marker pins, larger cities first
import L from "leaflet";
import { labelLayer } from "@label-anything/extras/leaflet";
labelLayer(L, cities, { latLng: (d) => [d.lat, d.lon], text: "name", id: (d) => d.id, priority: (d) => d.population, mark: { shape: "icon", w: 25, h: 41 } }).addTo(map);
```

```json
{ "type": "text", "from": {"data": "points"},
  "encode": {"enter": {"text": {"field": "datum.name"}}},
  "transform": [{ "type": "labelAnything", "size": {"signal": "[width, height]"},
                  "avoidMarks": ["trend"], "priority": "datum.datum.population" }] }
```

## Options shared by all helpers

| Option | Meaning |
|---|---|
| `engine` | solver (default `@label-anything/core`) |
| `text` | accessor `(d, i) => string \| label object`, or a field name |
| `id` | stable ids, needed to keep labels in place across updates (default: index) |
| `priority` | `(d, i) => number` (higher is kept first) or the problem's `priority` section; with a priority, important labels may cover the dots of less important items, which then go unlabeled (`avoid` `lower_items` 10 / 2.5 unless you set it) |
| `attrs` | per-item data for priority terms and expressions |
| `preset`, `avoid`, `placement`, `solver` | the problem sections of the same name |
| `leaders` | `false`, a style (`"straight"`, `"elbow"`, ...) or the `leaders` section |
| `font` | `{family, size, weight, style}`; labels are drawn in exactly this font |
| `padding` | keep labels this far inside the view |
| `problem` | any other problem fields, merged last |
| `measure` | text measurement (default: the browser canvas; `false`: built-in metrics) |
| `placeOptions` | further solve options (`progress`, `signal`, `cost`) |

Labels are measured with the browser's canvas (`measureText`) in the same CSS font they
are drawn with, so boxes match the rendering. Drawn labels use the classes `la-labels`,
`la-item`, `la-label` and `la-leader` (and `data-id` attributes) for styling.

## Stability

Interactive helpers keep the previous result and pass it, moved with the anchors, as
`warm_start`: labels keep their side while you pan or zoom and only move when they must.
Use stable `id`s and the same `priority` across updates so that label sets nest when
zooming (labels are only added or removed in priority order).

## Smooth transitions

After a solve, the Leaflet, MapLibre and sigma.js helpers do not redraw the labels at
once: labels glide into their new places and fade in and out (option `transition`,
default 300 ms; 0 draws each solve as it is). The same is available for any renderer:

```js
import { LabelMotion, renderLabels } from "@label-anything/extras";

const motion = new LabelMotion();              // the defaults below
motion.target(result);                         // after every solve
const frame = motion.frame(anchors);           // every animation frame while motion.moving
renderLabels(group, frame.result, { font, opacity: frame.opacity, leaderOpacity: frame.leaderOpacity });
```

`anchors` maps item ids to their current positions, so labels follow moving points
between solves. The transitions are calm by design ([ADR 0038](https://github.com/fabian-beck/label-anything/blob/main/docs/adr/0038-calm-label-transitions.md)):

| Option | Default | |
|---|---|---|
| `duration` | 300 | ms of a glide or fade; 0 draws every result as it is |
| `moveDelay` | 500 | ms a moved label stays until its new place has held (it moves at once when a label at the new place needs the room or it covers another item's point) |
| `holdTime` | 500 | ms a label stays after it left the results |
| `appearDelay` | 250 | ms a new label waits; it shows only if it is still placed then |
| `collisions` | `true` | of two labels that meet between solves, the less important makes way |
| `jump` | 2 | label heights: longer moves fade out and in instead of gliding (`Infinity`: always glide) |
| `fadeInFirst` | `false` | the first result fades in too |
