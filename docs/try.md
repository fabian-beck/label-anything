---
title: Playground
description: The Label Anything engine in your browser — maps, networks, charts, moving objects and photographs with every option at hand, and a step-by-step replay of a solve.
---

# Playground

Two pages run the engine in your browser: the playground, to try every option on real
scenes, and the explainer, to step through a solve decision by decision.

## The playground

[Open the playground](https://fabian-beck.github.io/label-anything/playground/){ .md-button .md-button--primary }

Change an option and the labels are placed again; drag, zoom or let things move, and the
labels follow.

| Scene | What it shows |
|---|---|
| World map | country names inside the country, beside it or on a leader, abbreviated where it is narrow and set larger the more important; pan and zoom while flights cross the map |
| Network | the import graph of the engine's TypeScript modules under a force layout; drag a node |
| Scatterplot | countries by population, wealth, area and density, or up to 5,000 generated points |
| Line chart | labels at the ends of moving lines, in a column where they crowd or in the margin |
| Swarm | up to 600 moving points, labeled many times per second, each solve starting from the last |
| Picture | a photograph the labels avoid, its parts labeled from the margins; drop in your own image |

Each control sets one field of the [problem](concepts/problem.md) and shows its path
(`leaders.style`, `placement.models`, …). Hover a label to see why it sits there, or an
unlabeled item to see what is in its way; *Compare with naive labels* shows how a plotting
library would place them. The Code tab has the scene's problem as JSON, which gives the
same layout in Python, Java, the CLI or your own JavaScript, and *Copy link* shares the
scene with your options.

## How it works, step by step

[Open the explainer](https://fabian-beck.github.io/label-anything/playground/explain.html){ .md-button .md-button--primary }

The explainer replays a real solve of a small scene, recorded by the engine as it
decides. Step through its [phases](concepts/index.md#how-a-solve-works) — the candidates
and their costs, the greedy pass with its degradation ladder, local search, repairs, the
final check — with the numbers behind each decision, and follow any item through the
solve. The scenes are 50 European countries in three priority bands, a scatterplot,
crowded line ends, and areas with a river and a legend to avoid.

Source: [`ts/packages/playground`](gh:ts/packages/playground/README.md) (ADR
project/playground, ADR project/solve-traces). Data: countries
[made with Natural Earth](https://www.naturalearthdata.com/) (public domain); photographs
from scikit-image's sample data (NASA, SpaceX: public domain; the fundus photograph by
M. Häggström: CC0) with annotation polygons by the Label Anything contributors (CC0); the
network is the project's own code.
