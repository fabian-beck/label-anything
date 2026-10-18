---
title: How it works
description: Step through a real solve of the Label Anything engine — candidates and their costs, the greedy pass with its bands and ladder, local search, and the final checks.
---

# How it works

[Open the explainer](https://fabian-beck.github.io/label-anything/playground/explain.html){ .md-button .md-button--primary }

The explainer runs the engine on a small scene and lets you walk through what it did,
decision by decision. Nothing is animated from a description: the TypeScript engine
records its own decisions while it solves (`placeTraced`, ADR 0046), and the page replays
them. The same problem solved by the WebAssembly build of the Rust core gives the same
placements, which the page checks after every solve.

## What you see

The timeline under the drawing has one segment per phase of the solve; drag it, play it,
or step with the arrow keys (Shift + arrow: the next decision; Page Down: the next
phase). For each step, the drawing shows the labels as they stand and the candidates the
step is about, and the panel says what was decided and why, with the numbers.

| Phase | The steps |
|---|---|
| Prepare | the items and their priority bands (the marks' colors) |
| Candidates | per item, the [candidate positions](concepts/candidates.md) and their static costs: usable ones shaded by cost, those that break a hard rule dashed, the positions the occupancy grid rejected before building them counted |
| Greedy | per band: the item taken next (the most constrained: the fewest free candidates), the scores of its free candidates — static cost, cost against the labels placed so far, lookahead for the cheapest (up to eight) — the placement and the waiting candidates it rules out (crossed out), deferrals, the steps of the [degradation ladder](concepts/candidates.md#the-degradation-ladder), omissions |
| Local search | every move: relocate, swap, insert; its cost change, the temperature, and whether the Metropolis rule accepted it; a chart of the cost over the moves |
| Repairs | [fan labels](concepts/candidates.md#fan-labels), boundary columns, uncrossing, priority repair — where they change anything |
| Verify | the independent check of every hard rule, and the result |

Hover a candidate for the terms of its cost; click a mark or a label to follow that item
through the whole solve (its steps are listed in the panel); drag a mark to move it, or
change an option (strategy, number of moves, seed, candidate models, lookahead, the ladder,
the font size): the engine solves again and you stay at the same point of the phase. The
*Problem JSON* section has the problem, which gives the same result in any binding.

## Scenes

| Scene | Shows |
|---|---|
| Europe | 50 countries at their label points ([Natural Earth](https://www.naturalearthdata.com/), public domain) in three priority bands by population; the small states of the middle run the ladder — abbreviations, a smaller font — and one stays without a label |
| Scatterplot | points of one priority: the greedy pass places the most constrained first; points whose every position covers another mark are deferred; local search improves the greedy result |
| Line ends | the ends of lines crowd; the fan pass stacks their labels in a column with fanning leaders |
| Areas & obstacles | internal candidates of areas, a river that costs (soft) and a legend box no label may cover (hard) |

The source is [`ts/packages/playground/src/explain`](gh:ts/packages/playground/README.md);
the trace is `placeTraced` of [`@label-anything/core`](reference/javascript-api.md).
