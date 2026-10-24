# 0046 — Solve traces and an explainer of the algorithm

* Status: accepted
* Date: 2026-10-18
* Area: Documentation site
* Affects: TypeScript `@label-anything/core` `placeTraced`, `ts/packages/playground`
  `explain.html`

## Context
The documentation describes the algorithm in prose (candidates and their costs, the
greedy pass with its bands and ladder, local search, the passes after it), and the
playground shows what comes out of it. Neither shows how the result comes about: why
an item is placed before another, which candidates a label rules out, why a label moves
during the search. An animation drawn from a description of the algorithm would explain
a simplified algorithm, not the one that runs, and would drift from it.

## Decision
* **A trace of the real solver.** `placeTraced(env, problem, profile)` of
  `@label-anything/core` solves like `placeWith` and returns, besides the result, the
  solver's decisions in order: the candidates generated per item (with what became of
  each: kept, pruned, beyond `k_distant`, blocked by a placed label, and the positions the
  occupancy grid rejected before building them), the bands, the item the greedy pass
  takes next with its number of live candidates, the scored free candidates (static,
  dynamic and lookahead cost), each placement with the waiting candidates it rules out,
  deferrals, ladder steps, evictions and omissions, every local-search move (kind, item,
  candidates, cost change, temperature, outcome), and the passes after the search. Every
  event carries the placement changes since the previous one, so the placement after any
  event is a replay. Candidates are numbered by the trace (the solver reuses ids of
  candidates it drops again); their costs and per-term breakdowns are read when the solve
  ends.
* **An observer, nothing more.** A `Tracer` is attached to the `Solve` (`trace`, null
  otherwise) and called at the decisions; it reads the state, never changes it and never
  draws a random number. The calls are guarded by a null check, so an untraced solve
  pays one comparison per decision (no measurable difference on the conformance
  problems). A test solves every parity fixture traced and requires the Rust result bit
  for bit, and a replay of the trace that gives the result's placements.
* **TypeScript only.** The trace is a teaching and debugging tool, not part of the
  problem or result format, so the Rust core has no counterpart; the two make the same
  decisions, and the explainer shows that the WebAssembly build gives the same
  placements.
* **The explainer** (`<site>/playground/explain.html`, built with the playground) solves
  small scenes in a worker with `placeTraced` (no clock, the Rust core's budgets) and lets
  the reader walk the trace: a timeline of the phases (scrub, play, step, jump to the next
  decision or phase), the drawing as it stands after the step with the candidates the
  step is about (free ones shaded by cost, ruled-out ones crossed, a move's arrow), a
  plain-language explanation built from the event's numbers, tables of scores, a chart of
  the search's cost and temperature, the cost terms of any candidate on hover, and one
  item followed through the solve. Marks can be dragged and options changed; each change
  solves again and keeps the reader's place in the phase. Four scenes: European countries
  (Natural Earth; three priority bands, abbreviations as alternatives), a scatterplot (one
  band, most constrained first), line ends (fan labels), areas with a soft and a hard
  obstacle.

## Alternatives considered

*Precomputed traces* (no option the reader picks, and they would age with the solver);
*instrumenting the Rust core* as well (a second implementation of a debugging aid, and a
wire format for it in every binding, for no reader the TypeScript trace does not serve);
*recording every state change* of the solver (local search places and removes labels for
every tentative move; the net change per event is what a reader can follow).

## Consequences
The explainer needs no data of its own beyond the playground's: its scenes are a few
hundred lines of problem building. A trace holds every local-search move as an event
(10,000 by default), which is fine for the explainer's scenes (tens of items) but not
meant for large problems. The playground's unit tests check, for each scene and several
option variants, that the free candidates the explainer shows at each greedy pick are as
many as the solver counted, and its browser tests that every scene solves, matches the
WebAssembly engine and can be stepped, dragged and re-solved.
