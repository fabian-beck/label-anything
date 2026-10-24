---
title: Label placement for charts, maps and diagrams
description: Label Anything places labels and leaders in scatterplots, maps, node-link diagrams and illustrations, avoiding what must stay visible, from any language.
template: home.html
hide:
  - navigation
  - toc
---

## What it does

A label belongs next to the thing it names, and it must not hide other labels or what
the picture shows. Placing hundreds of them by hand is tedious; Label Anything does it
for any chart, map or diagram, in three steps:

<div class="grid cards la-steps" markdown>

-   :material-numeric-1-circle:{ .lg .middle } **You describe**

    ---

    The items to label — points, circles, rectangles, polygons, areas — with their labels
    (text, icons, any box) and what must stay visible: other marks, lines, an SVG or a
    raster image of the chart.

-   :material-numeric-2-circle:{ .lg .middle } **It places**

    ---

    Every label goes next to its item, or out on a leader line: no two labels overlap,
    nothing protected is covered and no leaders cross. What does not fit is left out,
    least important first, and the result says why.

-   :material-numeric-3-circle:{ .lg .middle } **You draw**

    ---

    You get a box per label, its leader and its text lines, as plain coordinates: draw
    them with matplotlib, D3, Canvas, SVG or anything else.

</div>

<figure markdown>
[![The world's economies as a bubble chart, 145 of its 193 countries labeled](assets/figures/economies.svg)](assets/figures/economies.svg)
<figcaption>The world's economies: every country a bubble, sized by its GDP (Natural Earth,
2019). Label Anything labels 145 of the 193 in about a fifth of a second.</figcaption>
</figure>

One chart, the main features:

* **On the true shape.** Each label touches its bubble's outline, slid along it to where
  there is room; China's fits inside its bubble.
* **Leaders where it is crowded.** France, Italy and the United Kingdom overlap Germany's
  bubble: their labels go out on leaders, and no two leaders cross.
* **Importance decides.** The larger the economy, the earlier its label is placed; the
  eight largest are set larger and bold. 48 countries are left out: each would not fit even
  beside the larger economies' labels alone, and says which of them is in the way.
* **Shortened before left out.** A name that does not fit falls back to its ISO code
  (CRI: Costa Rica).
* **Graded avoidance over any background.** The chart is an SVG, handed over as it is and
  classified with CSS selectors: labels may cross the grid lines, never the axes, their
  text or the legend; large economies' labels may cover small economies' bubbles, at a
  cost.

The *anything* is the host and the label: adjustText (matplotlib), ggrepel (ggplot2) and
vega-label (Vega) each serve one plotting library; Label Anything is one engine and one
problem format for any chart, map or diagram, any label with a size and every language.

## Why Label Anything

<div class="grid cards" markdown>

-   :material-shield-check-outline:{ .lg .middle } **Graded avoidance**

    ---

    Per obstacle class, labels and leaders get `"hard"`, `"ignore"` or a weight. "Never
    cover outliers, covering other points costs a little, never cross a leader" is one
    line of configuration. [Avoidance](concepts/avoidance.md)

-   :material-sort-variant:{ .lg .middle } **You decide what goes**

    ---

    When not everything fits, your priority decides what is dropped — data attributes,
    outlierness, tiers, coverage per category, or a callback — and every omitted label
    says why and who is in its way. [Priority](tutorials/priority.md)

-   :material-shape-outline:{ .lg .middle } **Shape-aware**

    ---

    Circles, ellipses, rotated rectangles, polygons, paths, icons with a tip, areas.
    Labels touch the true outline; large shapes get internal labels, small ones external
    labels or leaders. [Shapes](tutorials/shapes.md)

-   :material-layers-outline:{ .lg .middle } **Any background**

    ---

    Nothing, vector shapes, an SVG classified with CSS selectors, or a raster image in
    one of five modes (ink, alpha, cost, classmap, saliency).
    [SVG](tutorials/svg-background.md) · [raster](tutorials/raster-backgrounds.md)

-   :material-equal-box:{ .lg .middle } **Deterministic**

    ---

    The same input and seed give the same result on every machine: the time budget is
    turned into an iteration budget, and floating-point work is specified operation by
    operation. [Solver](concepts/solver.md)

-   :material-code-braces:{ .lg .middle } **Every language**

    ---

    A Rust core with Python, Java, C/Go and WebAssembly bindings, a pure TypeScript
    port that reproduces its results, a CLI and an HTTP server — all on one versioned
    JSON format. [Getting started](getting-started/index.md)

</div>

Hundreds of labels take milliseconds, thousands a few hundred milliseconds. Moving
things — a dragged node, a panned map — are labeled again from the previous result, so
labels stay put ([interactive maps](tutorials/interactive-maps.md)). The
[playground](try.md) runs the engine live on a world map, a network, charts, moving
objects and photographs, with every option in reach.

## Gallery

Pictures from open data as a host would draw them, labeled by the engine (click one to see
it in full; the scripts and the problems are in
[`examples/showcase/`](gh:examples/showcase/make_showcase.py)).

<figure markdown>
[![The countries and capitals of Europe, labeled](assets/figures/europe.svg)](assets/figures/europe.svg)
<figcaption markdown>**A map.** The countries and capitals of Europe (Natural Earth,
internationally recognized borders). The countries are the picture's
[regions](concepts/regions.md): each name inside its country where it fits, else out on a
leader into the sea (the United Kingdom, Switzerland, the Balkans), never in a neighbouring
country, its type size growing with the country's area; the capitals beside their dots, in
the cartographer's order of positions; no label covers the name of a sea. 87 of the 90
labels placed: the name LUXEMBOURG (its capital is labeled), Ljubljana and Podgorica find
no room.</figcaption>
</figure>

<figure markdown>
[![A fundus photograph with its parts labeled in the margins](assets/figures/retina.svg)](assets/figures/retina.svg)
<figcaption markdown>**A photograph.** The back of an eye (fundus photograph: M. Häggström,
CC0), labeled as an anatomy atlas would: the names stacked in columns in the margins
(boundary labels), a leader from each to a dot on its part, over the photograph as a raster
background.</figcaption>
</figure>

<figure markdown>
[![The module graph of the library's TypeScript packages, labeled](assets/figures/modules.svg)](assets/figures/modules.svg)
<figcaption markdown>**A diagram.** This library's own TypeScript modules: 112 nodes, 412
imports. The most imported modules come first and are set in bold; a label may cross an
edge at a cost, never a node; in the crowded core a few labels go out on leaders. 111 of
112 placed.</figcaption>
</figure>

## Five lines

The outliers of a scatter plot, labeled from every language. The chart is an image
(`scatter.png`), `outliers.csv` lists the points to label; labels avoid the drawn dots, the
axes and the trend line, and each other ([the tutorial](tutorials/outliers.md)).

=== "Python"

    ```python
    --8<-- "examples/tutorials/python/outliers.py:five"
    ```

=== "JavaScript"

    ```js
    --8<-- "examples/tutorials/js/outliers.mjs:five"
    ```

=== "Java"

    ```java
    --8<-- "examples/tutorials/java/Outliers.java:five"
    ```

=== "C"

    ```c
    --8<-- "examples/tutorials/c/outliers.c:five"
    ```

=== "Go"

    ```go
    --8<-- "examples/tutorials/go/outliers/main.go:five"
    ```

=== "CLI"

    ```sh
    --8<-- "examples/tutorials/cli/outliers.sh:five"
    ```

All six build the same problem and get the same result: the engines are deterministic,
and the TypeScript port reproduces the Rust core bit for bit.

## Benchmark

The [real-world benchmark](project/benchmark.md) scores Label Anything and nine baselines
(naive, greedy, textalloc, adjustText, vega-label, ggrepel, ECharts, d3fc, D3-Labeler) on
twelve scenarios built from open data — software metrics, volcano plots, embeddings,
airports on a world map, city POIs on map tiles, node-link diagrams, illustrations, line
charts, stress sizes, interactive zooming and priority — with one
implementation-independent evaluator.
[What the results show](project/benchmark.md#what-the-results-show): no overlaps and no
crossing leaders anywhere, the most usable labels on every problem of the quick suite and
on 60 of the 62 of the full suite,
though often by a few percent — and where it still falls short: dense data, moving labels,
the largest problems' speed.

## Good to know

!!! warning "Experimental, developed by AI"

    Label Anything is still experimental and under active development, not
    production-ready software. It is written mostly by an AI coding assistant (Claude Code)
    with limited human oversight, code and documentation alike: expect mistakes, and check
    the results that matter to you. The problem format, the APIs of the language bindings
    and the placements themselves can change without deprecation. Try it and report what
    you find.

* **Not on the registries yet.** The packages are built from this repository for now
  ([getting started](getting-started/index.md)).
* **Labels for points and areas.** Labels go to points and areas of any shape; lines such
  as roads or rivers are obstacles, not labeled features.
* **Labels in graphics, not labeled data.** Label Anything places labels in pictures: it
  is not a tool for labeling data, and it is unrelated to the few-shot segmentation model
  of the same name (ECAI 2025).

## Where next

* [Getting started](getting-started/index.md) in Python, JavaScript/TypeScript, Java, C,
  Go or on the command line.
* [Tutorials](tutorials/index.md): one task each, with code that runs in CI and a figure of
  its result.
* [The benchmark's gallery](https://fabian-beck.github.io/label-anything/benchmark-report/gallery/):
  charts, maps, photos, embeddings and networks from the benchmark, next to other labelers.
* [Concepts](concepts/index.md): the problem and result formats, avoidance, candidates,
  presets, the solver.
* [Reference](reference/index.md): the specification, defaults, presets, schemas and APIs.
