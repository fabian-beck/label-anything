# Solve traces

The TypeScript core can record every decision of a solve, which the explainer replays to
show how the real algorithm works.

## Context
The documentation describes the algorithm in prose, and the playground shows results.
Neither shows how a result comes about: why one item is placed before another, which
candidates a label rules out, why a label moves during the search. An animation drawn from
a description would explain a simplified algorithm and drift from the real one.

## Decision
- `placeTraced(env, problem, profile)` solves like `placeWith` and also returns the
  solver's decisions in order: the candidates and what became of each, the bands, every
  greedy pick with its costs, placements and what they rule out, ladder steps, evictions,
  local-search moves and the passes after the search. Each event carries the placement
  changes since the previous one, so any step can be replayed.
- A tracer only observes: it never changes the state or draws a random number, and an
  untraced solve pays one null check per decision. A test requires traced solves to match
  the Rust results bit for bit.
- Traces exist in TypeScript only. They are a teaching and debugging tool, not part of the
  problem or result format, so the Rust core and the bindings have no counterpart.
- The explainer (`<site>/playground/explain.html`) solves small scenes with traces and
  lets the reader step through them, drag marks and change options.

## Consequences
The explainer stays true to the solver, because it replays it. A trace holds every
local-search move, 10,000 by default: fine for tens of items, not meant for large
problems.

## Alternatives
- **Precomputed traces**: no options for the reader to pick, and they age with the solver.
- **Tracing in Rust as well**: a second implementation of a debugging aid, and a wire
  format for it in every binding.
