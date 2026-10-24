# Avoidance classes and policy

Everything a label or leader could cover belongs to an **obstacle class**, and `avoid` sets
per class how much covering it matters, separately for labels and for leaders:

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

Class names are identifiers (`[A-Za-z_][A-Za-z0-9_.:-]*`). A class in `avoid` that no
source produces gets a validation **warning** (`unknown_class`); it is usually a typo.

## Policy values

* `"hard"` — a filter: a candidate that touches the class is discarded. The test is exact
  against vector geometry (vector layers, SVG, marks, labels, leaders) and conservative at
  grid resolution against raster classes (a label touches the class if it overlaps a cell
  with any coverage).
* a number `w ≥ 0` — a soft cost per covered amount, in units of the label's font size:
  `w × covered area / em²` for labels, `w × covered length / em` for leaders. Hiding one
  em² of a class of weight 1 costs as much as a leader; a thin line costs the same across
  a long label as across a short one ([costs](candidates.md#costs)). A label inside its
  mark covers only that mark, which hides what lies beneath, so it pays no soft class
  costs.
* `"ignore"` — no interaction.

The key `"*"` sets the value of every class the map does not list.

## The four maps

| Map | Default | |
|---|---|---|
| `avoid.label` | `labels`, `items`, `text`, `canvas_edge`, `own_mark`: hard · `ink`: 0.1 · `*`: 1.0 | label box vs. class; hard `labels` and `items` also keep the label margin (`defaults.margin`, 0.2 em) |
| `avoid.leader` | `leaders`, `labels`, `items`: hard · `ink`: 0.05 · `*`: 0.2 | leader vs. class: `leaders` covers crossings and leaders closer than `leaders.clearance`, `labels` leaders through other labels, `items` leaders closer than `leaders.clearance` to other items' marks |
| `avoid.buffer` | `items`: 1.0 · `leaders`: 0.5 | soft weights of the ring around each label (width `defaults.buffer`, 0.3 em), which keeps a label from sitting so close to another item that it reads as that item's label |
| `avoid.relaxable` | `["points", "ink", "lines"]` | hard classes the `soft_overlap` ladder step may turn into a weight (`degrade_options.soft_overlap_weight`, 10) |

`labels`, `leaders` and `items` are never relaxed.

**Own mark.** `avoid.label.own_mark` is the policy between a label and its *own* mark:
`"hard"` (default: never cover it), `"ignore"`, or `"partial:0.3"` (cover at most 30 % of
it). Internal labels, inside their mark by design, are exempt.

**Marks of less important items.** `avoid.label.lower_items` is the policy between a label
and the marks of items with a *lower* priority key; it defaults to that of `items`, and is
10 in the `map` preset and in the helpers given a priority. A weight lets important labels
claim the space of the minor marks around them. A covered mark is never mislabeled: its
item is omitted (`omitted_by_priority`). `avoid.leader.lower_items` does the same for
leaders ([priority](../tutorials/priority.md#important-labels-over-minor-marks)).

## Merging

The maps are merged **key by key**: the defaults above, then the
[preset](../reference/presets.md)'s keys, then yours. `{"avoid": {"label": {"ink": 2}}}`
changes only `ink`; the rest of the map keeps its defaults. The presets set:

| Preset | `avoid.label` | `avoid.leader` |
|---|---|---|
| `auto` | points 0.3, lines 1.0, ink 0.1 | points 0.2, lines 0.5 |
| `scatter` | points 0.3, lines 1.0, ink 0.1, axes hard | points 0.2, lines 0.5, axes 1.0 |
| `map` | lines 0.8, ink 0.1, areas ignore, text hard, lower_items 10 | lines 0.3, areas ignore, lower_items 2.5 |
| `graph` | lines 1.0, ink 0.1 | lines 0.5 |
| `illustration` | ink 1.0 ([ADR placement/costs](../adr/placement/costs.md)) | ink 0.025 |

## Choosing values

* Make a class **hard** when covering it is wrong, not merely ugly: other labels, map
  text, a legend, data the reader must see. Hard classes leave less space, so more labels
  need leaders or are omitted.
* Use **weights** for what may be covered when that helps: dense unlabeled points, grid
  lines, background shading. Weights between 0.1 and 2 per em² are typical; the other cost
  terms (position, distance, leaders) are of order 1. Ink is everywhere in images and maps,
  so its weights are small — except where labels belong beside the picture: the
  `illustration` preset charges an em² of covered picture like a leader.
* **Ignore** what does not affect legibility: plot backgrounds, area fills under labels,
  faint grid lines.
* Leaders are thin and may cross much that labels must not: give them lower weights than
  labels, as the defaults do ([leaders](../tutorials/leaders.md)).
