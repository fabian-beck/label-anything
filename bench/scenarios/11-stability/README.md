# 11 — Interactive stability (pan/zoom sequence)

**What.** A 30-frame camera path over scenario 05's airports: frames 0–19 zoom
geometrically from the world view (zoom 1 = 3.33 px/degree) to zoom 8 while the center
moves from (0° E, 20° N) to (10° E, 50° N); frames 20–29 pan east at zoom 8 to
(28° E, 48° N). Each frame is an independent problem (1200 × 600 px, equirectangular,
preset `map`, IATA labels 10 px) with the airports of the set visible in the frame; item
ids are stable across frames.

**Why.** Interactive maps relabel on every frame; labels should not jump (displacement,
side flips) and zooming in should only add labels (nesting).

**Files.** `<sequence>/f000.json … f029.json` and `<sequence>/sequence.json` (frame order,
step kind `start` / `zoom_in` / `pan`, view center and zoom). Sequences:
`zoom-pan-1000` (quick; top 1000 airports by traffic) and `zoom-pan-3000`.

**Warm start.** The runner solves frame t+1 with `warm_start` = the result of frame t in
which every box is shifted by its anchor's movement between the frames (so the warm
start encodes "keep the label where it was relative to its anchor").

**Metrics.** `python -m bench.eval sequence <sequence.json> --results <dir>`: mean/median
displacement of the label relative to its anchor (px, em), flip rate, labels added and
removed among items visible in both frames, and nesting (fraction of zoom-in steps with
P_t ∩ V_{t+1} ⊆ P_{t+1}, plus the mean kept fraction).
