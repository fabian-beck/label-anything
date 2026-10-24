---
title: Playground
description: The Label Anything engine running in your browser — maps, networks, charts, moving objects and pictures with every option in reach, and a step-by-step replay of how a solve decides.
---

# Playground

Two pages run the engine in your browser — the Rust core compiled to WebAssembly, or its
TypeScript port. The playground lets you try every option on real scenes; the explainer
steps through a solve, decision by decision.

## The playground

[Open the playground](https://fabian-beck.github.io/label-anything/playground/){ .md-button .md-button--primary }

Change any option and the labels are placed again at once; drag things around, zoom, or
let them move, and the labels follow. Everything the playground solves is an ordinary
problem: its Code tab shows the JSON, which gives the same layout in Python, Java, the CLI
or your own JavaScript.

| Scene | What it shows |
|---|---|
| World map | country names inside their country where they fit, beside it or on a leader where not, abbreviated where narrow, set larger the more important; pan and zoom, while flights cross the map |
| Network | the import graph of the engine's own TypeScript modules under a force layout; drag a node and the labels follow |
| Scatterplot | countries by population, wealth, area and density, or up to 5,000 generated points |
| Line chart | labels at the ends of moving lines, fanned out into a column where they crowd, or in the margin |
| Swarm | up to 600 moving points labeled many times per second, each solve starting from the last |
| Picture | a photograph as a background the labels avoid, its parts labeled from the margins; drop an image of your own |

The panel beside the drawing has four parts:

* **Options** — each control changes one field of the [problem](concepts/problem.md) and
  shows its path (`leaders.style`, `placement.models`, …); *Problem JSON* sets any other
  field, and *Compare with naive labels* shows how a plotting library would place them.
* **Inspect** — hover a label to see why it sits there, or an item without a label to see
  why not and what is in its way.
* **Code** — the problem as JSON, and how to solve it in JavaScript, Python or the CLI.
* **Copy link** puts the scene and every changed option into the address.

## How it works, step by step

[Open the explainer](https://fabian-beck.github.io/label-anything/playground/explain.html){ .md-button .md-button--primary }

The explainer runs the engine on a small scene and replays what it did. Nothing is animated
from a description: the TypeScript engine records its own decisions while it solves
(`placeTraced`), and the page checks after every solve that the WebAssembly build of the
Rust core places the labels the same way.

A timeline has one segment per [phase of the solve](concepts/index.md#how-a-solve-works):
the candidates of each item and their costs, the greedy pass in priority order with its
degradation ladder, every move of the local search, the repairs and the final check. Drag
it, play it, or step with the arrow keys; the panel says what was decided and why, with
the numbers. Hover a candidate for the terms of its cost, click a mark to follow its item
through the whole solve, or drag a mark or change an option to solve again. The scenes
are 50 European countries in three priority bands, a scatterplot, crowded line ends, and
areas with a river and a legend to avoid.

The source is [`ts/packages/playground`](gh:ts/packages/playground/README.md), the
decisions behind both pages are ADR project/playground and ADR project/solve-traces.
Data: countries [made with Natural Earth](https://www.naturalearthdata.com/) (public
domain); photographs from scikit-image's sample data (NASA, SpaceX: public domain; the
fundus photograph by M. Häggström: CC0), with annotation polygons by the Label Anything
contributors (CC0); the network is the project's own code.
