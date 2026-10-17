# 0025 — Warm starts follow their anchors; degraded labels keep their box

* Status: accepted (spec §6.7, §10.1, §11); the stability cost growing beyond 1 em,
  rejected below, was adopted in another form by ADR 0027
* Date: 2026-10-17

## Context
Warm starts (ADR 0016) were measured on pan and zoom only. Points that move on their own
are just as common: a force-directed graph layout that is still running, a node the user
drags, animated data. Scenario 11 gained two such sequences of the Les Misérables graph
under a d3-force-style simulation (`force-lesmis`: 61 frames, every 4th of the first 240
ticks; `drag-lesmis`: 41 frames, one node dragged through the settled layout), next to the
airport sequences `zoom-pan-1000` and `zoom-pan-3000`.

Two weaknesses showed up:

* **The previous result did not work as a warm start.** The engine compared the previous
  boxes with the new candidates where they were. For moving points a host had to move every
  box with its anchor first (the bench runner and the JavaScript helpers did; the Python
  stability tutorial needed a `follow` function). Passed as is, the previous result was
  worse than no warm start on pan and zoom (side flips 40 % against 32 % cold): labels
  were pulled to where their points had been.
* **Degraded labels jumped.** A label the previous solve had shrunk (or wrapped, or
  shortened) has a box of a ladder variant; only level-0 variants got a warm candidate.
  Such a label ran the ladder again, and the `distant` step, which comes before `shrink`,
  often moved it away with a leader although its small box was still free. Labels that
  switched size made 30 % of the remaining jumps (moves of more than 1 em) on pan and
  zoom.

## Decision
* **Results report `anchor`.** Every placed label reports its item's reference point in
  canvas px (the anchor; the pole for area items). A `warm_start` entry that comes with an
  `anchor` is moved by the item's anchor movement, `box + (reference − anchor)`, before it
  is used; an entry without one is used where it is. The previous result can be passed as
  it is, in every binding; boxes that a host moved itself (no `anchor`) are unaffected.
* **A degraded label keeps its box while it is free.** When an item's level-0 attempt
  fails and its warm box has the size of no level-0 variant, the ladder's steps run in
  order (`evict_lower` and `soft_overlap` skipped) until one creates a variant of that
  size; the box becomes a candidate of that variant and level, made as for level 0
  (slider-kind next to the mark, else distant with a straight leader). When it is
  statically feasible and free the item takes it, before the ladder runs. Level 0 keeps
  precedence: a label that fits at full size again grows back.

Measured and rejected (the sequences above; jumps = labels whose offset from their anchor
changed by more than 1 em, churn = labels added and removed per frame):

* *Charging the lookahead for the warm candidates a candidate kills* (`w_stability` per
  item): neutral (jumps: force +0.5 points, drag −0.3, zoom/pan −0.1 to −0.3).
* *Keeping a degraded box at level 0* (before the full-size label is tried elsewhere):
  7–10 % fewer jumps, but labels shrunk while the layout was still moving stay shrunk —
  14 shrunk labels at the end of the force layout instead of 2.
* *A stability cost that keeps growing beyond 1 em* (`min(1, d/em) + ½·min(1, d/4em)`):
  3–9 % fewer jumps and 5–11 % fewer side flips, but more labels added and removed
  (force +5 %, drag +10 %): about as many changes per frame, so the simpler cost stays.
* *Not displacing a label at its warm box to insert a lower-priority label* (local
  search): one label fewer on zoom/pan for 1 % fewer jumps.
* Warm candidates of distant labels with other leader styles than straight are not made:
  the octilinear and orthogonal leaders would have to be routed to an arbitrary box, for
  3–4 leadered labels per frame on the graph.

## Consequences
Deterministic runs (no clock), default settings, warm start = the previous result:

| sequence | | displacement | side flips | jumps | added + removed |
|---|---|---|---|---|---|
| `force-lesmis` | cold | 4.89 px | 12.2 % | 11.4 % | 133 |
| | ADR 0016 | 2.95 px | 7.7 % | 6.1 % | 129 |
| | now | 2.91 px | 7.8 % | 6.0 % | 121 |
| `drag-lesmis` | cold | 7.55 px | 17.8 % | 17.0 % | 80 |
| | ADR 0016 | 3.01 px | 8.5 % | 6.3 % | 65 |
| | now | 2.99 px | 8.5 % | 6.3 % | 73 |
| `zoom-pan-1000` | cold | 9.10 px | 32.0 % | 27.7 % | 935 |
| | ADR 0016 | 3.58 px | 13.1 % | 9.6 % | 896 |
| | now | 3.01 px | 11.6 % | 8.4 % | 859 |
| `zoom-pan-3000` | cold | 9.77 px | 36.7 % | 30.6 % | 2,429 |
| | ADR 0016 | 4.48 px | 16.5 % | 12.5 % | 2,189 |
| | now | 3.81 px | 15.5 % | 11.0 % | 2,158 |

(ADR 0016 = the previous engine with boxes moved by the host; added and removed count
items visible in both frames.) On the graph the degraded-box rule is neutral (it rarely
applies: 2–4 shrunk labels per frame; five more drag and force sequences, other nodes and
charges, agree), on the maps it removes an eighth of the jumps and places 1–4 more labels
per frame. Labels shrunk while the points moved stay shrunk as long as their box is free
(31 instead of 27 per zoom/pan frame, fewer leadered ones instead): a solve without
`warm_start` gives the best static layout once the movement stops. Results grow by the
`anchor` of each placed label. The remaining jumps are mostly forced: a node moved into
the label (40 % on the force layout), a label's box left the canvas (zoom/pan), or the
local search moved a label to make room for one more.
