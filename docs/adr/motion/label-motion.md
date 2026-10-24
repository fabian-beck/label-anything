# Label motion

The JavaScript helpers animate between solves: labels glide and fade, wait until a change
holds, and make way where they meet, while the engine's results stay as they are.

## Context
Warm starts keep most labels in place, yet every solve still moves or drops a few, and
half of those come back within one or two solves: a label loses its place to a moving node
or a more important label and gets it back. The engine cannot avoid this without breaking
strict priority. Drawn solve by solve, it shows as jumps and blinking; even with glides
and fades, 26–64 % of the labels in the playground's moving scenes changed at any moment.

## Decision
`LabelMotion` (`@label-anything/extras`) filters the results in time:

- **Glide and fade**: a label's offset from its anchor and its size follow a critically
  damped spring, so a move retargeted mid-way bends smoothly; labels fade in and out over
  `duration` (300 ms), leaders stay attached, and labels follow their anchors between
  solves.
- **Moves wait** (`moveDelay`, 500 ms): a moved label stays until its new place has held,
  unless a label at the new place needs the room or it covers another item's point.
- **Leaving labels linger** (`holdTime`, 500 ms) and **new labels wait** (`appearDelay`,
  250 ms), so a label back within that time never blinks.
- **Make way**: of two labels that meet between solves, the less important one moves on,
  fades or waits.
- **Long moves fade** (`jump`, 2 label heights) instead of sweeping across the drawing;
  fan and boundary columns stay in place while their leaders follow.
- The Leaflet, MapLibre and sigma.js helpers use it by default; `duration: 0` draws every
  result as it comes.

## Consequences
In the playground's moving scenes, label motion fell by a quarter in a racing line chart
and by two thirds to four fifths elsewhere, overlapping labels by 40–80 %, and a label
changes at most about once per 500 ms. The drawing lags the solver by up to the delays: a
label may rest on a point for half a second after the solver moved it away.

## Alternatives
- **Tweens restarted at every solve**: the velocity drops to zero at each retarget, which
  stutters when solves come faster than the transition.
- **Gliding every move**: two to three times the motion and the overlaps, as long glides
  sweep across other labels.
- **Holding labels in the engine**: breaks strict priority or overlaps labels.
