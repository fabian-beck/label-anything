# 0029 — Illustrations: covering the picture costs as much as a leader

* Status: accepted
* Date: 2026-10-17
* Area: Candidates, leaders and costs
* Affects: `spec/presets/illustration.json` (`avoid.label.ink` 0.15 → 1.0)
* Amends: [ADR 0019](0019-visual-quality-defaults.md) (the `illustration` preset's ink
  weight)

## Context
The `illustration` preset is meant for callouts in the margins: boundary and distant
labels with elbow leaders, "ink is costly". When ADR 0019 changed coverage costs to
em², its weight for labels over ink went from 2.0 to 0.15. Since then a label over the
picture has cost less than a leader to the margin: in the two benchmark illustrations
(scenario 08, a portrait and a fundus photograph, both with `boundary` and `distant`
models) every label was a distant label on the picture, next to the region it names,
and the gallery's captions, which describe labels in the margins, were wrong. A label of
10 em² over the photo cost 1.5; a leader of 20 em to the margin costs 6
(`weights.leader` 1 + `weights.leader_length` 0.25 per em).

## Decision
`avoid.label.ink` = **1.0** in the `illustration` preset: an em² of picture covered by a
label costs as much as having a leader. Leaders over the picture stay cheap (0.025 per
em). The default and the other presets keep 0.1: in charts and maps ink is everywhere
and labels must be near their marks.

## Alternatives considered

Measured on the two illustrations (labels entirely outside the photo's rectangle; the
photo's area under labels; median and longest leader):

| `avoid.label.ink` | portrait (12 labels) | fundus photograph (10 labels) |
|---|---|---|
| 0.15 (before) | 1 outside, 122 em², 2.2 / 4.4 em | 0 outside, 118 em², 2.2 / 8.7 em |
| 0.5 | 7 outside, 33 em², 6.6 / 23 em | 2 outside, 74 em², 6.6 / 34 em |
| **1.0** | 8 outside, 29 em², 8.7 / 23 em | 2 outside, 74 em², 6.6 / 34 em |
| 2.0 | 9 outside, 21 em², 8.7 / 33 em | 3 outside, 68 em², 6.6 / 34 em |
| 4.0 | 10 outside, 10 em², 8.8 / 33 em | 5 outside, 48 em², 21 / 63 em |

* *0.5* gives nearly the same layouts; 1.0 is the weight with a meaning (an em² of
  picture against one leader).
* *2.0 and more*: a few more labels in the margins, with leaders across the whole
  picture (at 4.0, the median leader of the fundus photograph is 21 em).
* *Hard ink for labels*: a label could then never name a region in the middle of a
  picture that leaves no free space nearby.

## Consequences
Both illustrations keep all their labels. In the portrait 8 of the 12 labels stand
outside the photo (boundary labels on both sides, distant ones just beside the photo's
edge); the regions in its middle keep labels close by, on the photo (neck ring, name
tag) or partly on it (harness strap, helmet). In the fundus photograph the peripapillary
atrophy and the inferior temporal arcade move to the margins; the other labels stay
close to their structures, five of them partly beside the photo, those of the optic
cup, the macula and the fovea on it. Leaders get
longer (in the fundus photograph one is longer than a quarter of the canvas diagonal, the
benchmark's `leaders_far`), as callouts to the margins are.
