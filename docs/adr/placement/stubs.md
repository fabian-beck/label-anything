# Stubs

With `placement.stubs: "auto"`, a label that other marks crowd may stand off its mark by
half an em, joined to it by a short stub at a right angle to the middle of its side.

## Context
In a dense scatterplot an adjacent label touches its own mark, but other marks are often
almost as close: they keep only the margin from its box (ADR placement/margin). On the
economies chart of the home page, Mali, Senegal, Guinea and Benin sit among a dozen small
bubbles, and which label belongs to which point takes a careful look. The ambiguity cost
prefers positions away from other marks, but in a crowd every position is near one. A
distant label settles the question, but it costs a leader at least 1.5 em long and looks
like a different kind of label.

## Decision
- **Where needed only**: an adjacent or slider candidate is crowded when another item's
  mark (not of its group) comes within `placement.stub_reach` (0.75 em) of its box. It gets
  a twin at the same position, `placement.stub_length` (0.5 em) farther out, which replaces
  it when the twin has a stub and is statically feasible; otherwise it stays as it is.
  Marks larger than their font size get none: a label against a large bubble reads as
  attached to its outline. Only items' marks crowd a label, not points drawn as obstacles.
- **Shape**: a stub is horizontal or vertical and meets its label at a right angle: beside
  the label at the middle of its side (the twin of a `left` or `right` candidate is
  centered on the mark's height), above or below it within the middle half of its side.
  Diagonal positions get none.
- **Rules**: a stub keeps `leaders.clearance` (0.4 em) from other marks like every leader,
  other labels keep their spacing from it, and its label follows the rules of an adjacent
  label, where the own-mark rule allows ties: the stub says whose the label is.
- **Costs**: a stub costs `w_leader_length · len / em` (term `stub`, about 0.1) rather than
  the fixed leader cost, for which the pruning would drop it. A crowded candidate without a
  stub costs `w_leader` more (term `crowd`), so a stub, a clear position or a leader of
  about that cost is taken where one is free.
- **Report**: the stub is the label's `leader` with `stub: true`; the model stays
  `adjacent` or `slider`. Leader style, port, attachment and length limits do not apply,
  nor the diverging-leaders rule, and the uncrossing repair leaves stubs alone.
- Stubs are off by default (`placement.stubs: "off"`).

## Consequences
On the economies chart 7 labels have stubs (Myanmar, Uganda, Botswana, Mozambique, Haiti,
French Polynesia, Bhutan), each meeting the middle of its label's side; in the crowd of
small economies most labels keep their place against their own point, which the own-mark
rule makes the nearest. Stubs cost room and time: on 2,000 random points in two Gaussian
blobs, 10–20 % fewer labels and a greedy pass about twice as long (leader tests instead of
box tests). Without the option no result changes. Hosts that draw leaders draw stubs;
`@label-anything/extras` gives them the class `la-stub`, and the Python and Java results
report `stub`.

## Alternatives
- **A stub to the box point nearest the mark**: on diagonal positions that is the corner,
  in the padding beside the text, and the stub seemed to float between labels (12 of 43
  stubs on the economies chart).
- **Replacing a crowded candidate whatever became of its twin**: positions were lost where
  the twin was infeasible.
- **The label margin as a stub's distance to other marks**: 9 of 43 stubs passed within
  0.4 em of another point, and where a stub started was not clear.
- **The fixed leader cost**: the pruning dropped every stub of an item with a free plain
  position.
