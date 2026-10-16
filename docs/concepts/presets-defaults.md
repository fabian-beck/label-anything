# Presets and defaults

Every option has a default; a **preset** is a named bundle of option values for a kind of
graphic; the problem's own values come last:

> effective options = [defaults](../reference/defaults.md) ← preset ← problem

Objects merge recursively, arrays and scalars replace; the class maps of `avoid` merge key
by key. So `{"preset": "map", "avoid": {"label": {"roads": "hard"}}}` keeps everything the
`map` preset sets and adds one class.

## The presets

| Preset | For | What it sets |
|---|---|---|
| `auto` (default) | anything; zero configuration | adjacent and slider positions, distant labels with leaders only when more than 30 % of the items have no free adjacent position; unlabeled points cost 0.3, lines 1.0, ink 0.5 |
| `scatter` | scatter plots: point marks over dense unlabeled points, trend lines, axes | distant labels with straight leaders; points 0.3, lines 1.0, ink 0.5, `axes` hard |
| `map` | point features over map backgrounds | cartographic position order (top-right first), adjacent and slider only, map text hard, lines (roads, rivers) soft, filled areas ignored |
| `graph` | node-link diagrams | internal labels first (for large nodes), leaders at multiples of 45°, edges (`lines`) soft |
| `illustration` | technical and anatomical illustrations | labels in the left and right margins (boundary) or distant, elbow leaders into the label's side, ink costly (2.0) |
| `none` | full control | nothing beyond the defaults |

Each preset also has **SVG class rules** used when an SVG source has no `classes` of its
own; e.g. `scatter` and `auto` ignore background rectangles (`:background`), make `text`
the class `text`, circles and small shapes `points`, paths and lines `lines`, and
everything else `ink`. The complete presets are on the [presets page](../reference/presets.md).

## Selected defaults

| Topic | Default |
|---|---|
| Text | 12 px bundled Noto Sans, padding 0.15 em, buffer ring 0.3 em, line height 1.2 |
| Marks | circle, r = 2 |
| Canvas | padding 4 px, labels inside the canvas |
| Candidates | adjacent + slider + distant, perceptual order (top first), offset 2 px, distant 1.5–8 em |
| Leaders | straight, never crossing, never through labels, clearance 3 px, 6 px – 10 em long |
| Avoidance | labels, items, text, canvas edge and own mark hard; ink 0.5; other classes 1.0 |
| Priority | explicit `item.priority`, else input order; `strict` omission |
| Ladder | alternatives → wrap → distant → boundary → evict_lower → shrink 0.85 → soft overlap → omit |
| Solver | 100 ms (Rust) / 250 ms (TypeScript) budget as a fixed iteration count, seed 0 |

[The defaults table](../reference/defaults.md) lists every option with its default,
validation rule and meaning. It is the source of the constants of both implementations:
the Rust and TypeScript code is generated from it, so documentation and engines cannot
disagree.

## The `auto` preset's adaptive rule

`auto` starts with adjacent and slider candidates only. If more than 30 % of the items
have no statically free adjacent or slider candidate (`auto.crowded_fraction`), it
switches to `[adjacent, slider, distant]` — unless the problem sets `placement.models`
itself. Independent of that, the ladder's `distant` step still gives a leader to an
individual label that fits nowhere else.
