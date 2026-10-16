# Avoidance classes and policy

Everything a label or leader could cover belongs to an **obstacle class**, and `avoid` says
per class how much covering it matters — separately for label boxes and for leaders:

```json
{
  "obstacles": {
    "vector": [
      { "class": "outliers", "points": [[120, 80], [410, 95]], "r": 4 },
      { "class": "points", "points": [[200, 150], [210, 160], [190, 155]], "r": 2 }
    ]
  },
  "avoid": {
    "label": { "outliers": "hard", "points": 0.3 },
    "leader": { "outliers": "hard", "leaders": "hard" }
  }
}
```

"Never cover an outlier, covering other points costs a little, never cross a leader."

## Classes

| Class | Contents |
|---|---|
| `items` | the marks of all items (their true shapes); area anchors contribute nothing |
| `labels`, `leaders` | the labels and leaders placed so far (dynamic) |
| `canvas_edge` | everything outside the label area (canvas or `region` minus `padding`) |
| `ink`, `text` | produced by SVG and raster backgrounds (the default class of drawn SVG elements and raster modes; SVG text) |
| any other name | your classes: `obstacles.vector[].class`, SVG class rules, a raster source's `class`, classmap entries |

Class names are identifiers (`[A-Za-z_][A-Za-z0-9_.:-]*`). A class in `avoid` that no source
produces is reported as a validation **warning** (`unknown_class`) — usually a typo.

## Policy values

* `"hard"` — a filter: a candidate that touches the class is discarded. Against vector
  geometry (vector layers, SVG, marks, labels, leaders) the test is exact; against raster
  classes it is conservative at the grid resolution (a label touches the class when it
  overlaps a cell with any coverage).
* a number `w ≥ 0` — a soft cost: `w × covered area / label area` for labels,
  `w × covered length / leader length` for leaders. Covering a whole label's area with a
  class of weight 1 costs as much as one unit of the other cost terms
  ([costs](candidates.md#costs)).
* `"ignore"` — no interaction at all.

The key `"*"` sets the value of every class the map does not list.

## The four maps

| Map | Default | |
|---|---|---|
| `avoid.label` | `labels`, `items`, `text`, `canvas_edge`, `own_mark`: hard · `ink`: 0.5 · `*`: 1.0 | label box vs. class |
| `avoid.leader` | `leaders`, `labels`: hard · `items`: 2.0 · `ink`: 0.2 · `*`: 0.2 | leader vs. class; `leaders` = crossings, `labels` = passing through other labels |
| `avoid.buffer` | `items`: 1.0 · `leaders`: 0.5 | soft weights of the ring around each label (width `defaults.buffer`, 0.3 em): keeps labels from sitting so close to another item that they look like its label |
| `avoid.relaxable` | `["points", "ink", "lines"]` | hard classes the `soft_overlap` ladder step may turn into a weight (`degrade_options.soft_overlap_weight`, 10) |

`labels`, `leaders` and `items` are never relaxed.

**Own mark.** `avoid.label.own_mark` is the policy between a label and its *own* mark:
`"hard"` (default: never cover it), `"ignore"`, or `"partial:0.3"` (cover at most 30 % of
it). Internal labels are inside their mark by design and exempt.

## Merging

The effective maps are merged **key by key**: the defaults above, then the
[preset](presets-defaults.md)'s keys, then yours. `{"avoid": {"label": {"ink": 2}}}`
changes only `ink`; the rest of the map keeps its defaults. The presets set, for
example:

| Preset | `avoid.label` | `avoid.leader` |
|---|---|---|
| `auto` | points 0.3, lines 1.0, ink 0.5 | points 0.2, lines 0.5 |
| `scatter` | points 0.3, lines 1.0, ink 0.5, axes hard | points 0.2, lines 0.5, axes 1.0 |
| `map` | lines 0.8, ink 0.5, areas ignore, text hard | lines 0.3, areas ignore |
| `graph` | lines 1.0, ink 0.5 | lines 0.5 |
| `illustration` | ink 2.0 | ink 0.1 |

## Choosing values

* Make a class **hard** when covering it is wrong, not merely ugly: other labels, map
  text, a legend, data the reader must see. Hard classes reduce the space; more labels
  will need leaders or be omitted.
* Use **weights** for things that may be covered when it helps: dense unlabeled points,
  grid lines, background shading. Weights between 0.2 and 2 are typical; the other cost
  terms (position, distance, leaders) are of order 1.
* **Ignore** what does not matter for legibility: plot backgrounds, area fills under
  labels, faint grid lines.
* Leaders are thin: they can cross many things that labels must not. By default they may
  cross obstacles at a small cost (0.2), items at 2.0, and never labels or other leaders.
