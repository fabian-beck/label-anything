# 0036 — Orthogonal leaders to boundary and fan labels bend once

* Status: accepted
* Date: 2026-10-18
* Area: Candidates, leaders and costs
* Affects: spec §7, corrected to the implementation

## Context
Spec §7 said that the `orthogonal` style draws `opo` leaders (two bends) to boundary labels,
and the leaders tutorial "at most one bend (two for boundary labels)". Both
implementations draw `po` leaders instead (`boundary.rs`, `boundary.ts`; fan labels and the
joint re-stacking of boundary columns build theirs the same way): from the mark parallel to
the side up to the label's row (left and right sides) or column (top and bottom), then
straight into the label — one bend, or none when the mark is level with the label. In the
readability study of Barth, Gemsa, Niedermann and Nöllenburg (Information Visualization
18(1), 2019), `po` leaders were the recommended compromise between task performance and
preference, and `opo` leaders were not recommended (from the abstract; literature notes,
L5).

## Decision
Orthogonal leaders to boundary and fan labels stay `po`. Spec §7 and the tutorial say so,
and the conformance case `orthogonal-boundary-one-bend` checks it in both implementations
with a new expectation, `max_bends` (every leader of every placed label bends at most that
often).

## Alternatives considered

* *`opo` leaders as the spec described*: a second bend per leader, for a shape the study
  does not recommend.
* *Removing the `orthogonal` style*: it is the `po` shape the study recommends.

## Consequences
No placement changes; the parity fixtures are unchanged.
