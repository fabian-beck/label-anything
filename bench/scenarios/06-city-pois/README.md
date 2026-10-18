# 06 — City POIs on raster tiles

**What.** 375 named points of interest of Monaco (restaurants, shops, sights, museums,
hotels, services, parks, artworks) labeled with composite labels — a 9 px category icon
plus the name — over a raster street map.

**Why.** Map labeling over a busy raster background where nothing is known about the
geometry except pixels: raster obstacle modes `ink` and `saliency`, composite labels,
icon (pin) marks with a tip.

**Substitution.** Tile servers are not reachable, so the "tiles" are rendered here from
an OpenStreetMap extract reachable on raw GitHub (planetiler's test resources), with a
pure-Python PBF reader (`bench/common/osmpbf.py`). Web Mercator, zoom 16 (≈ 1.73 m/px at
43.7° N), viewport 1400 × 1000 px centered at (7.4225° E, 43.7365° N). The sea is
flood-filled from a seed point inside the coastline-bounded water area.

**POIs.** Named nodes and the centroids of named POI areas whose tags map to a category
(`osmmap.category`); priority = category importance (sights 5, culture 4, hotels and
leisure 3, food and services 2, shops and artworks 1), ties by name; font classes: the
top 5 % at 1.25 ×, the rest at 0.9 × (the icons keep their size).

**Configs** (preset `map`, font 10 px, composite label = icon 9 × 9 + gap 2 + name,
padding 1.5 px):

| config | marks | raster mode |
|---|---|---|
| `monaco-ink` (quick) | circle r 3 | `ink` (soft 0.5) |
| `monaco-saliency` | circle r 3 | `saliency` |
| `monaco-pins-ink` | `icon` 10 × 14 pin with silhouette, tip on the location | `ink` |

**Rendering recipe.** Land `#f2efe9`, land use per `LANDUSE`, water `#aad3df`,
buildings `#d9d0c9`, roads with casings (widths 2.5–7 px by class), footways salmon
1 px, railways grey; 2× supersampled, palette PNG.
