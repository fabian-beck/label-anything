# 0037 — Labels avoid contrast borders of raster backgrounds

* Status: accepted
* Date: 2026-10-18
* Area: Obstacles and backgrounds
* Affects: spec §2.3, §4.6, §8; `weights.contrast`, `canvas.background`

## Context
A label that lies partly on a light and partly on a dark backdrop is hard to read and looks
misplaced: its box and text run across the border. Nothing in the cost model saw this. The
raster modes turn pixels into obstacle coverage, and coverage measures *how much* a label
hides, not whether its backdrop changes under it. In the fundus photograph of scenario 08
(`retina-boundary`) the raster's black corners are its background colour (`ink` mode), and
the white canvas around the photo is no raster at all: both cost nothing, so four of the ten
labels sat across the edge between them, half on white, half on black. The rocket and the
astronaut had the same problem at the photo's edges (3 and 2 labels).

## Decision
* **Backdrop luma.** With at least one raster source, the engine records how light the
  backdrop behind the labels is: the Rec. 709 luma of the rasters, drawn in order over the
  canvas colour `canvas.background` (default white, the usual page), whatever the sources'
  modes. It is sampled at the centres of the obstacle grid's cells and averaged over 2 × 2
  of them: a backdrop grid of cells of `2c` (about half an em). Opaque pixels replace what
  lies below, transparent ones let it show through.
* **Contrast term.** `weights.contrast` (default 0.5) × 4 × the integral of
  `(Y − Ȳ)²` over the label box, per em² (`Y` the backdrop luma, `Ȳ` its mean under the
  box), from summed-area tables of the luma and its square: constant time per candidate,
  exact up to rounding on the backdrop grid. A label half on black and half on white costs
  the weight per em² of its box, about as much as hiding half of it under ink of weight 1;
  a label on any uniform backdrop, dark or light, costs nothing. With a share `p` of the
  box across a black–white border the integral is `A · p · (1 − p)` (`A` the box area): a
  thin sliver over the border costs about 4 × the weight per em² of the sliver, so labels
  move off a border entirely rather than nearly.
* **Exactness.** Sampling, compositing, averaging and quantization are integer or fixed
  binary64 arithmetic, identical in Rust and TypeScript (`conformance/raster` `backdrop`
  runs, the `contrast-*` place cases and their parity fixtures).

## Alternatives considered

* *Area averaging of every raster pixel* (like coverage): even with luma and a reference
  colour whose pixels add nothing, it added 11 ms to preparing the 2048² performance raster
  on the benchmark VM (+40 %, against +2 ms for the sampled backdrop), which its 25 ms
  target cannot afford. The term weighs contrast at the scale of a label; sampling every
  third of an em loses nothing there.
* *OKLab lightness* instead of luma: three cube roots per colour; luma is what the `cost`
  and `saliency` modes already use, and borders that matter are stark in either.
* *Differences between the halves of the box*: blind to a dark stripe in the middle of a
  label. *A 3 × 3 smoothing of a full-resolution grid*: as good, but more work than the
  coarser grid, which smooths in the same way.
* *Hard avoidance*: a raster can be all borders (photos); the term trades against leader
  length and position like any other cost.

Weights tried (scenario 08 and the raster problems of scenarios 01 and 06, Rust engine;
labels across a contrast border as the evaluator counts them, `visual.contrast.border`):

| `weights.contrast` | retina | rocket | astronaut | Monaco (3 configs): placed | raster scatter: placed |
|---|---|---|---|---|---|
| 0 (before) | 4 of 10 | 3 of 12 | 2 of 12 | 206, 207, 195 | 29 of 30 |
| 0.25 | 0 | 0 | 0 | 206, 207, 193 | 29 |
| **0.5** | 0 | 0 | 0 | 206, 207, 193 | 29 |
| 1 | 0 | 0 | 0 | 206, 208, 192 | 29 |

All placed labels of the illustrations stay placed, and no Monaco or scatter label lies
across a contrast border at any weight.

From 0.25 to 1 the illustrations look the same: the labels that crossed the edge of the
photo move into the white margin (to the boundary columns, or as distant labels there).
0.5 leaves room for borders that are less stark than black against white.

## Consequences
* Illustrations: no label straddles the photo's edge any more; their total cost rises by
  3–9 % (longer leaders). Maps on raster tiles (`06-city-pois`) and raster charts barely
  change: their backdrops have no stark borders (5–29 of 375 labels move a little, one
  config places 193 instead of 195 labels). The tutorials' raster problems place the same
  labels; five of the twenty labels of the `ink` example move slightly.
* Preparation of the 2048² performance raster: +7 % instructions, about +2 ms on the
  benchmark VM (27.8 → 29.9 ms); the backdrop is built only with rasters and a positive
  weight, and not at all when it is uniform. The WebAssembly module grows by 4 KB gzip
  (985,805 → 989,880 bytes, below the 1 MB budget).
* The evaluator counts labels across contrast borders independently of the engine's
  formula (`visual.contrast`: the 10th to 90th percentile of the backdrop luma under the
  box spread by ≥ 0.5), for every solver of the benchmark; the report shows it as
  *contrast border*.
* The release gate accepts what the labels give up for it (`bench/gates-allow.json`):
  longer leaders (p90 5.6 → 7.6 em) and a little more soft coverage in scenario 08, a
  later mean position rank (1.73 → 2.08) in the raster chart of scenario 01, where two
  labels move off the dark marks they half covered.
* SVG backgrounds and vector layers carry no colours in the engine, so they do not
  change the backdrop; a host that draws its canvas dark sets `canvas.background`.
