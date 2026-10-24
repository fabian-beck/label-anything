# Font classes

The most important labels can be set larger, in a few type sizes by rank in the priority
order, as cartographers do.

## Context
Priority decides which labels are shown, but every shown label looked the same: the
capital and the village, the hub and the airstrip. A host could set sizes per item, but
the importance order is the engine's own (terms, normalization, tiers, coverage, ties): it
would have to solve twice to learn the ranks, or reimplement the priority function.

## Decision
`priority.font_classes` is a list of `{first, scale, weight}` (spec §9.4):

- Classes take consecutive stretches of the total order, each ending at a count or a share
  (`"5%"`); items after the last class keep their size. A group label takes the class of
  its best-ranked member.
- `scale` multiplies the font size of the label's texts, host-measured sizes and wrap
  widths; lengths in em follow, lengths in px, icons and boxes do not. `weight` replaces
  the font weight.
- Priorities come from the nominal sizes; then the labels are measured again, before the
  grid and the candidates.
- Shrinking starts from the class size but never goes below `degrade_options.min_scale` of
  the size without a smaller class: classes may make text smaller, the ladder must not
  make it smaller than it could without them.

## Consequences
Classes buy hierarchy, not labels: on benchmark scenarios 01–07 they cost 0.4 % of the
labels, and fewer labels are shrunk by the ladder. Ambiguity falls in most dense maps and
rises in a few charts.

## Alternatives
- **Sizes set by the host**: two solves, or a second priority function.
- **Size continuous in the score**, as in word clouds: no visible hierarchy, and sizes
  that are hard to predict.
- **Classes by score thresholds**: scores depend on the normalization of their terms;
  ranks are what the priority function promises.
- **Shrinking from the class size down to `min_scale` of it**: 5 % more labels, gained by
  shrinking text to 0.65 of its nominal size — the ladder's gain, not the classes'.
