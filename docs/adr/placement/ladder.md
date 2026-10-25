# Degradation ladder

An item that finds no free position degrades step by step — alternatives, wraps, leaders,
eviction, shrinking — but not to margin labels by default, and candidates that could never
be used are dropped as they are generated.

## Context
Presets choose the candidate models; the ladder (spec §10.1) gives an item without a free
position progressively worse options. In the benchmark it caused two problems. Its
`boundary` step put labels in the canvas margins with leaders across the picture: 169
leaders longer than a quarter of the canvas diagonal, up to 147 em. And items without room
ran every step, each generating hundreds of candidates of which over 95 % overlapped
labels already placed; creating, storing and re-checking them dominated the solve.

## Decision
- **Default ladder**: `alternatives`, `wrap`, `distant`, `evict_lower`, `omit`; with
  `placement.aggressiveness` `high` also `shrink:0.85` and `soft_overlap` before `omit`,
  with `low` without `distant` (ADR placement/aggressiveness). Margin labels remain a model
  and an explicit step for layouts that intend them, such as the `illustration` preset.
- **The `auto` preset** starts with adjacent and slider positions and adds distant ones
  when more than 30 % of the items have no statically free position, unless the problem
  sets `placement.models`. The ladder's `distant` step still gives single items a leader.
  Presets are data (`spec/presets/*.json`).
- **Filtering while generating** (spec §6.7): a candidate made during the solve is not
  stored when a placed label or leader of higher or equal priority blocks it, since it
  could never be used, evicted or witness a priority inversion. Occupancy grids of placed
  labels and of item marks reject most such boxes before the exact test. Dropped
  candidates are counted, so explanations stay the same.
- **No pretest** before the ladder: a sound test may skip an item only if no box of it
  could pass, which held for 18 of 1,128 omitted items in the 2,000-label stress problem.
  Labels fail on discrete positions and exact rules, the margin and thin overlaps, that no
  cheaper test sees.

## Consequences
Leaders across the picture are gone; the labels that needed them are omitted and reported.
Filtering cut the 2,000-label stress problem from 3.0 to 0.5 s and the 1,206 class names
of benchmark scenario 12 from 0.72 to 0.32 s. An omitted label still costs time in
proportion to its candidate boxes, and fewer boxes would mean fewer labels.
