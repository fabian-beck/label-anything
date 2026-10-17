# 11 — Interactive stability (pan/zoom, force layout)

**What.** Frame sequences in which the points move between frames; every frame is an
independent problem and item ids are stable across frames.

* **Pan and zoom** over scenario 05's airports: frames 0–19 zoom geometrically from the
  world view (zoom 1 = 3.33 px/degree) to zoom 8 while the center moves from (0° E, 20° N)
  to (10° E, 50° N); frames 20–29 pan east at zoom 8 to (28° E, 48° N). 1200 × 600 px,
  equirectangular, preset `map`, IATA labels 10 px, the airports of the set visible in
  the frame.
* **Force layout** of scenario 07's Les Misérables graph (77 nodes, 254 edges) under a
  d3-force-style simulation (`bench/common/forcesim.py`: link, many-body and centering
  forces, phyllotaxis start, deterministic): 1000 × 760 px, preset `graph`, names 10 px,
  marks r = 3 + 1.5·sqrt(degree), priority = degree, edges as soft `lines`.

**Why.** Interactive maps relabel on every frame, graph layouts move their nodes while
they run or while the user drags one; labels should not jump (displacement, side flips),
and zooming in should only add labels (nesting).

**Files.** `<sequence>/f000.json …` and `<sequence>/sequence.json` (frame order, step kind
`start` / `zoom_in` / `pan` / `tick` / `drag`, view or tick). Sequences:

| sequence | frames | what |
|---|---|---|
| `zoom-pan-1000` (quick) | 30 | top 1000 airports by traffic |
| `zoom-pan-3000` | 30 | top 3000 airports |
| `force-lesmis` (quick) | 61 | the simulation from its start: every 4th of the first 240 ticks |
| `drag-lesmis` (quick) | 41 | the settled layout (300 ticks) reheated to alpha 0.3 while Valjean is dragged 240 px along a half circle, every tick |

**Warm start.** The runner solves frame t+1 with `warm_start` = the result of frame t in
which every box is shifted by its anchor's movement between the frames (so the warm
start encodes "keep the label where it was relative to its anchor"; Label Anything does
the same with the previous result as it is, whose placements carry their `anchor`).

**Metrics.** `python -m bench.eval sequence <sequence.json> --results <dir>`: mean/median
displacement of the label relative to its anchor (px, em), flip rate, labels added and
removed among items visible in both frames, and nesting (fraction of zoom-in steps with
P_t ∩ V_{t+1} ⊆ P_{t+1}, plus the mean kept fraction).

**Results** (Rust core, deterministic runs, ADR 0025): mean displacement / flip rate, from
scratch → warm-started: `force-lesmis` 4.89 px / 12.2 % → 2.91 px / 7.8 %, `drag-lesmis`
7.55 px / 17.8 % → 2.99 px / 8.5 %, `zoom-pan-1000` 9.10 px / 32.0 % → 3.01 px / 11.6 %,
`zoom-pan-3000` 9.77 px / 36.7 % → 3.81 px / 15.5 %.
