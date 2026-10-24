# 0038 — Calm label transitions: labels hold, wait and make way

* Status: accepted
* Date: 2026-10-18
* Area: Warm starts and transitions
* Affects: `@label-anything/extras`, the playground; no change to the engine
* Amends: [ADR 0026](0026-smooth-label-transitions.md), [ADR 0032](0032-playground.md)
  (the playground's motion and scenes)

## Context
With the transitions of ADR 0026, labels glide and fade between solves. In the playground
(ADR 0032), while things move, they still looked nervous and flickered. Measured there
(headless Chromium, 8 s of each scene in motion, WebAssembly engine, 10–20 solves per
second; a label counts as changing in a frame when it moves relative to its point or
fades):

| scene | changing labels | label motion | labels overlapping |
|---|---|---|---|
| swarm (moving points) | 33 % | 38 px/s | 6.6 pairs per frame |
| network, a node dragged | 26 % | 37 px/s | 3.6 |
| world map, pan and zoom | 26 % | 28 px/s | 3.5 |
| scatterplot, data transition | 47 % | 85 px/s | 29.7 |
| line chart, racing ends | 64 % | 50 px/s | 2.8 |

The engine moves labels because the points move. Of the jumps (moves of more than 1 em)
in 100 recorded solves of the swarm, 41 % were forced by a more important label or a
point that moved into the label's box, 27 % were cascades (a label that had to move took
another's place) and 30 % happened while the old box was still free of labels and points
(leaders that no longer fit, labels growing back to full size, the overlays, the search).
A label that jumped usually jumped again soon: the median gap was 350 ms, a quarter of
the gaps were at most 150 ms. Other engine settings changed little: re-solving the
recorded problems without local search made 14 % fewer jumps; a stability weight of 4 or
fewer solves per second (4 instead of 20) changed the share of changing labels by at
most 5 points, and soft mark avoidance did not reduce the jumps (ADR 0025 and ADR 0027
had found cascade damping in the engine neutral). The display, which sees every solve,
can wait for a change to hold.

## Decision
`LabelMotion` filters the results in time; the engine's results stay as they are:

* **Moves wait** (`moveDelay`, 500 ms). A shown label that the solver moved stays where it
  is, following its point, until the new place has held for the delay; it then moves once,
  to the latest place. When the solver puts it back first, it does not move at all. It
  moves at once when a label shown at the new place of the latest result needs the room,
  or when it covers the anchor of another item (a node being dragged).
* **Labels that leave stay a moment** (`holdTime`, 500 ms), unless a label of the latest
  result needs the place or they cover another item's anchor: a label that is back within
  the time never blinks. (ADR 0026 let a label gone for one solve dim.)
* **New labels wait** (`appearDelay`, 250 ms) and show only if they are still placed;
  they fade in once the labels that make way for them have faded out.
* **Labels make way.** Between solves labels follow their points and linger, so two of
  them can meet. Shown labels claim their boxes in order — labels at the place of the
  latest result, then labels at an older place, then lingering and jumping ones; within
  each, the higher priority, then the one shown longer — and a label whose box overlaps a
  claimed one makes way: one at an older place moves on, a lingering one fades, one of the
  latest result fades after 150 ms (a new solve usually separates the two before) and
  stays hidden until it has been clear for the appear delay.
* **Long moves fade** (`jump`, 2 label heights): a move further than that, to the other
  side of a point or onto a leader, fades out (twice as fast) and in at the new place
  instead of sweeping across the drawing. A move back cancels it.
* **Columns stay.** Fan and boundary labels stay where their column is between solves;
  their leaders follow the points. Following their own points, the labels of a column
  came apart and collided (0.47 blinks per label and second in the line chart).
* `duration: 0` still draws every result as it is. The Leaflet, MapLibre and sigma.js
  helpers use the defaults; the map overlay keeps drawing while labels fade during a pan.

The playground exposes the options in its Motion section and, in the same change, stops
re-solving from scratch when its title fades, keeps the rectangles of its overlays (the
statistics, the buttons, which it now actually avoids) unless they grow, simplifies a
country outline once per zoom band instead of after every pan, runs the swarm at 0.6 of
real time, slows the scatterplot's transitions (2.4 s) and reheats the graph less while a
node is dragged.

## Alternatives considered

* *Gliding every move* (`jump: Infinity`, as in ADR 0026): fewer discrete changes (0.78
  against 0.95 per label and second in the swarm) but two to three times the label motion
  and 1.7 to 3.2 times the overlapping labels: long glides sweep across other labels.
* *Hiding a label as soon as it overlaps a more important one*: 0.08 blinks per label and
  second in the line chart instead of 0.01; two line ends that meet between solves are
  usually separated by the next solve.
* *Waiting longer* (moves 800 ms): 1–3 points fewer changing labels than with 500 ms, but
  labels lag further behind the points.
* *Engine-side hysteresis*: see ADR 0026; the settings measured above show the engine
  has little to give.

## Consequences
The same scenes, the same motion, before → after (the library change alone):

| scene | changing labels | label motion | labels overlapping |
|---|---|---|---|
| swarm | 33 % → 28 % | 38 → 14 px/s | 6.6 → 4.0 |
| network, a node dragged | 26 % → 20 % | 37 → 9 px/s | 3.6 → 1.4 |
| world map, pan and zoom | 26 % → 19 % | 28 → 7 px/s | 3.5 → 1.0 |
| scatterplot, data transition | 47 % → 32 % | 85 → 15 px/s | 29.7 → 5.6 |
| line chart | 64 % → 51 % | 50 → 37 px/s | 2.8 → 0.9 |

Labels no longer rest on top of each other (overlaps of more than 2 px between still,
opaque labels: 0.01–0.08 pairs per frame, 0.5 in the scatterplot's transition, whose
points cross faster than solves come; the other overlaps are labels gliding or fading).
With the playground's scene changes, 19 % of the swarm's labels and 17 % of the
network's change at any moment. A long move is now two fades instead of a glide, so a
label changes about as often as before (0.98 against 0.76 changes per second in the
swarm), but at most about once per 500 ms. The drawing lags the solver by up to the
delays: a label may sit on an unlabeled point or a line for up to 500 ms after the solver
moved it away. Hosts that redraw only while `motion.moving` draw a little longer after
each solve (while moves wait).
