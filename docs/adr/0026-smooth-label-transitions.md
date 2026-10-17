# 0026 — Smooth label transitions in the JavaScript helpers

* Status: accepted (`@label-anything/extras`; no change to the engine)
* Date: 2026-10-17

## Context
Warm starts keep most labels in place between solves (ADR 0016, ADR 0025), but every
solve still changes some: on the force layout of scenario 11, warm-started, 4.5 labels
per solve jump by more than 1 em and 2 appear or disappear. Half of the appearances and
disappearances last one or two solves (56 of 121 on the running layout, 37 of 73 while a
node is dragged): a label loses its place to a node or a higher-priority label and gets
it back shortly after. The engine cannot avoid these without breaking the priority
guarantees (`strict` omission). Drawn solve by solve, they show as jumps and blinking,
and the helpers drew every result as it came.

## Decision
* **`LabelMotion`** (`@label-anything/extras`) turns a sequence of results into
  continuous motion. Each label's box origin relative to its anchor and its size follow a
  critically damped spring towards the latest result (ω = 6 / T: within 2 % after the
  transition time T, no overshoot; a move retargeted mid-way bends into the new one, so
  solves may come faster than T). Labels fade in and out linearly over T; a label that
  is gone for one solve only dims; fading labels are drawn below the others. Leaders stay
  attached to the gliding box (the start of a straight leader turns with its port, exact
  again on arrival); a leader that is no longer needed fades out. Labels follow their
  anchors throughout (`frame(anchors)`), and the first result appears at once.
* **`renderLabels`** takes per-label `opacity` and `leaderOpacity`.
* **The interactive helpers use it by default**: the overlay of the Leaflet and MapLibre
  layers and the sigma.js labels redraw on animation frames for T after a solve (option
  `transition`, default 300 ms; 0 draws each solve as it is; without
  `requestAnimationFrame`, at once). The static helpers (d3, Plot, Vega, Cytoscape) are
  unchanged.

Considered and rejected:
* *Eased tweens restarted at each solve*: the velocity drops to zero at every retarget,
  which stutters when solves come faster than the transition (every 130 ms on the force
  layout).
* *Keeping a shown label in place until its spot is needed* (engine-side hysteresis):
  either breaks strict priority or overlaps labels; a fade is the established practice of
  map renderers, which fade labels in and out in about 300 ms.

## Consequences
On the Les Misérables sequences played at 60 frames per second (headless Chromium,
warm-started labels): with transitions, the largest change of a visible label's offset
from its node between two frames is 7.5 px at the 99th percentile (33 px at most: long
glides at full speed) and opacity changes by at most 0.17 per frame; drawn as they come,
the 99.9th percentile is 80 px (186 px at most) and 121 labels blink on or off in 6 s of
the running layout. A label fading out may overlap the label that took its place for up
to T.
