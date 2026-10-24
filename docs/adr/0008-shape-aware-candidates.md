# 0008 — Shape-aware candidates via support functions

* Status: accepted
* Date: 2026-10-16
* Area: Candidates, leaders and costs

## Context
§4.5 requires adjacent and slider candidates around the *true* shape (circle tangents,
no bbox-corner gaps), coinciding with classic bbox positions for rects, for rotated and
concave shapes too.

## Decision
* Adjacent positions use the **support function** of the inflated shape:
  `center = support_{S⊕o}(d) + (sign(dx)·hw, sign(dy)·hh)`. For a circle and the
  top-right direction this is the 45° tangent point; for an axis-aligned rect it is the
  classic corner position; for flat sides the support point closest to the reference
  point is used (centered labels). Inflation is exact for every shape because
  `support_{S⊕o}(d) = support_S(d) + o·d̂` — no polygon offsetting needed.
* Slider positions sample the boundary of the configuration obstacle `(S⊕o) ⊕ (−B)`
  (labels sliding while touching), built from the support function evaluated on a fine
  angular grid plus the event angles (axis directions and hull edge normals, each
  evaluated at ±ε to capture the straight slides), and sampled at equal arc length.
* Concave shapes (polygons, paths) use their convex hull for support; hull vertices are
  true boundary points, so labels touch the true shape (gap 0).

## Consequences
"Gap ≤ 0.5 px to the inflated true shape" holds by construction and is property-tested.
