# Areas

The label of an area goes where it has room inside the polygon, at places spread over the
part it fits in, and may be turned along the polygon's main axis where an upright label
has less room.

## Context
Area anchors got their candidates as points do. Inside the polygon, the eight grid
samples farthest from the boundary were kept: all next to the pole of inaccessibility,
overlapping each other, so that a mark or a label in the middle of an area blocked every
one of them. Around the pole's dot, the adjacent and slider positions of a point item were
added, which put a label that fits inside its area beside an invisible point in it. All
internal candidates cost the same, and the distance of the *center* from the boundary
ranked them, although a wide label has the most room where the area is wide, not where
its inscribed circle is. A slanted area narrower than its label got no internal label at
all, where a map would write the name along it.

## Decision
- **The measure is the label's room**: the distance between the label box and the
  boundary. A place lacks `max(0, 1 − room / em)`, plus its distance from the pole
  relative to the polygon's size. More than 1 em of room is worth nothing, so that in a
  large area the label sits in the middle. The lack is the label's `w_distance` cost
  term, where other labels have the gap to their mark.
- **Places all over the area**: the best sample of a grid, improved by a short pattern
  search (the grid alone is half a line off, which shows in a symmetric shape), and the
  best sample of each of the 3 × 3 cells of the region the label fits in. A label in the
  way of the best place leaves eight others, each the best of its part.
- **No point-like candidates** while the label fits inside: only a variant that fits
  nowhere falls back to the dot at the pole. Leaders still lead to the pole.
- **Turned labels**: one more direction, along the main axis (principal axis of the
  second moments of area, a closed formula in deterministic arithmetic), at most
  `placement.area_rotation` (45°) from the horizontal, not for axes within 10° of it (a
  slight tilt reads as a mistake) nor for compact polygons (principal moments within a
  factor of 2, where the axis is noise). Turning adds `|angle| / 180` to the shape
  penalty: 45° costs as much as one more line, 90° as much as an alternative text. An
  upright label with 1 em of room is therefore never turned, and one that just fits
  gives way to a turned one with room.
- **A turned label in the result** is `box` (the label before it is turned) and
  `rotation` about the box's center: a host draws it as any label and adds one
  transform. Hosts that ignore `rotation` set `area_rotation: 0`.
- **Tests**: a turned label is tested exactly against marks and labels. For distances and
  coverages its *cover* stands for it, the bounding boxes of the pieces it is cut into
  along its length: every test of an upright box (summed-area tables, margins, leaders)
  serves it unchanged, at most 1.41 times too wide. The bounding box of the whole label
  would take four times the area of a long label at 45° and block it by marks far from
  it.

## Consequences
Area labels dodge marks and labels inside their area instead of leaving it, and slanted
lakes, valleys and countries are named along their length. An area has up to 18 internal
candidates per variant instead of 8 internal and 40 around the dot; each fitting sample
costs one more pass over the polygon's edges for its room. On a map of 150 areas of 80
vertices with 300 points, 95 instead of 73 areas have their label inside (21 of them
turned), and a solve takes 28 ms instead of 25 (Rust) and 120 ms instead of 87
(TypeScript). Results of problems
with area anchors change. Soft costs of turned labels are approximate (the cover is wider
than the label; rings, contrast, the region terms and the label budget use the bounding
box), always on the safe side for hard rules. Turned labels are text in a rectangular box; icons, composite
labels and labels of other shapes stay upright.

## Alternatives
- **Several fixed angles** (0°, ±15°, ±30°, …): more candidates, and a label a few degrees
  off the area's direction looks wrong; the main axis is the one direction that follows
  the shape.
- **The minimum-area bounding rectangle** for the direction: it jumps between edges of the
  hull under small changes of the polygon; the moments change smoothly.
- **Letter-spaced or curved names along the skeleton**, as hand-drawn maps have: a
  different label model (per-glyph placement) that no host of the result format could
  draw.
- **Rotation as its own weight**: one more option for a preference the shape penalty
  already expresses.
- **Keeping the candidates around the dot** as a fallback while internal ones are
  blocked: such a label reads as the label of a point that is not there.
