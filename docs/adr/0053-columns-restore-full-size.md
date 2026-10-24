# 0053 — Columns take shrunk labels at their full size

* Status: accepted (spec §6.6, §6.8; Rust `la-core`, TypeScript `@label-anything/core`)
* Date: 2026-10-24

## Context
A fan column (§6.8) and a boundary column (§6.6) take the labels the search placed in
their way with the variant they were placed with. When the ladder's `shrink` step had
made that label smaller so that it fit beside its mark, the column kept it small, though
in the column it no longer had to squeeze between other marks: one label of a column of
line ends was set at 8.67 px among labels of 12 px. Since label boxes fit the ink of their
text (ADR 0052), a shrunk label fits beside a crowded line end more often (between ends
4 px apart), so columns met such labels more often too.

## Decision
* A column member placed with a variant of the `shrink` step takes the variant it was
  made from: the first variant at scale 1 with the same text (lines, origin and
  truncation), or the first at scale 1 of a label without text. Members without a label
  take their first variant, as before.
* The column is laid out at full size first. When it fails (a member statically
  infeasible or in conflict; for re-stacking also: not cheaper) and a member's label is
  shrunk, it is laid out again with the placed variants, as before this decision, and the
  repair steps of the column work on that layout. A column that fits at full size is
  never given up for a shrunk one; one that fits only at the placed sizes still forms.
* The second layout counts toward the work limit of the pass like any other. As before, a
  fan label takes the level of its variant (so a label at full size reports no `shrink`
  step) and a boundary label the rank and level of its placed candidate; its degradation
  steps are those of the variant it shows.

## Consequences
* Columns of line ends no longer mix type sizes for no reason: with the ends of the place
  cases `fan-full-size` and `boundary-column-full-size`, 4 px apart, the labels the search
  shrank (to 8.67 px) stand in the column at 12 px like the others.
* Nothing else changes: no sample problem, parity fixture, scene of the playground,
  tutorial problem or figure of the documentation has a shrunk label in a column, and
  their results are the same. Columns without shrunk members are laid out once, as before.
* Rust and TypeScript lay columns out identically; the two new place cases have parity
  fixtures and are checked by the three conformance runners.
