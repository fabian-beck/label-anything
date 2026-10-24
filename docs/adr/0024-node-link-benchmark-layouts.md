# 0024 — Node-link benchmark layouts: ForceAtlas2 without node overlaps

* Status: accepted
* Date: 2026-10-17
* Area: Benchmark
* Affects: benchmark scenario 07; not an engine change

## Context
Scenario `07-node-link` drew its graphs with networkx `spring_layout`. Cora (2 485 papers)
came out as one dense disc with 1 874 overlapping node pairs, in which a label rarely
found room (74 of the 150 labels placed); Les Misérables stacked its hubs on top of each
other (the rounded rectangles of `lesmis-shapes` overlapped). The benchmark then measured
the drawing more than the labeling, and the gallery showed a hairball.

## Decision
Both graphs use networkx `forceatlas2_layout` with strong gravity (gravity 0.05, seed 7;
Les Mis: 600 iterations with node sizes for overlap prevention, Cora: 300 iterations),
rotated about the centroid so that the principal axis is horizontal, scaled into the
canvas, then freed of node overlaps: overlapping node boxes move apart along the axis of
the smaller overlap until 2 px separate them (Les Mis: the larger node of its two
configs).

## Alternatives considered

More spring iterations (Cora 90 of 150), plain ForceAtlas2 (103), LinLog ForceAtlas2 (136:
tight clusters, long edges across the canvas), ForceAtlas2 with node sizes for Cora (147,
but the layout is looser); Kamada–Kawai for Les Mis (all labels, but long edges to the
outer characters).

## Consequences
Placed (deterministic solves): `lesmis-circles` 73 → 77 of 77, `lesmis-shapes` 68 → 77 of 77,
`cora-circles` 74 → 148 of 150; no node overlaps remain. With twice the labels over a
drawing whose edges now cross the whole canvas, labels lie on more edge length (Cora
`label_lines_em` 318 → 1 575, `lesmis-shapes` 257 → 640; edges are soft `lines`) and the soft
coverage rises (Cora 0.095 → 0.167); the Cora ambiguity rate rises 0.014 → 0.020. Building
the scenario takes about 2 minutes (Cora's layout). The release-gate allow list names
this ADR for these metrics.
