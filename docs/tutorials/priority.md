# Priority and omission

Most real labeling problems do not fit: forty city names in a small map, a thousand
classes in a scatter plot. Something must be left out, and *what* should be your decision,
not an accident of input order or search luck. In Label Anything a **priority** orders the
items, an **omission mode** says what that order guarantees, and every omitted label comes
with an **explanation**.

The examples use 40 cities in a 480 × 320 canvas at 14 px — not all names fit. Each city
has a population, a region and maybe the capital flag:

```python
--8<-- "examples/tutorials/python/priority.py:data"
```

## Explicit priorities

The simplest priority is a number per item (`item.priority` in JSON): higher is more
important.

```python
--8<-- "examples/tutorials/python/priority.py:explicit"
```

With the default omission mode, `strict`, the guarantee is: **an omitted label would not
fit even if only the more important labels were placed.** No lower-priority label ever
takes the place of a higher-priority one.

## Reading the explanations

```python
--8<-- "examples/tutorials/python/priority.py:explain"
```

```text
Rosmun omitted_by_priority ('items', 'labels') ('Stedau', 'Hofkel', 'Munham') {'tier': 0, 'score': 41105.0, 'rank': 20}
Linsted omitted_by_priority ('items', 'labels') ('Kelsted', 'Berau', 'Roslin') {'tier': 0, 'score': 9409.0, 'rank': 35}
Talheim no_feasible_candidate ('items',) () {'tier': 0, 'score': 36245.0, 'rank': 22}
['Linsted', 'Talheim', 'Rosmun']
0
```

Rosmun and Linsted give way to more important labels; Talheim has no place at all: next
to it a label would come closer to another city's mark than the label margin
(`defaults.margin`, 0.2 em).

Every unplaced item reports:

* `reason` — why it is not labeled:

    | reason | meaning |
    |---|---|
    | `omitted_by_priority` | its candidates are blocked by placed labels or leaders (of higher or equal priority in `strict` mode), or it was cut by `prefix` or `max_labels` |
    | `no_feasible_candidate` | every candidate violates a hard constraint by itself: the canvas edge, a hard obstacle class, its own mark, another item's mark or the margin around it |
    | `budget_exhausted` | the solve was cancelled before the item was reached, or hit its time guard and the item had no free normal position (its degraded variants were not tried) |
    | `keep_with` | another member of its all-or-none set could not be placed |
    | `grouped` | it shares a group label with other items (`item.group`) |

* `blocking` — the hard classes that rejected its candidates, most frequent first
  (`labels`, `items`, `leaders`, `canvas_edge`, or obstacle classes).
* `blocked_by` — the placed items whose label or leader conflicts with its best candidates.
* `priority` — its `tier`, `score` and `rank` in the total priority order (0 = first).

What to do when a label you need is missing, by what blocks it:

| `blocking` | try |
|---|---|
| `items` (an important item in a crowd of minor ones) | let it cover their marks: `avoid.label.lower_items` ([below](#important-labels-over-minor-marks)); or a smaller `defaults.margin` |
| `labels`, `leaders` | raise its priority, or `required: true`; allow leaders (`placement.models` with `distant`, or the `boundary` model for margin labels) |
| `canvas_edge` | `canvas.padding: 0`, a larger canvas, or `canvas.allow_outside: true` |
| an obstacle class (`ink`, `lines`, `text`, …) | make it soft: a weight instead of `"hard"` in `avoid.label` |

`stats.omission_order` lists the omitted ids from the lowest priority upward — the order
in which they gave way. `stats.priority_inversions` counts omitted items that would have
fit next to the labels of higher priority; the engine verifies it after every solve, and
in `strict` and `prefix` mode it is 0. `stats.placed_weighted` (0–1) weighs the placed
labels by rank, so that placing the top of the order counts more than placing its tail.

## Priority terms

Instead of numbers, describe the priority by **terms** the engine evaluates per item: an
attribute, a built-in measure, or an [expression](../reference/expressions.md). Each raw
value is transformed (`log1p`, `sqrt`, `neg`, `abs`), normalized over all items (`rank`
by default, or `minmax`, `none`) and weighted; the score is the sum.

```python
--8<-- "examples/tutorials/python/priority.py:terms"
```

| built-in term | raw value (larger = more important) |
|---|---|
| `outlierness` | gap to the `k`-th nearest neighbour (default 5) among the items' marks and the `points` class |
| `isolation` | gap to the nearest neighbour |
| `crowding` | −isolation |
| `label_size` | area of the label in em² (negative weight: prefer short labels) |
| `mark_size` | area of the mark in px² |
| `centrality` | −distance to `priority.focus` (default: the canvas center) |
| `degree` | `attrs.degree`, else the number of `obstacles.vector` polyline ends on the mark |
| `input_order` | earlier items first |

## Tiers and required items

A **tier** outranks every score: all items of tier 1 come before all items of tier 0.
Rules `{where, tier}` assign tiers by expression (first match wins); `item.tier` sets one
directly. `item.required: true` is above every tier.

```python
--8<-- "examples/tutorials/python/priority.py:tiers"
```

## Coverage

"Label at least two cities per region, while space exists": `coverage` reserves the top
`min_per_group` items of every group of `by` (an expression); they rank above all
non-reserved items of their tier.

```python
--8<-- "examples/tutorials/python/priority.py:coverage"
```

## All or none

Items with the same `keep_with` set name (or a list of item ids) are placed together or
not at all, e.g. a value and its unit, or the two ends of a route.

```python
--8<-- "examples/tutorials/python/priority.py:keep-with"
```

## Expressions

Terms (`expr`), tier rules (`where`) and coverage (`by`) use a small, safe expression
language over the item: `attrs`, `id`, `index`, `text`, `priority`, `tier`, `x`, `y`,
arithmetic, comparisons, `in [...]`, and functions like `log`, `len`, `startsWith`,
`coalesce` ([reference](../reference/expressions.md)). Booleans count as 1/0 in terms.

```python
--8<-- "examples/tutorials/python/priority.py:expr"
```

## A priority function

In Python, JavaScript (`PlaceOptions.priority`) and Java (`Priority.callback`), a function
can compute the priority — a score or `(tier, score)` — once per item before the solve.

```python
--8<-- "examples/tutorials/python/priority.py:callable"
```

## Omission modes

* `strict` (default) — no omitted item would fit given only the items of higher or equal
  priority; within that, as many labels as possible.
* `prefix` — the placed labels are a prefix of the priority order: everything after the
  first omitted item is omitted too (`omitted_by_priority`). Readers can trust that every
  label more important than any shown label is shown.
* `weighted` — maximize the sum of the (non-negative) scores, tiers strictly first;
  inversions are allowed and reported.

`max_labels` caps the number of labels in priority order (`max_ink_fraction` caps the
canvas fraction they cover); `band` treats scores closer than `band` as equal; `ties`
decides between equal keys (`input_order`, `id`, `anchor_x`, `random`).

```python
--8<-- "examples/tutorials/python/priority.py:modes"
```

```text
strict   placed 25  inversions 0  placed_weighted 0.732
prefix   placed 22  inversions 0  placed_weighted 0.675
weighted placed 25  inversions 0  placed_weighted 0.731
```

## Important labels over minor marks

Without further settings every item's mark keeps every other label away, whatever the
priorities: in a crowd, the dots of minor items can leave an important item no position.
With `avoid.label.lower_items` set to a weight, a label may cover the marks of items of
lower priority — and the item whose mark it covers then goes without a label, so that no
label sits on a mark it does not belong to (`avoid.leader.lower_items` lets leaders pass
such marks). On a world map of the 1,000 busiest airports this brings back the labels of
ATL, ORD, LHR, CDG and FRA, which the dots of smaller airports nearby had blocked
([ADR 0040](../adr/0040-labels-may-cover-marks-of-less-important-items.md)).

```json
{"avoid": {"label": {"lower_items": 10}, "leader": {"lower_items": 2.5}}}
```

The `map` preset sets these values, and so do the plotting and map helpers (Python and
JavaScript) whenever you give them a priority
([ADR 0045](../adr/0045-important-labels-win-by-default.md)); `"lower_items": "hard"`
keeps every mark clear again.

## Type size by importance

The priority can also set the type size, as on a map where the capital is set larger than
the villages: `font_classes` (`priority.font_classes`) gives classes of labels larger or
bolder text. The classes take consecutive stretches of the priority order: each ends at its
`first` — a number of items or a share like `"25%"`, counted from the top — and the last
may take the rest; items after the last class keep their size.

```python
--8<-- "examples/tutorials/python/priority.py:font-classes"
```

The scale applies to the label's text (and to host-measured text sizes and wrap widths, so
that lines break as at the nominal size); lengths in em, such as the offset and the
padding, follow the scaled size, while lengths in px, icons and boxes keep theirs. The
priorities themselves are computed with the nominal sizes. Each placement reports its class
(`priority.font_class`) and the size and weight drawn (`text.font_size`,
`text.font_weight`). The ladder's `shrink` step starts from the class size but never goes
below `degrade_options.min_scale` of the size before a smaller class. In the benchmark,
the top 5 % bold at 1.25 × and the rest at 0.9 × keep about as many labels as one size
(911 instead of 920 of 3 000 airports on a world map) and shrink fewer of them (13 instead
of 22 %).

```json
{
  "priority": {
    "terms": [{"attr": "pop"}],
    "font_classes": [{"first": 4, "scale": 1.4, "weight": "bold"},
                     {"first": "25%", "scale": 1.15}, {"scale": 0.85}]
  }
}
```

## The same in JSON

```json
--8<-- "examples/tutorials/problems/priority-cities.json:1:13"
    ...
  ]
}
```

![Crowded cities: the omitted ones are crossed](../assets/gallery/priority-cities.svg)

The red crosses are the three omitted cities. The Python equivalent:

```python
--8<-- "examples/tutorials/python/priority.py:full"
```
