# 0054 — Clear labels in crowds: centered stubs, the crowd cost, a clear margin, label spacing

* Status: accepted (new option `defaults.spacing`; `placement.own_nearest` and `placement.stubs` extended; spec §4.4, §6.6–§6.9, §8; Rust `la-core`, TypeScript `@label-anything/core`; the economies chart of the home page). Amends ADR 0051 for labels without a stub.
* Date: 2026-10-24

## Context
On the economies chart of the home page (ADR 0050–0053) a few labels still did not say
whose they were, and the labels stood close together:

* North Korea's label stood under its bubble and Cameroon's, which touch it: 1.0 px from
  its own bubble, 1.4 px from Cameroon's. Norway's stood under Singapore's bubble, only its
  corner against Norway's (1.0 px against 2.2 px). The rule of ADR 0051 allows both: it
  only forbids another mark to be nearer than the own one.
* A stub beside a label (left or right) met the label's side anywhere within its middle
  half: Honduras's met it near the top corner, so that the stub seemed to point past the
  label rather than to join it.
* A label in a crowd took a plain place among other points where a stub would have said
  whose it is: a stub costs its length, a plain place in a crowd nothing extra.
* Labels kept the label margin (0.2 em, ADR 0028) from each other as from other marks: with
  the padding their letters stood about 0.5 em apart, closer than the lines of one label,
  so that neighbouring labels could read as one. Long names (United States of America) ran
  on one line.

## Decision
* **Centered stubs beside a label.** The twin of a `left` or `right` candidate (§6.9) is
  centered vertically on the mark's reference point, and a horizontal stub is made only for
  such a box (`|p.y − c.y| ≤ EPS`): it meets the middle of the label's side. Stubs above
  and below a label keep meeting the middle half of its side.
* **The crowd cost.** With `placement.stubs: "auto"`, an adjacent or slider candidate
  without a stub that another item's mark comes nearer than `stub_reach` costs `w_leader`
  more (term `crowd`, §8): a stub, a clear position or a leader of about that cost is taken
  where one is free.
* **Clearly nearest.** Without a stub a label must be nearer to its own mark than to any
  other by its margin: it is infeasible when
  `dist(mark_j, box) < dist(mark_i, box) + min(m, |p_j − p_i|) − EPS` (`p` the marks'
  reference points). With a stub the tie rule of ADR 0051 stays: the stub says whose the
  label is. The cap keeps coincident marks labelable as before (their label names the
  spot), and marks closer together than the margin are labeled on the sides away from each
  other. ADR 0051 allowed ties so that a label beside a column of touching points stayed
  possible; such a label is as near to the neighbours as to its own point, and now needs a
  stub or a leader.
* **Label spacing.** A new option, `defaults.spacing`, is the space a label keeps from other
  labels and their stubs: the larger spacing of the two items, at least their margin (half
  for warm-start candidates), by default (`null`) twice the margin — 0.4 em, so that with
  the padding the letters of two labels stand 0.7 em apart, farther than the lines of one
  label. The margin stays the space from other items' marks; a problem that changes it
  changes the spacing with it (`margin: 0` lets labels touch, as before). Boundary and fan
  columns stack their labels the larger of their gap and the two label gaps apart.
* **Explanations.** A probe candidate in conflict with a label that comes closer than the
  label gap counts as `labels` in `blocking`, not as `leaders`: since ADR 0028 a label
  conflict needed no overlap, and the wider spacing made the misreport frequent.
* The economies chart breaks a name wider than 9 em into two balanced lines (a wrap width
  of 0.6 of its width, at most two lines).

## Consequences
* The economies chart labels 149 of 195 countries (156 before), with 35 leaders (25) and 7
  stubs (3): Myanmar, Uganda, Botswana, Mozambique, Haiti, French Polynesia and Bhutan,
  each meeting the middle of the label's side. No label stands about as near to another
  bubble as to its own: Cameroon is labeled instead of North Korea, on its side away from
  it; Namibia, Gabon and Bahrain go out on leaders; Austria, Norway and Hong Kong have no
  clear place and are left out (`no_feasible_candidate`). Five long names take two lines.
* Where labels are dense, fewer fit and more need leaders. Over 49 problems (the
  conformance samples, the tutorial problems, the home page examples and the playground's
  scenes) 1,380 labels are placed (1,427 before; 1,350 on the main branch, before ADR
  0050). The playground's map places 132 (148), the network 86 (90), the scatterplot 194
  (201) with 16 stubs (10) and 37 leaders (23); the line chart and the swarm keep all
  their labels. `many-points` places 197 of 200 (200): its piles of near-coincident points
  get fans. The priority tutorial places 34 of 40 cities (37): Aukel, the third largest,
  lies between Talkel and Linheim and has no clear place, so `prefix` omission stops there.
  `strict-repair` (margin 0) is unchanged.
* The solves take longer: 496 ms over the 49 problems (443 before, 424 on the main
  branch), mostly because more labels need leaders, whose candidates are generated on
  demand, and the local search has more conflicts to resolve with the wider spacing. The
  playground's map takes 95 ms (79; main 67), in TypeScript 237 ms (main 177). Crowds of
  ellipse marks pay most: the distance of an ellipse to a box is a ternary search along
  each side of the box, and the rules ask for more such distances. 32 small ellipses in a
  crowd take 620 ms (310 on the main branch), 980 ms with stubs; circles take 8 ms. The
  place case `stubs-mark-shapes` now holds 20 marks of every shape instead of 32 (70 ms
  instead of 240 ms), well within the time guard on a busy machine.
* The WebAssembly module grows to 997,757 bytes gzipped (995,894 before), 2.2 KB under the
  budget of 1,000,000.
* Parity fixtures, golden images, figures and the outputs quoted in the tutorials were
  regenerated. New place cases test each rule: `stubs-crowd`, `stubs-crowd-off`,
  `own-nearest-clear`, `own-nearest-clear-stub`, `label-spacing`, `label-spacing-margin`
  and `label-spacing-twice-margin`; `boundary-column` and `fan-always` follow the spacing.
* `defaults.spacing` is new in the schema, the Python (`spacing=`) and Java (`spacing(…)`)
  bindings and the documentation; results change for any problem with dense labels, as
  `own_nearest` (default on) is stricter and labels keep more space.
