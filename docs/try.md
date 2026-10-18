---
title: Playground
description: The Label Anything engine running in your browser — maps, networks, charts, moving objects and pictures, with every option in reach.
---

# Playground

[Open the playground](https://fabian-beck.github.io/label-anything/playground/){ .md-button .md-button--primary }

The playground runs the engine in your browser — the Rust core compiled to WebAssembly,
or its TypeScript port — on six scenes. Change any option and the labels are placed
again at once; drag things around, zoom, or let them move, and the labels follow.
Everything it solves is an ordinary problem: the Code tab shows it, and the same JSON
gives the same layout in Python, Java, the CLI or your own JavaScript.

## Scenes

| Scene | What it shows | Try |
|---|---|---|
| World map | Labels inside countries where they fit (area anchors, the `internal` model), beside them or on leaders where not; Natural Earth's abbreviations as shorter alternatives; type size by importance (font classes); every pan and zoom solved again from the previous labels, so they stay put and the label set only grows as you zoom in | drag, scroll, pinch; flights cross the map as moving labeled points |
| Network | The import graph of Label Anything's own TypeScript modules under a force-directed layout: labels never cover nodes, avoid edges at a cost, and get leaders where nodes crowd | drag a node; turn packages on and off |
| Scatterplot | The countries by population, wealth, area and density, or up to 5,000 generated points; abbreviations, wrapping and leaders where it is crowded; points without a label are soft obstacles | Play moves every point to new axes |
| Line chart | Labels at the ends of moving lines: crowded ends fan out into a column (fan labels), or all labels stand in a column in the margin (boundary labels) | switch *End labels*; more series |
| Swarm | Up to 600 moving points labeled many times per second, each solve warm-started from the last | turn off *Warm start* (Motion) to see labels jump |
| Picture | A photograph as a raster obstacle (the engine reads its pixels), annotated parts labeled from the margins with elbow leaders (the `illustration` preset) | click to add a label; drop an image of your own |

## The panel

* **Options.** Each control changes one field of the [problem](concepts/problem.md),
  whose path it shows (`leaders.style`, `placement.models`, `defaults.margin`, …); a dot
  marks what you changed, *reset* restores the scene's value. *Problem JSON* merges any
  other field, and the engine's validator reports what it rejects. *Compare with naive
  labels* splits the drawing: left of the divider every label sits at its top-right, as
  plotting libraries draw them.
* **Inspect.** Hover over a label or a mark: the candidate model, side, cost and priority
  of its label — or, for an item without a label, why, and which labels are in its way.
  Below: the last solve's counts and verification (overlaps, crossings, priority
  inversions), its phases, the time and label movement per solve, and *Solve with both
  engines*, which checks that WebAssembly and TypeScript give identical placements.
* **Code.** The problem of the latest solve as JSON (or only its options), and how to
  solve it in JavaScript, Python or the CLI.
* **Copy link** puts the scene and every changed option into the address.

## How it works

The engines run in Web Workers, so the drawing never waits for a solve. While things
move, each solve starts from the previous result (`warm_start`) with a short time budget,
and the labels glide between solves ([smooth transitions](tutorials/interactive-maps.md#smooth-transitions));
once the motion stops, one more solve with the full budget and a lower stability weight
lets the labels that a better place awaits move there. Between two solves the labels
follow their anchors, so they can overlap for a moment while things move fast; at rest
the verified result shows. The buttons and boxes on the drawing are obstacles of the
class `overlay`, so labels keep clear of them.

Time budgets are those of the Rust core (100 search moves per ms); the TypeScript engine
gets 2.5 times the budget, which is the same number of moves, so both engines make the
same decisions — the TypeScript one takes longer. Labels are measured with the bundled
Noto Sans and drawn with the same font, so every box fits its text. The decisions are in
[ADR 0032](adr/0032-playground.md); the source is
[`ts/packages/playground`](gh:ts/packages/playground/README.md).

Data: countries [made with Natural Earth](https://www.naturalearthdata.com/) (public
domain); photographs from scikit-image's sample data (NASA, SpaceX: public domain; the
fundus photograph by M. Häggström: CC0), with annotation polygons by the Label Anything
contributors (CC0); the network is the project's own code.
