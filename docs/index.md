---
title: Label placement for charts, maps and diagrams
description: Label Anything places labels and leaders in scatterplots, maps, node-link diagrams and illustrations, avoiding what must stay visible, from any language.
template: home.html
hide:
  - navigation
  - toc
---

## What it does

A label belongs next to what it names and must not hide other labels or the picture.
Placing hundreds by hand is tedious; Label Anything does it for any chart, map or diagram,
in three steps:

<div class="grid cards la-steps" markdown>

-   :material-numeric-1-circle:{ .lg .middle } **You describe**

    ---

    The items to label — points, shapes, areas — with their labels (text, icons, any
    box), and what must stay visible: other marks, lines, the chart as SVG or image.

-   :material-numeric-2-circle:{ .lg .middle } **It places**

    ---

    Each label goes next to its item or on a leader line. No labels overlap, nothing
    protected is covered, no leaders cross. What does not fit is left out, least
    important first, with the reason.

-   :material-numeric-3-circle:{ .lg .middle } **You draw**

    ---

    You get each label's box, leader and text lines as plain coordinates, to draw with
    matplotlib, D3, Canvas, SVG or anything else.

</div>

<figure markdown>
[![The world's economies as a bubble chart, 150 of its 195 countries labeled](assets/figures/economies.svg)](assets/figures/economies.svg)
<figcaption>The world's economies: each country a bubble sized by its GDP (Natural Earth,
2019). Label Anything labels 150 of 195 in about a quarter of a second.</figcaption>
</figure>

In this chart:

* **On the true shape.** Each label touches its bubble's outline where there is room;
  China's sits inside its bubble.
* **Leaders where it is crowded.** France, Italy and the United Kingdom overlap Germany's
  bubble, so their labels sit on leaders that do not cross.
* **Importance decides.** Larger economies are labeled first, the eight largest in larger
  bold type. The 45 countries left out have no room beside the larger economies' labels;
  the result names the labels in each one's way.
* **Shortened before left out.** A name that does not fit falls back to its ISO code
  (CRI: Costa Rica).
* **Graded avoidance over any background.** The chart is an SVG, passed unchanged and
  classified with CSS selectors: labels may cross grid lines but never the axes, their
  text or the legend; large economies' labels may cover small economies' bubbles, at a
  cost.

## Why Label Anything

The *anything* is the host and the label: adjustText (matplotlib), ggrepel (ggplot2) and
vega-label (Vega) each serve one plotting library; Label Anything is one engine and one
problem format for any chart, map or diagram, any label with a size and every language.

<div class="grid cards" markdown>

-   :material-shield-check-outline:{ .lg .middle } **Graded avoidance**

    ---

    Per obstacle class, labels and leaders get `"hard"`, `"ignore"` or a weight. "Never
    cover outliers, covering other points costs a little, never cross a leader" is one
    line of configuration. [Avoidance](concepts/avoidance.md)

-   :material-sort-variant:{ .lg .middle } **You decide what goes**

    ---

    When not everything fits, your priority decides what is dropped: data attributes,
    outlierness, tiers, coverage per category or a callback. Each omitted label reports
    why and what is in its way. [Priority](tutorials/priority.md)

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

    The same input and seed give the same result on every machine: the time budget is an
    iteration count, and floating-point work is specified operation by operation.
    [Solver](concepts/solver.md)

-   :material-code-braces:{ .lg .middle } **Every language**

    ---

    A Rust core with Python, Java, C/Go and WebAssembly bindings, a pure TypeScript
    port that reproduces its results, a CLI and an HTTP server — all on one versioned
    JSON format. [Getting started](getting-started/index.md)

</div>

Hundreds of labels take milliseconds, thousands a few hundred milliseconds. When things
move — a dragged node, a panned map — each solve starts from the previous result, so
labels stay put ([interactive maps](tutorials/interactive-maps.md)).

## Gallery

Open data drawn as a host would draw it, labeled by the engine. Click a picture to see it
in full; the scripts are in [`examples/showcase/`](gh:examples/showcase/make_showcase.py).

<figure markdown>
[![The countries and capitals of Europe, labeled](assets/figures/europe.svg)](assets/figures/europe.svg)
<figcaption markdown>**A map.** Europe's countries and capitals (Natural Earth). Country
names sit inside the country, abbreviated where it is narrow (U.K., AUST.) and on a leader
where it is too small (Luxembourg, Malta); no label covers a sea's name. All 91 labels
placed.</figcaption>
</figure>

<figure markdown>
[![A fundus photograph with its parts labeled in the margins](assets/figures/retina.svg)](assets/figures/retina.svg)
<figcaption markdown>**A photograph.** The back of an eye (fundus photograph by
M. Häggström, CC0), labeled like an anatomy atlas: names in the margins, each with a leader
to its part.</figcaption>
</figure>

<figure markdown>
[![The module graph of the library's TypeScript packages, labeled](assets/figures/modules.svg)](assets/figures/modules.svg)
<figcaption markdown>**A diagram.** This library's own TypeScript modules: 112 nodes, 412
imports. The most imported are labeled first, in bold; labels may cross edges at a cost,
never nodes. 111 of 112 placed.</figcaption>
</figure>

## Five lines

The outliers of a scatter plot, labeled from every language. The chart is an image
(`scatter.png`); `outliers.csv` lists the points to label. Labels avoid each other, the
drawn dots, the axes and the trend line ([the tutorial](tutorials/outliers.md)).

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

The [real-world benchmark](project/benchmark.md) compares Label Anything with nine other
labelers, among them adjustText, ggrepel, vega-label and textalloc, on twelve scenarios
from open data. [The results](project/benchmark.md#what-the-results-show): no overlaps and
no crossing leaders anywhere, and the most usable labels on every problem of the quick suite
and on 60 of the 62 of the full suite, often by only a few percent. Label Anything falls
short on dense data, moving labels and the speed of the largest problems.

## Good to know

!!! warning "Experimental, developed by AI"

    Label Anything is still experimental and under active development, not
    production-ready software. It is written mostly by an AI coding assistant (Claude Code)
    with limited human oversight, code and documentation alike: expect mistakes, and check
    the results that matter to you. The problem format, the APIs of the language bindings
    and the placements themselves can change without deprecation. Try it and report what
    you find.

* **Not on the registries yet.** Build the packages from this repository for now
  ([getting started](getting-started/index.md)).
* **Labels for points and areas.** Labels go to points and areas of any shape; lines such
  as roads or rivers are obstacles, not labeled features.
* **Labels in graphics, not labeled data.** Label Anything places labels in pictures. It
  is not a data-labeling tool, and it is unrelated to the few-shot segmentation model of
  the same name (ECAI 2025).

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
