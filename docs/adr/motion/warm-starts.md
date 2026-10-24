# Warm starts

Given the previous result as `warm_start`, labels keep their place while it is free,
follow their anchors, are nudged rather than moved, and prefer near places when they must
move.

## Context
Interactive hosts re-solve on every pan, zoom or layout tick and pass the previous result;
labels should not jump. The benchmark's stability sequences — pan and zoom over 1,000 and
3,000 airports, a running force layout and a dragged node — showed how labels jumped
anyway: an old box that was not among the new candidates could not be kept at any cost;
boxes were compared where they had been, not where their anchors had moved; labels the
ladder had shrunk ran it again and left; a tight fit broke at the next sub-pixel move; and
a label that had to move went anywhere, since moving 1 em cost as much as moving across
the picture.

## Decision
- **The old box is a candidate**: a level-0 candidate of its size, slider-kind when it
  touches the mark and distant otherwise. Within each band, items whose old box is still
  free keep it first.
- **Boxes follow anchors**: results report each label's `anchor`, and an entry with one is
  moved by its anchor's movement before use, so the previous result can be passed as it
  is.
- **Degraded labels keep their box**: a shrunk or wrapped label's old box becomes a
  candidate of the ladder variant of its size, tried before the ladder runs. Level 0 still
  comes first, so labels grow back when they fit.
- **Nudges**: an old box on the slider path that is no longer free is tried moved along
  the path by 0.05, 0.1, 0.2, 0.4 and 0.8 em in both directions, smallest step first.
- **Kept leaders**: with the `angles`, `elbow` and `orthogonal` styles, the old leader,
  moved like its box, keeps the box a distant candidate while it still starts at the mark
  and keeps to the style.
- **Staying needs half the margin**: warm-start candidates keep half of `defaults.margin`
  (ADR placement/margin), so a label leaves only when its neighbours come closer than half
  the margin, but takes a new place only with all of it.
- **Near moves**: the stability term `w · (min(1, d/em) + min(1, max(0, d/em − 1) / 4))`
  counts every em fully up to 1 em and a quarter per em up to 5 em, so a label that must
  move prefers a near place.

## Consequences
When boxes began to follow their anchors, warm starts cut the mean displacement on pan and
zoom over 1,000 airports from 9.1 px (cold) to 3.0 px and side flips from 32 % to 12 %;
the near-move term later removed about 40 % of the jumps late in a running force layout.
Stability costs quality: labels keep places a fresh solve would improve, 3–7 % higher
summed cost, so a host should solve once more with a lower `weights.stability` when the
motion stops. Without `warm_start` nothing changes.

## Alternatives
- **A higher `weights.stability`** (2 or 4): fewer jumps, but every small move costs more,
  and labels that once needed a leader keep it.
- **Keeping a degraded box before trying the full size elsewhere**: labels shrunk while
  the layout moved stay shrunk.
- **Penalizing a candidate that takes another label's old box**, to damp cascades: better
  on two sequences, worse on two others.
- **Holding labels in the engine until their spot is needed**: breaks strict priority or
  overlaps labels; the display smooths instead (ADR motion/label-motion).
