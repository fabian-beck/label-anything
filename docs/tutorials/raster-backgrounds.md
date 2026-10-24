# Raster backgrounds

When the background is an image — a chart exported as PNG, a map tile, a photo, a canvas —
Label Anything turns its pixels into obstacle coverage. A **mode** gives every pixel a
value between 0 and 1; the values are averaged into the coverage grid (cells of about a
quarter of the font size) of an obstacle class, which `avoid` then weighs like any other
class.

| Mode | A pixel counts by | Typical image |
|---|---|---|
| `ink` (default) | its colour distance from the background colour | charts, line art, maps on a plain background |
| `alpha` | its opacity | a transparent overlay layer |
| `cost` | its darkness (1 − luma), or brightness with `cost.invert` | density maps, heatmaps, hand-painted cost |
| `classmap` | its palette colour, one class per colour | flat-coloured maps: water, parks, roads |
| `saliency` | local detail (gradient magnitude and contrast) | photos, illustrations |

A raster source is `obstacles.raster` (one object or a list) with the image as `source` (a
file path, a `data:` URL or base64 PNG/JPEG/WebP) or as raw pixels (`rgba`, or passed by
the host: NumPy, `ImageData`, a `ByteBuffer`, a C pointer). `scale` is raster pixels per
canvas pixel (2 for a HiDPI screenshot of a 1× canvas), `offset` the canvas position of
the image's top-left corner, `class` the obstacle class (default `ink`). Without a
`canvas`, the canvas is the image size divided by `scale`.

Each section below shows the head of a problem of
[`examples/tutorials/problems`](gh:examples/tutorials/problems) and the labels as a host
would draw them.

## ink

The chart of the [outliers tutorial](outliers.md), with ink made **hard**: labels may not
touch a single drawn pixel. Where no free spot exists next to a point, the label moves
away with a leader (soft ink cost 0.5 for leaders).

```json
--8<-- "examples/tutorials/problems/raster-ink.json:1:10"
```

![ink mode: labels avoid every dot, line and axis](../assets/figures/raster-ink.svg)

* `ink.background`: the background colour, `"#rrggbb"`, or `"auto"` (default): the most
  frequent colour of the image's border.
* `ink.threshold`: how different from the background a pixel must be to count as ink. The
  default, 0.12, ignores the light grey grid lines and counts the grey dots.
* `ink.dilate`: grows the ink by a safety margin of grid cells (default 1).

## alpha

A transparent layer — here a route and a callout box, with nothing behind them. Pixels
whose opacity exceeds `alpha.threshold` (0.1) count, whatever their colour.

```json
--8<-- "examples/tutorials/problems/raster-alpha.json:1:5"
```

![alpha mode: labels next to the route, off the callout](../assets/figures/raster-alpha.svg)

The class is named `route` and costs 5: labels stay off the route and the callout box
unless nothing else is possible.

## cost

A grayscale cost map: dark is expensive. This one is the density of the 300 points of the
scatter plot, scaled to 480 × 320: labels drift towards the sparse areas.

```json
--8<-- "examples/tutorials/problems/raster-cost.json:1:7"
```

![cost mode: labels avoid the dense centre](../assets/figures/raster-cost.svg)

A pixel's value is 1 − luma (Rec. 709) of the pixel composited over white, or its luma
with `"cost": {"invert": true}`. Cost maps are soft by nature: give the class a weight,
not `"hard"` (any non-white pixel would block).

## classmap

A map in flat colours. Each palette colour becomes its own class — water, parks, roads —
with its own weights: labels never sit on water, rarely on roads, and do not mind parks.

```json
--8<-- "examples/tutorials/problems/raster-classmap.json:1:14"
```

![classmap mode: labels on land, off the roads where possible](../assets/figures/raster-classmap.svg)

A pixel goes to the nearest palette colour within `classmap_tolerance` (OKLab, 0.08).
Background pixels (as in `ink`) are skipped; other unmatched pixels go to `ink`, or
nowhere with `"unmatched": "ignore"`. A palette entry may map to `"ignore"`. Anti-aliased
edges blend two palette colours and may fall between them: render classmaps without
anti-aliasing, or raise the tolerance.

## saliency

For photos, where nothing is "background": saliency rates each pixel by its local detail,
edges and contrast. Smooth sky is cheap, windows and edges are expensive.

```json
--8<-- "examples/tutorials/problems/raster-saliency.json:1:6"
```

![saliency mode: labels in the sky rather than on the facades](../assets/figures/raster-saliency.svg)

## Contrast borders

Whatever the mode, labels also avoid lying across a border between a light and a dark
backdrop: partly on the white page and partly on a dark photo, or half on a black road
and half on a light field. Here the night sky is the raster's own background colour, so
`ink` sees only the stars and the moon, and the white page around the picture is no raster
at all: nothing else would stop the labels of Vega, Mizar and Deneb from straddling the
picture's edge.

```json
--8<-- "examples/tutorials/problems/raster-contrast.json:1:7"
```

![contrast borders: the labels at the picture's edge lie wholly on the night sky](../assets/figures/raster-contrast.svg)

With `"weights": {"contrast": 0}` they take the first free position instead, across the
edge:

![without the contrast term: three labels half on the page, half on the sky](../assets/figures/raster-contrast-off.svg)

The engine looks at the lightness of what lies behind each label — the raster sources
over `canvas.background` (white unless you set the colour the host draws on) — and
`weights.contrast` weighs how much it varies under the label. A label on any uniform
backdrop, dark or light, costs nothing. The backdrop is averaged over about half an em, so
thin lines and fine texture hardly count: they are what the modes above are for.

## In Python

A path with mode options, as in the JSON problems above:

```python
--8<-- "examples/tutorials/python/raster_backgrounds.py:file"
```

Pixels from memory — a NumPy `uint8` array (H × W × 4, × 3 or grey), a PIL image — go to
the engine without a detour through JSON:

```python
--8<-- "examples/tutorials/python/raster_backgrounds.py:numpy"
```

`la.capabilities()` tells which image formats this build decodes:

```python
--8<-- "examples/tutorials/python/raster_backgrounds.py:capabilities"
```

Other languages pass pixels the same way: `PlaceOptions.raster` in
[JavaScript](../getting-started/javascript.md#raster-pixels-and-files),
`backgroundPixels(...)` in [Java](../getting-started/java.md#raster-pixels-without-copies),
the `rgba` pointer of `la_place_json` in [C](../getting-started/c-go.md#c).

## Exactness

The same PNG or raw pixels give the same coverage in every implementation: decoding and
every mode are specified to the operation
([spec §4.6](../reference/spec.md#46-raster-backgrounds)). JPEG and WebP are decoded by
the platform and may differ by a few pixel values.
