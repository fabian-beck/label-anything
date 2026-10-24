# 0027 — Warm starts nudge blocked boxes, keep leaders, and prefer near moves

* Status: accepted
* Date: 2026-10-17
* Area: Warm starts and transitions
* Affects: spec §6.7, §8, §10.1
* Amends: [ADR 0016](0016-warm-start-and-stability.md) (the stability term),
  [ADR 0025](0025-warm-starts-follow-anchors.md) (the stability cost it rejected)
* Amended by: [ADR 0028](0028-label-margin.md) (warm-start candidates keep half the label
  margin)

## Context
With warm starts (ADR 0016, ADR 0025) and smooth transitions (ADR 0026), labels of a
moving graph still looked nervous: small changes of the layout made labels jump. On the
Les Misérables sequences of scenario 11, warm-started, labels moved by more than 10 px
relative to their node 186 times while one node was dragged, 83 times while their own
node moved less than 3 px (22 times less than 1 px); late in the running force layout,
when the median node moves less than 1 px between solves, 0.5 labels still jumped (by
more than 1 em) per solve, 28.7 px of label movement. Classifying the moves by what
blocked the label's previous box:

* **Tight fits.** A box that touched another mark or label exactly is blocked by the
  next sub-pixel move: in the drag sequence, 28 boxes were blocked by at most 1 px. The
  label then went to the best free candidate anywhere, not next to its old place.
* **Long moves cost no more than short ones.** The stability term `min(1, d/em)` is
  capped at 1 em: once a label has to move by more than 1 em, every place costs the
  same, and quality alone picks one, often on the far side of the node. The labels it
  displaces in turn move as well (cascades: about 40 % of the moves were labels whose
  old box another moved label had taken).
* **Leadered labels had no warm candidate** with the `angles` style of the `graph` preset
  (only straight leaders had one): they were placed again from scratch at every solve,
  and 26–28 % of them jumped per solve, against 5 % of the others, by 15–19 px on average.

## Decision
* **Nudges.** When the previous box of an item lies on its slider path (§6.2) but is no
  longer free, the solver tries that box moved along the path by 0.05, 0.1, 0.2, 0.4 and
  0.8 em in both directions, before the band's level-0 pass, and takes the free one of
  the smallest step (§6.7, §10.1). A label pushed by 0.3 px moves by 0.6 px.
* **Kept leaders.** With the `angles`, `elbow` and `orthogonal` styles, the leader of a
  `warm_start` entry, moved like its box, makes the box a distant warm-start candidate,
  when it still starts at the item's mark, ends on the box and keeps to the style's
  directions (§6.7). The previous result passed as it is carries those leaders; the
  benchmark's shifted warm starts now shift them too.
* **Near moves.** The stability term grows on beyond 1 em, by 1/4 per em up to 5 em:
  `w_stability · (min(1, d/em) + min(1, max(0, d/em − 1)/4))`, at most 2. A label that
  must move goes to a near free place rather than to the best one anywhere, and leaves
  its place for a better one only when that is clearly better. ADR 0025 rejected a
  similar term because it traded jumps for labels added and removed. On top of the nudges
  and the kept leaders it does not (labels added and removed per frame: force 2.05 →
  2.02, drag 1.48 → 1.43, pan and zoom 52.8 → 53.3), and it removes about 40 % of the
  jumps in the solves in which the median node moves less than 1 px (force 0.66 → 0.39,
  drag 1.20 → 0.70 per solve), the moves this decision is about.

## Alternatives considered

* *A higher `weights.stability` (2 or 4)*: fewer jumps late in the force layout (0.34 and
  0.29 per solve) but every small move costs as much more, and labels that once needed a
  leader keep it (3.6 leadered labels on average became 4.2 and 10.0).
* *Degraded labels grow back only in place*: 0.29 jumps per solve late in the force
  layout, but shrunk labels stay shrunk (2.9 per frame on average became 15.4).
* *Penalizing a candidate that takes the warm box of a label still to be placed*
  (cascade damping in the lookahead): better on two sequences, worse on two others.
* *Half the tail (at most 1.5)*: about the same loss in label quality, more jumps.

## Consequences
Deterministic runs, warm-started with the previous result, before → after: mean
displacement / side changes / jumps on `force-lesmis` 2.91 px / 7.8 % / 6.0 % → 2.28 px /
6.9 % / 5.5 %, on `drag-lesmis` 2.99 px / 8.5 % / 6.3 % → 2.32 px / 6.8 % / 4.8 %, on
`zoom-pan-1000` 3.03 px / 12.1 % / 8.4 % → 2.79 px / 11.1 % / 7.9 % and on
`zoom-pan-3000` 3.80 px / 15.5 % / 11.0 % → 3.46 px / 14.3 % / 10.1 %. Late in the force
layout, 0.39 labels jump per solve (18.3 px of movement, from 28.7); in the solves of the
drag sequence in which the median node moves less than 1 px, 0.70 instead of 1.20.
Leadered labels jump in 20 % (force) and 12 % (drag) of the solves, by 12 and 7 px on
average.

Stability costs some label quality: the labels' summed cost without the stability term
is 3–7 % higher over the sequences (labels keep places a fresh solve would improve on).
One more solve with a lower `weights.stability` once the layout has come to rest
recovers it with few moves: with 0.3, 4 to 5 of the 77 labels move by more than 1 em,
and the settled force layout ends up cheaper (58.6) than before this change (60.8).
The nudges, the kept leaders and the new term apply only with `warm_start`; results
without one are unchanged.
