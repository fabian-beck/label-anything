# Aggressiveness

How hard the engine tries to place every label is one option in three levels, `low`,
`medium` (the default) and `high` (the defaults before), each a column of defaults for the
ladder, the reach of distant labels, fan columns and the label margin.

## Context
The objective is lexicographic, priority first and cost second (ADR solver/search), so any
means that places one more label wins. The defaults used every means that keeps a label
clear of what it may not cover and nearer its own mark than any other: distant labels up to
8 em from their mark, a `distant` step in the ladder, fan columns, type shrunk to 70 % and
hard classes relaxed. Where space runs out, the benchmark's renderings show the price: 12 of
the 30 Gapminder labels hang on leaders out of the crowded cluster, up to 8 em long; in the
chart of 1,206 classes, 37 of 62 labels hang on leaders across the chart and 17 are shrunk;
among 3,000 airports, 290 labels have leaders and 39 smaller type. A host that wanted a
calmer picture had to know which of `degrade`, `placement.fan` and `placement.max_distance`
to change. A soft cost cannot hold a label back (ADR placement/leaders): fewer labels
need fewer means, not other weights.

To weigh labels against clutter, the benchmark measures clutter as the edge density of the
labels and leaders (ADR project/benchmark-measures). Restricting the means one step after
the other, on the 59 static benchmark problems of up to 3,221 items, solved without a clock
(12,385 labels with every means):

| Step | Labels | Clutter |
|---|---:|---:|
| no shrinking, no relaxed overlaps | −4.6 % | −7.7 % |
| distant labels within 4 em instead of 8 em | −0.7 % | −3.0 % |
| no `distant` step in the ladder, no fan columns, distant labels within 2.5 em | −5.7 % | −5.7 % |
| a margin of 0.3 em instead of 0.2 em, so 0.6 em between labels | −8.6 % | −7.3 % |

Long leaders are the cheapest clutter to remove: 3 % of it for 0.7 % of the labels. Fan
columns alone add 0.4 % of the labels and 0.5 % of the clutter.

## Decision
- **`placement.aggressiveness`**: `low`, `medium` (default) or `high`. Each level is a column
  of defaults for `degrade`, `placement.max_distance`, `placement.fan` and
  `defaults.margin` (the aggressiveness table of `spec/defaults.md`), merged between the
  defaults table and the preset (spec §2.4); a preset or the problem that sets one of these
  options overrides the level for it.
- **`high`** keeps every means: the previous defaults.
- **`medium`** drops `shrink:0.85` and `soft_overlap` from the ladder and keeps distant
  labels within 4 em: type stays at its size, so font classes keep their hierarchy, and
  hard classes stay hard.
- **`low`** also drops the ladder's `distant` step and fan columns, keeps the distant labels
  of the models within 2.5 em and raises the margin to 0.3 em, 0.6 em between labels:
  labels stand next to their marks with room around them. Models with leaders only keep
  them: an illustration's margin column is the same at every level.
- No new mechanism: a level is option values, so the explanations, the removal test, the
  evaluator and both implementations need no rule of their own, and the solve gets faster
  with every means left out.

## Consequences
On the same 59 problems:

| Level | Labels | Leaders | Leader length | Clutter (mean) | Unclear labels |
|---|---:|---:|---:|---:|---:|
| `high` | 12,385 | 2,688 | 93,410 px | 4.67 % | 3,949 |
| `medium` | 11,729 (−5.3 %) | 2,239 | 57,005 px | 4.18 % (−10.5 %) | 3,859 |
| `low` | 10,104 (−18.4 %) | 276 | 14,396 px | 3.65 % (−21.8 %) | 4,172 |

`medium` keeps 5 distant leaders longer than 4.5 em where `high` drew 728. The labels it
gives up needed smaller type or a long leader: long class names (48 instead of 62 in the
1,206-class chart) and crowded maps. With `prefix` omission the first such label ends the
prefix: 136 instead of 193 of 250 European airports. `low` places 13–27 % fewer labels
than `high` on the world maps of 300 airports or more, the city map and the stress problems
of 500 points or more. Its share of unclear labels rises from 33 to 41 %: its labels are no
less clear, but the leadered labels, which never are unclear, are gone, and those that
remain stand among unlabeled airports that the own-mark rule does not see (ADR
project/benchmark-measures). The embeddings, the illustrations and Les Misérables keep
every label at every level.

Hosts that relied on the old defaults set `aggressiveness: "high"`. Conformance cases that
test shrinking set it too, three cases pin what each level does, and the parity tests solve
every sample problem at `low` and `high` in both implementations.

## Alternatives
- **A largest cost per label**: costs include soft coverage, so a label over cheap
  points would be omitted where it fits, an inversion of `strict` omission (spec §9.2)
  unless the removal test knew every cost; and the threshold would move with every weight.
- **A density budget** (`priority.budget.max_ink_fraction`, Töpfer's radical law): a global
  cap omits by priority anywhere, in sparse regions as readily as in crowded ones; a local
  cap would be a new hard rule with its own removal test.
- **No leaders at all at `low`**: illustrations whose models have only leaders would lose
  every label, and the `scatter` and `graph` presets ask for distant labels; within
  2.5 em, a leader reads like a stub.
- **One shrink step at `medium`** (`shrink:0.85` down to 0.85): 2.1 % more labels and 4 %
  more clutter than `medium`, with type sizes still mixed.
- **A shorter `leaders.max_length` per level**: no effect beyond `placement.max_distance`
  (11,730 against 11,729 labels), but it would cut the long leaders of problems that set
  `placement.max_distance` themselves, such as the leaders tutorial.
- **No fans at `medium`**: 0.4 % fewer labels for 0.5 % less clutter; the columns at line
  ends are among the clearest labels.
