# 0031 — Gallery: vector images, data colors, one weight, hubs first

* Status: accepted (benchmark scenarios, renderer and gallery; not an engine change)
* Date: 2026-10-18

## Context
The gallery (`bench/gallery.py`) is where most people see what the engine does, and a
review of it found problems that had little to do with label placement:

* **Pixels.** Its images were WebP renderings at twice the page's resolution; zooming in,
  which is what one does to read a dense map, showed blurred text.
* **Two weights.** Font classes set the most important labels bold *and* larger, and map
  titles and the bubble chart's year were bold; mixed weights read as two sets of labels.
* **Data without its colors.** The renderer drew every item mark blue. The labeled
  bubbles of the Gapminder chart lost their region colors (and looked like a seventh
  region), the labeled genes of the volcano plot their significance colors, the line ends
  their series colors. The life-expectancy lines cycled through 14 colors in alphabetical
  order, and its year ticks, every two years, overlapped.
* **Airports without priorities.** The world map had all 1,000 busiest airports as items.
  An item's mark is a hard obstacle for every label, whatever the item's priority, so in
  Europe, the eastern US and China the dots of small airports left the hubs no position:
  ATL, ORD, LHR, CDG and FRA — five of the ten busiest — had no label while small airports
  elsewhere had one. The priority section showed 3,221 airports scored by isolation, with
  no basemap, as a field of red crosses.
* **Networks.** Les Misérables was shown with UML/ER node shapes, which are not how
  anyone draws that graph; Cora's labels were paper ids, which mean nothing to a reader.

## Decision
1. **Vector images.** `render.standalone_svg` draws a result as one self-contained SVG: the
   problem's SVG background (or the scene's `<config>.bg.svg`) inlined, raster backgrounds
   embedded, the label text set in a subset of the bundled Noto Sans embedded as WOFF, every
   glyph at the pen position of the measurement (`x` per character), so text matches the
   reported boxes. The gallery uses it for its figures, comparisons and frames. The viewer
   scales with a transform while a zoom runs and then makes the scale the image's layout
   size, so the browser draws the SVG again at that size (up to 40 million pixels).
2. **Data colors.** An item whose `attrs.color` is `#rrggbb` is drawn in that color by every
   renderer (PNG, SVG, standalone SVG). The scenarios set it where the chart colors its data:
   Gapminder regions, volcano significance, line-end series, Les Misérables communities,
   Flare packages. The engine ignores the attribute.
3. **One weight.** `FONT_CLASSES_SPARSE` and `FONT_CLASSES_DENSE` set sizes only; scene text
   is regular; the gallery page uses one weight, hierarchy by size and color.
4. **Hubs first.** New configs `05-airports/europe-hubs-svg` and `world-hubs-100-svg`: the
   busiest airports are a tier of their own (`priority.tiers` on `attrs.hub`) set 1.2 ×, the
   next ones are items labeled where they leave room (0.9 ×), and every other airport is a
   `points` dot without a label that a label may cover at 0.3 per em². The 1,000-airport map
   stays in the benchmark and is shown as a limitation. `12-priority/europe-attr-strict` and
   `europe-attr-prefix` show the omission modes on the 250 busiest airports of the Europe view.
   City names are corrected where OpenFlights has an airport's or another language's name
   (`airports.CITY_NAMES`).
5. **Networks.** `07-node-link/lesmis-force`: the d3-force layout of scenario 11 at rest,
   circles by degree, colors by community, edge widths by co-occurrence, names written out.
   `flare-imports`: Flare's 220 classes and their imports in the same simulation, the 100
   most connected labeled with class names. Cora stays in the benchmark, not in the gallery.
6. **Charts and topics.** The life-expectancy lines take the six region colors (with a legend)
   and ticks every ten years; the 100-outlier and raster software charts label classes without
   the prefix all of them share (`uimanager.UIViewOperationQueue`); the WordNet topic names
   leave out stop words and gloss phrasing ("Foods and drinks: fruit, meat, cream" rather than
   "…: another, has"). The topics stay approximate: the clusters of the embedding mix glosses.
7. **Limits with figures.** The gallery's last section shows the 1,000-airport map and notes
   on crowds, crowded line ends, shrunk labels and words broken by wrapping, each with the
   figures of the build; every figure lists its omitted labels by reason and the settings of
   its problem.

Considered for the airports: soft `items` with the hub marks as a hard class (hubs then
covered other labeled airports' dots, FRA over GVA); more distant candidates, longer
leaders, fans, `required` hubs (no change: LGW's dot lies half under Heathrow's at 6 px per
degree); hub-only world maps (BRU and DUS still lost). The general fix — a label may cover
the marks of less important items, which then lose their own label — is an engine change
for a later decision.

## Consequences
Europe's 30 busiest airports and the next 70 are all labeled, the five London airports next
to their dots; on the world map 98 of the 100 busiest airports are (LGW and DUS are not).
Les Misérables keeps all 77 names; Flare labels 91 of its 100 classes. The 100-outlier chart
places 74 labels instead of 59. A gallery without a run is about 7 MB (WebP: 8 MB); every image
stays sharp at any zoom.

On the quick suite with the same engine, placements are unchanged except Monaco (206 → 207);
the force and drag sequences move their labels 4.7 % and 3.0 % more (2.57 → 2.69 px and
2.33 → 2.40 px per frame: written-out names are longer), within the allow-list entries of
ADR 0022. Problems with font classes, the life-expectancy chart (ticks, legend), the city
names of the Europe and priority maps and the two software charts change in the full suite.
