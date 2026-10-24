# Positions

Labels sit against the true outline of their mark, at a circle's tangent or a rectangle's
corner, computed with support functions rather than bounding boxes.

## Context
Adjacent and slider positions (spec §6.1–6.2) must hug the true shape: top right of a
circle means its 45° tangent, not the corner of its bounding box, which leaves a visible
gap. The same rule must give the classic corner positions for rectangles and work for
rotated and concave shapes.

## Decision
- An adjacent position puts the label's corner or side midpoint on the support point of
  the mark inflated by the offset:
  `center = support_{S⊕o}(d) + (sign(dx)·hw, sign(dy)·hh)`. Inflation is exact for every
  shape, because `support_{S⊕o}(d) = support_S(d) + o·d̂`; no polygon offsetting is
  needed.
- Slider positions are sampled at equal arc length along the curve a label traces while
  sliding around the mark, built from the support function on a fine angular grid plus the
  directions where it slides straight along a side.
- Concave shapes use their convex hull for support; its vertices are true boundary points,
  so labels still touch the true shape.

## Consequences
"Gap ≤ 0.5 px to the inflated true shape" holds by construction and is property-tested,
for every mark kind in both implementations.
