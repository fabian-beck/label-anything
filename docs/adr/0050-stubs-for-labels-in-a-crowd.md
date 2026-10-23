# 0050 — Stubs for labels in a crowd

* Status: accepted (new option `placement.stubs`, spec §6.9; Rust `la-core`, TypeScript `@label-anything/core`)
* Date: 2026-10-23

## Context
In a dense scatterplot an adjacent label touches its own mark, but other marks are often
almost as close: they keep only the label margin (0.2 em) from its box. On the economies
chart of the home page, Mali, Senegal, Guinea and Benin sit among a dozen small bubbles,
and which label belongs to which point takes a careful look. The ambiguity term of the
cost (§8) prefers positions away from other marks, but in a crowd every position is near
one. A distant label with a leader settles the question, but it is costly (a leader, at
least `min_distance`, 1.5 em, away) and looks like a different kind of label.

## Decision
A new option `placement.stubs` (`off`, the default, or `auto`) lets a label that could be
read as a neighbour's stand off its point a little, joined to it by a **stub**: a short
straight leader at a right angle to the label's side.

* Only where needed: an adjacent or slider candidate is ambiguous when another item's mark
  (not of its own group) comes closer than `placement.stub_reach` (0.75 em) to its box.
  Labels of marks larger than their font size get none: a label against a large bubble
  reads as attached to its outline (with stubs on the large bubbles, Germany's, the
  United Kingdom's and France's labels moved into the room of Canada's and Spain's).
* An ambiguous candidate gets a twin at the same position with the offset
  `offset + stub_length` (0.5 em), which replaces it when the twin has a stub and is
  statically feasible; otherwise the candidate stays as it is. A first version replaced
  ambiguous candidates whatever became of the twin, and lost the positions where it was
  infeasible; keeping the plain candidate then is safe, because the rule of ADR 0051 keeps
  every plain label nearer to its own mark than to any other.
* A stub is horizontal or vertical and meets the side of the label facing the mark within
  the middle half of that side, at a right angle; a label diagonal to its mark gets none.
  In the first version a stub ran to the box point nearest the mark: on the diagonal
  positions that is the box's corner, which lies in the padding beside the text, and the
  stub seemed to float between labels (Guinea, Mali, Kazakhstan: 12 of 43 stubs).
* A stub keeps `leaders.clearance` (0.4 em) from other marks, as every leader does, and
  other labels keep the label margin from it. The first version let it come as close as
  the label margin to other marks: 9 of 43 stubs passed within 0.4 em of another point,
  one crossed one, and where a stub started was not clear.
* The label of a stub follows the label rules of an adjacent label, and so the own-mark
  rule of ADR 0051: no other mark may be nearer to it than its own, `offset + stub_length`
  away. In the first version Georgia's label, standing off its point, covered Mongolia's
  and Moldova's and was 1.5 px from Armenia's.
* The stub is reported as the label's `leader` with `stub: true`, the model stays
  `adjacent` or `slider`: hosts that draw leaders draw stubs, hosts that know them draw
  them more lightly. It costs `w_leader_length · len / em` (term `stub`, about 0.1), not
  the fixed `w_leader` (1), with which the pruning of §6.7 (`prune_factor × best + 1`)
  would drop it whenever the item has a free plain position; the label keeps the
  distance term and has no ambiguity term. A free position that needs no stub stays
  cheaper than one that does, and stubs stay cheaper than distant labels.
* `leaders.style`, `port`, `attach`, `min_length` and `max_length` do not apply to stubs,
  nor the diverging-leaders rule; the uncross repair does not move them. A warm start
  needs no rule of its own: a label that kept its stub reappears at the same place as the
  twin of its candidate, at no stability cost.

## Consequences
* On the economies chart (with `stubs: "auto"` and the defaults of ADR 0051) five labels
  have stubs, all clear of other points and labels: Mozambique, Myanmar, Botswana,
  Barbados, St. Vincent. In the crowd of small African and Asian economies a label could
  rarely stand off its point without coming nearer to another one, so most keep their
  place against their own point, which ADR 0051 makes the nearest. The first version drew
  43 stubs there, many of them unclear (above).
* Stubs take room and time: with the first version, 2,000 random points in two Gaussian
  blobs got 10–20 % fewer labels and the greedy pass took about twice as long (leader
  tests for most candidates instead of box tests). The option is off by default, and no
  result changes without it.
* Rust and TypeScript generate, cost and report stubs identically: three place cases
  (`stubs-near-other-marks`, `stubs-not-nearer` and `stubs-mark-shapes`, the last with
  concave polygon, rectangle, ellipse and circle marks) with their parity fixtures, a
  validate case, and the random problems of both test suites, which turn stubs on for a
  third of the seeds (no hard violation, crossing or priority inversion; the TypeScript
  results equal the Rust CLI's). The conformance runners check a `stub` expectation.
* The playground's scatter scene uses stubs and has a switch for them;
  `@label-anything/extras` gives stub paths the class `la-stub`; the Python and Java result
  types report `stub`, and their option builders take the three options.
* Only items' marks count as neighbours: points drawn as obstacles (vector points, SVG or
  raster ink) do not make a label ambiguous.
