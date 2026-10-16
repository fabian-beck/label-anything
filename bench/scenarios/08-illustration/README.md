# 08 — Technical and anatomical illustrations

**What.** Callout labeling of photographs: a NASA astronaut portrait (suit parts, mission
patch, Space Shuttle model), a fundus photograph of the retina (optic disc, macula,
fovea, vessel arcades, …) and a Falcon 9 launch pad (stages, fairing, lightning towers,
floodlights).

**Why.** Labeled features are regions (`area` anchors, one with a hole), the background is
a photograph where every pixel is "ink", and the classic layout is labels in the left and
right margins with elbow leaders (`boundary` model, preset `illustration`).

**Polygons.** `polygons.json` (CC0, committed) holds hand-made polygons in the original
image pixel coordinates (drawn on coordinate grids; circles/ellipses as 16–48-gons,
vessels as bands around hand-picked center lines). `build.py` maps them to canvas px:
canvas = offset + image px / scale.

**Configs** (preset `illustration`; raster mode `ink`, which the preset makes costly (2.0)):

| config | image placement | parts | models / leaders |
|---|---|---|---|
| `astronaut-boundary` (quick) | 512 px at (244, 44) on 1000 × 600 | 12 (neck ring with a hole) | boundary (left, right; stack) + distant; `elbow` leaders, port `side-center`, angles 45/135/225/315 |
| `retina-boundary` | 1411 px image at scale 2 (705.5 px) at (237, 20) on 1180 × 746 | 10 | same |
| `rocket-distant` | 640 × 427 at (180, 66) on 1000 × 560 | 12 (repeated texts "Lightning mast", "Floodlight") | distant only; `straight` leaders |

Font 12 px. The renderer background `<config>.bg.png` shows the photo on the canvas.
