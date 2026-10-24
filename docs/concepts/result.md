# The result format

A result (`result.v1`, schema [`result.v1.json`](../reference/schemas.md)) has one
placement per item, in input order, and statistics of the solve. All coordinates are
canvas pixels, origin top-left, y down.

This problem has two close points, a label that must move away from a hard obstacle (the
`legend` rectangle on the right) and one that cannot be placed at all: its item allows only
adjacent positions, and the ladder only tries alternatives:

```json
{
  "canvas": { "width": 300, "height": 120 },
  "obstacles": { "vector": [ { "class": "legend", "rects": [[200, 0, 100, 120]] } ] },
  "avoid": { "label": { "legend": "hard" } },
  "placement": { "models": ["adjacent", "distant"] },
  "degrade": ["alternatives", "omit"],
  "items": [
    { "id": "a", "anchor": { "type": "point", "x": 60, "y": 60 }, "label": { "type": "text", "text": "Alpha" }, "priority": 3 },
    { "id": "b", "anchor": { "type": "point", "x": 64, "y": 63 }, "label": { "type": "text", "text": "Beta" }, "priority": 2 },
    { "id": "c", "anchor": { "type": "point", "x": 250, "y": 60 }, "label": { "type": "text", "text": "Leader" }, "priority": 1 },
    { "id": "d", "anchor": { "type": "point", "x": 270, "y": 30 }, "label": { "type": "text", "text": "Behind the legend" },
      "placement": { "models": ["adjacent"] } }
  ]
}
```

The result (numbers rounded, `b` shortened):

```json
{
  "version": "1",
  "placements": [
    {
      "id": "a", "placed": true,
      "box": { "x": 21.108, "y": 52.2, "w": 35.892, "h": 15.6 }, "anchor": [60, 60],
      "anchor_side": "left", "model": "adjacent", "leader": null,
      "text": {
        "lines": ["Alpha"], "used": "original", "truncated": false,
        "baseline_offsets": [10.92], "line_widths": [32.292], "x_offset": 1.8,
        "x_offsets": [1.8], "align": "center",
        "font_size": 12, "font_family": "default", "font_weight": 400, "scale": 1
      },
      "cost": 0.418, "degrade_steps": [],
      "priority": { "tier": 0, "score": 3, "rank": 0 }
    },
    { "id": "b", "placed": true, "box": { "x": 67, "y": 56.856, "w": 29.232, "h": 12.288 }, "anchor_side": "right", "model": "adjacent" },
    {
      "id": "c", "placed": true,
      "box": { "x": 134.008, "y": 53.58, "w": 42.492, "h": 12.84 }, "anchor": [250, 60],
      "anchor_side": "distant", "model": "distant",
      "leader": { "points": [[246.5, 60], [176.5, 60]], "style": "straight", "port": [176.5, 60] },
      "priority": { "tier": 0, "score": 1, "rank": 2 }
    },
    {
      "id": "d", "placed": false,
      "reason": "no_feasible_candidate", "blocking": ["canvas_edge", "legend"], "blocked_by": [],
      "degrade_steps": ["alternatives", "omit"],
      "priority": { "tier": 0, "score": 0, "rank": 3 }
    }
  ],
  "stats": {
    "placed": 3, "total": 4, "placed_weighted": 0.83,
    "hard_violations": 0, "leader_crossings": 0, "priority_inversions": 0,
    "omission_order": ["d"],
    "runtime_ms": 1.5, "strategy_used": "local", "seed": 0, "iterations": 1600,
    "candidates": 51, "grid": { "cell": 3, "cols": 100, "rows": 40, "classes": ["legend"] },
    "implementation": "rust/0.1.0"
  }
}
```

## Placements

| Field | |
|---|---|
| `id`, `placed` | the item and whether its label is placed |
| `box` | the label box `{x, y, w, h}`: the collision box, including the label's padding; a text measured with the bundled fonts spans its lines' advance widths and, vertically, their ink, from the top of the first line's letters to the bottom of the last line's ([spec §5.2](../reference/spec.md#52-text-measurement)) |
| `anchor` | `[x, y]`: the item's anchor in canvas px (area items: the pole of the polygon); a result passed back as `warm_start` moves each box with its anchor ([interactive maps](../tutorials/interactive-maps.md#warm-starts)) |
| `anchor_side` | `top`, `right`, `bottom`, `left`, `top-right`, `bottom-right`, `top-left`, `bottom-left`; `internal`, `distant`, `boundary` or `fan` |
| `model` | the candidate model: `adjacent`, `slider`, `internal`, `distant`, `boundary`, or `fan` for a label in a crowd's column ([fan labels](candidates.md#fan-labels)) |
| `text` | the text as placed: `lines` (wrapped, truncated or an alternative), `used` (`original`, `alternative:i`, `truncated`, `group`), `baseline_offsets` (y of each baseline relative to `box.y`), `x_offsets` (x where each line starts relative to `box.x`: the lines aligned per `align`, centered by default), `align` (`center`, `start` or `end`), `x_offset` (the text block's left edge: the padding), `line_widths`, `font_size`, `font_family`, `font_weight`, `scale` (< 1 when shrunk) |
| `parts` | for composite labels: each part's `type`, `box` and `text` |
| `leader` | `null`, or `points` (from the item to the label), `style`, `port` (where it meets the label), `underline` (for `port: baseline`), `curve` (Bézier control points for `curved`), `stub: true` for the short leader of an adjacent or slider label in a crowd, at a right angle to its side ([stubs](../tutorials/leaders.md#stubs-for-labels-in-a-crowd)) |
| `leaders`, `members` | for group labels: one fan leader per member, and the member ids |
| `cost`, `cost_breakdown` | the label's final cost; per term with `output.cost_breakdown` |
| `degrade_steps` | the ladder steps tried for it ([candidates](candidates.md#the-degradation-ladder)) |
| `priority` | `tier`, `score`, `rank` (0 = first in the priority order), `required`, `reserved` (lifted by coverage), `terms`, `font_class` (the item's [font class](../tutorials/priority.md#type-size-by-importance)) |
| `reason`, `blocking`, `blocked_by` | for omitted items: why, which hard classes rejected the candidates, which placed labels are in the way ([priority](../tutorials/priority.md#reading-the-explanations)) |
| `displacement` | with `warm_start`: the distance moved from the previous box |
| `item_shape` | with `output.item_shape`: the resolved mark geometry |

To draw a text label: for each line `i`, draw `text.lines[i]` at
`(box.x + text.x_offsets[i], box.y + text.baseline_offsets[i])` in the label's font at
`text.font_size` (left-aligned on the baseline: the offsets already align the lines,
centered unless `label.align` or `defaults.align` says otherwise), and the leader as a
polyline through `leader.points`; with `text.align` `center` you may as well draw every
line centered on the box's middle. Take the baselines from the result: the box fits the
letters, so a baseline at the font's ascent below the box top would be too low. Drawing
the `box` is optional; a halo or a background behind the text usually looks better.

## Statistics

| Field | |
|---|---|
| `placed`, `total` | labels placed; items |
| `placed_weighted` | placed fraction weighted by rank (1 = everything; the top of the order counts more) |
| `required_placed` | every `required` item is placed |
| `hard_violations`, `leader_crossings` | counted by an independent check; 0 (leaders cross only if you make crossings soft) |
| `priority_inversions` | omitted items that would fit next to the more important labels; 0 in `strict` and `prefix` mode |
| `omission_order` | omitted ids, lowest priority first |
| `runtime_ms`, `phases_ms` | wall-clock time, per phase (`prepare`, `candidates`, `greedy`, `local`, `exact`, `verify`) |
| `strategy_used`, `iterations`, `seed` | what the [solver](solver.md) did |
| `time_guard_hit`, `cancelled` | the wall-clock guard stopped a phase; the host cancelled the solve |
| `candidates` | number of candidates generated |
| `total_cost` | the sum of the placed labels' costs |
| `degraded` | placed labels per degradation kind (`wrapped`, `alternative`, `truncated`, `shrunk`, `soft_overlap`, `distant`, `boundary`) |
| `flicker` | with `warm_start`: labels `moved`, `added`, `removed`, `mean_displacement` |
| `grid` | the coverage grid: `cell` size, `cols`, `rows`, the obstacle `classes` that occur |
| `implementation` | engine and version: `rust/0.1.0` (native), `wasm/0.1.0` (the Rust core as WebAssembly), `ts/0.1.0` |

The result may also hold `warnings` (validation warnings such as `unknown_class`),
`debug_svg` (with `output.debug_svg`) and `candidates` (with `output.candidates`).
