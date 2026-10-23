# 0051 — A label's own mark is the nearest

* Status: accepted (new option `placement.own_nearest`, default `true`, spec §4.4; Rust `la-core`, TypeScript `@label-anything/core`; the economies chart of the home page)
* Date: 2026-10-23

## Context
The label margin (§4.4, ADR 0028) keeps other items' marks 0.2 em from a label, while the
label touches its own mark at `placement.offset` (1 px). Two exceptions let other marks
come closer: the margin is never more than the other mark keeps from the own mark, so
that touching marks can still be labeled, and the marks of less important items may be
covered when `lower_items` is soft (ADR 0040). The economies chart of the home page used
the second one (`lower_items` 1.5): of its 149 labels, 30 covered another country's
bubble, and 15 more were nearer to another bubble than to their own — Georgia's label lay
over Mongolia's and Moldova's points, Thailand's was 0.4 px from Colombia's bubble and 1 px
from its own. A reader takes a label for the label of the point it is nearest to.

## Decision
* A new rule, on by default: a label without a distant leader — an adjacent or slider
  label, with or without a stub (ADR 0050) — comes no closer to the mark of another item
  than to its own. It applies to the marks the label may not cover (`items`, or
  `lower_items` for less important items, hard), not to the members of its own group;
  internal labels (on their own mark) and distant labels (whose leader says whose they
  are) are exempt. `placement.own_nearest: false` turns it off.
* Ties are allowed (`dist(other) < dist(own) − EPS` is infeasible): a label beside a
  column of touching points stays possible, as it is as near to the neighbours as to its
  own point but not nearer.
* The economies chart keeps to the defaults: its labels may no longer cover the bubbles
  of smaller economies, nor its leaders pass over them.

## Consequences
* The economies chart labels 158 of 195 countries (149 before): no label covers another
  bubble or is nearer to one than to its own, so smaller economies no longer lose their
  labels to the larger ones that covered their points. The price is in the crowd of large
  bubbles around Germany: Canada, Taiwan, Belgium and Austria are left out (Canada's
  bubble lies among larger ones its label may not cover, and no leader can leave it while
  keeping its clearance from them), and more names fall back to their ISO codes. With
  leaders that may pass over smaller bubbles (`avoid.leader.lower_items` 0.5) Canada keeps
  its label but Spain loses its own, and 152 labels fit.
* Elsewhere the rule rarely bites, because the margin already keeps other marks farther
  than the own one: on the conformance problems only `strict-repair` (no margin) changes,
  and it keeps the settings it was found with (`own_nearest: false`); the parity fixtures
  of `leaders-angles` and `many-points` place their labels differently, as many as before.
  Of the playground's scenes, the map, the line chart and the swarm are unchanged, the
  network loses one of 81 labels and the scatterplot two of 191.
* Two place cases (`own-nearest`, `own-nearest-off`) and a validate case test the option;
  the conformance runners re-check an `own_nearest` expectation independently (for circle
  marks).
* The map preset and the plotting helpers keep letting important labels cover the marks
  of less important items (ADR 0045); the rule then does not protect those marks, whose
  items go unlabeled as before.
