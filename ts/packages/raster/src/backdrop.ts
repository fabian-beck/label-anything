// Backdrop luma (spec §4.6): the lightness of what lies behind labels, per grid cell, for
// the `contrast` cost term of the core (spec §8) — the same arithmetic, in the same order,
// as the Rust crate (backdrop.rs).

import type { GridSpec, RasterPlacement } from "./grid.js";
import { isValidRgba, type Rgba } from "./rgba.js";

/** `2126·R + 7152·G + 722·B` of a colour (no compositing): the Rec. 709 luma × 2 550 000. */
function luma(d: Uint8Array | Uint8ClampedArray | readonly number[], o: number): number {
  return 2126 * d[o]! + 7152 * d[o + 1]! + 722 * d[o + 2]!;
}

/** `floor(n / 10 000 + 1/2)` of a luma numerator, clamped to `0..=255`. */
function quantizeLuma(n: number): number {
  const t = n / 10000 + 0.5;
  return t >= 255 ? 255 : t >= 1 ? Math.floor(t) : 0;
}

/**
 * The raster pixel index `floor((origin + (k + 1/2)·step − offset) · scale)` of every
 * sample position `k < n`, or −1 outside the `size` pixels.
 */
function pixelIndices(
  n: number,
  origin: number,
  step: number,
  offset: number,
  scale: number,
  size: number,
): Int32Array {
  const out = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const t = Math.floor((origin + (k + 0.5) * step - offset) * scale);
    out[k] = t >= 0 && t < size ? t : -1;
  }
  return out;
}

const MAX_U32 = 0xffffffff;

/**
 * The backdrop luma grid (spec §4.6), bit-identical to the Rust `backdrop_luma`: rasters
 * drawn in order over a canvas filled with `background`, and per grid cell the Rec. 709
 * luma of the result, quantized to `0..=255` (row-major, `rows × cols`).
 *
 * Every cell is sampled at the 2 × 2 points `(x0 + (2·col + i + 1/2)·c/2,
 * y0 + (2·row + j + 1/2)·c/2)`. A sample starts with the luma numerator `n` of
 * `background`; each raster, in order, whose pixel `(floor((x − ox)·s), floor((y − oy)·s))`
 * exists replaces it by `(a·n_px + (255 − a)·n) / 255`. A cell's value is
 * `((n₀₀ + n₁₀) + (n₀₁ + n₁₁)) / 4`, quantized as `floor(n / 10 000 + 1/2)` clamped to 255.
 * Rasters that cannot be placed are skipped; an invalid grid yields an empty array.
 */
export function backdropLuma(
  layers: readonly (readonly [Rgba, RasterPlacement])[],
  background: readonly [number, number, number],
  grid: GridSpec,
): Uint8Array {
  const { cols, rows } = grid;
  const count = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_U32;
  if (!count(cols) || !count(rows) || !Number.isSafeInteger(cols * rows)) return new Uint8Array(0);
  const base = luma(background, 0);
  const out = new Uint8Array(cols * rows).fill(quantizeLuma(base));
  const geometryOk =
    Number.isFinite(grid.cell) && grid.cell > 0 && Number.isFinite(grid.originX) && Number.isFinite(grid.originY);
  const sc = 2 * cols;
  const sr = 2 * rows;
  const step = grid.cell / 2;
  const placed: [Rgba, Int32Array, Int32Array][] = [];
  for (const [img, place] of layers) {
    if (
      geometryOk &&
      isValidRgba(img) &&
      Number.isFinite(place.scale) &&
      place.scale > 0 &&
      Number.isFinite(place.offset[0]) &&
      Number.isFinite(place.offset[1])
    ) {
      placed.push([
        img,
        pixelIndices(sc, grid.originX, step, place.offset[0], place.scale, img.width),
        pixelIndices(sr, grid.originY, step, place.offset[1], place.scale, img.height),
      ]);
    }
  }
  if (placed.length === 0) return out;
  // two rows of samples at a time
  const row = new Float64Array(2 * sc);
  for (let gy = 0; gy < rows; gy++) {
    row.fill(base);
    for (const [img, xs, ys] of placed) {
      const d = img.data;
      const w4 = img.width * 4;
      for (let j = 0; j < 2; j++) {
        const py = ys[2 * gy + j]!;
        if (py === -1) continue;
        const line = py * w4;
        const s0 = j * sc;
        for (let k = 0; k < sc; k++) {
          const px = xs[k]!;
          if (px === -1) continue;
          const o = line + px * 4;
          const a = d[o + 3]!;
          if (a === 255) row[s0 + k] = luma(d, o);
          else if (a !== 0) row[s0 + k] = (a * luma(d, o) + (255 - a) * row[s0 + k]!) / 255;
        }
      }
    }
    const o = gy * cols;
    for (let gx = 0; gx < cols; gx++) {
      const v = (row[2 * gx]! + row[2 * gx + 1]! + (row[sc + 2 * gx]! + row[sc + 2 * gx + 1]!)) / 4;
      out[o + gx] = quantizeLuma(v);
    }
  }
  return out;
}
