# 0016 — Warm starts: the previous box as a candidate, kept first when still free

* Status: accepted
* Date: 2026-10-16

## Context
Interactive hosts (maps re-labelled on pan and zoom, js-extras layers) pass the previous
result as `warm_start`; labels should not jump. The first benchmark run of scenario 11
(30 zoom/pan frames, 1,000 airports) showed a mean displacement of 23.8 px against
3.65 px for the naive greedy baseline: the stability cost term (`w_stability ·
min(1, displacement/em)`) cannot keep a label at its old position when that position
is not among the generated candidates, and newly visible items claimed old spots first.

## Decision
* The warm box of an item becomes a level-0 candidate of the variant of the same size:
  slider-kind on the side its center points to when it touches the inflated mark, else
  distant with a straight leader (straight style only).
* Within each priority band, before the most-constrained-first pass, items whose warm
  candidate is still free keep it (skipped when `weights.stability` is 0). Priority is
  unaffected because this happens inside a band.

## Consequences
Scenario 11: mean displacement 23.8 → ~13 px, median 0; the remaining moves are mostly
ladder labels whose old box now conflicts with background detail revealed by zooming,
which is intended. Without `warm_start` nothing changes.
