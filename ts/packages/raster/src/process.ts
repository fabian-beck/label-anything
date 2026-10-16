// Pixel modes (spec §4.6): per-pixel values in [0, 1], area-averaged into coverage grids.
// Mirrors the Rust crate (process.rs) operation by operation.

import { composite, estimateBackground, oklabDistance, oklabInto, type Rgb } from "./color.js";
import { Axis, dilate, type GridSpec, type RasterPlacement, Resampler } from "./grid.js";
import { isValidRgba, type Rgba } from "./rgba.js";

/**
 * How raster pixels become obstacle coverage (spec §4.6). Pixels are first composited
 * over a backdrop (the background colour for `ink` and `classmap`, white for `cost` and
 * `saliency`), each channel rounded to 8 bits: `(c·a + bg·(255 − a) + 127) div 255`.
 */
export type Mode =
  | {
      /** 1 where the composited pixel differs from the background by more than `threshold` (OKLab). */
      readonly kind: "ink";
      /** Background colour; `null`/omitted estimates it ({@link estimateBackground}). */
      readonly background?: Rgb | null;
      /** Default 0.12. */
      readonly threshold: number;
      /** 3×3 maximum filter applied this many times to the quantized grid (default 1). */
      readonly dilate: number;
    }
  | {
      /** 1 where `alpha / 255 > threshold`. */
      readonly kind: "alpha";
      /** Default 0.1. */
      readonly threshold: number;
    }
  | {
      /** `1 − Y'` (or `Y'` with `invert`), `Y' = (2126·R + 7152·G + 722·B) / 2 550 000` over white. */
      readonly kind: "cost";
      readonly invert: boolean;
    }
  | {
      /** Pixels go to the class of the nearest palette colour (OKLab). */
      readonly kind: "classmap";
      /** `[colour, class]` in document order; class `"ignore"` drops matching pixels. */
      readonly palette: ReadonlyArray<readonly [Rgb, string]>;
      /** Max. OKLab distance of a match (default 0.08); ties go to the first entry. */
      readonly tolerance: number;
      /** Unmatched non-background pixels go to class `"ink"` (`true`) or nowhere. */
      readonly unmatchedInk: boolean;
      /** Background colour; `null`/omitted estimates it. */
      readonly background?: Rgb | null;
      /** Pixels within this OKLab distance of the background are skipped (default 0.12). */
      readonly inkThreshold: number;
    }
  | {
      /** Normalized Sobel gradient magnitude of the luma averaged with its local contrast. */
      readonly kind: "saliency";
    };

/** The coverage of one class: `rows × cols` cells, row-major, 0..255 (spec §4.1). */
export interface ClassCoverage {
  readonly class: string;
  readonly coverage: Uint8Array;
}

const IGNORE = "ignore";
const INK = "ink";
const NONE = -1;
const LUMA_DENOM = 2550000;

interface Setup {
  readonly w: number;
  readonly h: number;
  readonly cols: Axis;
  readonly rows: Axis;
  readonly gcols: number;
  readonly grows: number;
}

const MAX_U32 = 0xffffffff;

function makeSetup(img: Rgba, place: RasterPlacement, grid: GridSpec): Setup | null {
  const finite = [place.scale, place.offset[0], place.offset[1], grid.cell, grid.originX, grid.originY].every((v) =>
    Number.isFinite(v),
  );
  const count = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= MAX_U32;
  if (!isValidRgba(img) || !finite || !(place.scale > 0) || !(grid.cell > 0) || !count(grid.cols) || !count(grid.rows)) {
    return null;
  }
  return {
    w: img.width,
    h: img.height,
    cols: new Axis(img.width, place.offset[0], place.scale, grid.originX, grid.cell, grid.cols),
    rows: new Axis(img.height, place.offset[1], place.scale, grid.originY, grid.cell, grid.rows),
    gcols: grid.cols,
    grows: grid.rows,
  };
}

/**
 * A direct-mapped memo of per-colour results keyed by the packed RGBA value. A pure
 * cache: results are identical with or without it.
 */
class ColorMemo {
  static readonly BITS = 16;
  readonly keys = new Int32Array(1 << ColorMemo.BITS);
  /** `value + 1`; 0 = empty. */
  readonly vals = new Int32Array(1 << ColorMemo.BITS);

  static slot(key: number): number {
    return Math.imul(key, 0x9e3779b1) >>> (32 - ColorMemo.BITS);
  }
}

function lumaNumerator(d: Uint8Array | Uint8ClampedArray, o: number): number {
  const a = d[o + 3]!;
  if (a === 255) return 2126 * d[o]! + 7152 * d[o + 1]! + 722 * d[o + 2]!;
  return 2126 * composite(d[o]!, 255, a) + 7152 * composite(d[o + 1]!, 255, a) + 722 * composite(d[o + 2]!, 255, a);
}

function zeros(grid: GridSpec): Uint8Array {
  const n = grid.cols * grid.rows;
  return new Uint8Array(Number.isSafeInteger(n) && n >= 0 ? n : 0);
}

/**
 * Turns a raster into per-class coverage grids (spec §4.6), bit-identical to the Rust
 * `process`.
 *
 * - `ink`, `alpha`, `cost`, `saliency`: exactly one entry, for `className`.
 * - `classmap`: one entry per class with non-zero coverage somewhere, in palette order of
 *   first occurrence, then `"ink"` (unmatched pixels) if `unmatchedInk` and `"ink"` is not
 *   a palette class. `className` is not used.
 *
 * Invalid input (an {@link Rgba} whose data does not match its size, a non-finite or
 * non-positive `scale` or `cell`, non-finite offsets or origins, non-integer grid sizes)
 * produces all-zero coverage (no classmap entries); it never throws.
 */
export function process(
  img: Rgba,
  mode: Mode,
  className: string,
  place: RasterPlacement,
  grid: GridSpec,
): ClassCoverage[] {
  const setup = makeSetup(img, place, grid);
  if (setup === null) return mode.kind === "classmap" ? [] : [{ class: className, coverage: zeros(grid) }];
  switch (mode.kind) {
    case "ink": {
      const coverage = ink(setup, img, mode.background ?? estimateBackground(img), mode.threshold);
      dilate(coverage, setup.gcols, setup.grows, mode.dilate);
      return [{ class: className, coverage }];
    }
    case "alpha":
      return [{ class: className, coverage: alpha(setup, img, mode.threshold) }];
    case "cost":
      return [{ class: className, coverage: cost(setup, img, mode.invert) }];
    case "saliency":
      return [{ class: className, coverage: saliency(setup, img) }];
    case "classmap":
      return classmap(setup, img, mode, mode.background ?? estimateBackground(img));
  }
}

function ink(s: Setup, img: Rgba, bg: Rgb, threshold: number): Uint8Array {
  const bgLab = new Float64Array(3);
  oklabInto(bg[0], bg[1], bg[2], bgLab);
  const lab = new Float64Array(3);
  const memo = new ColorMemo();
  const { keys, vals } = memo;
  const res = new Resampler(s.cols, s.rows, s.gcols, s.grows, 1);
  const d = img.data;
  const stride = s.w * 4;
  const pxLo = s.cols.lo;
  const pxHi = s.cols.hi;
  let lastKey = 0.5; // never equals an int32 key
  let lastInk = false;
  for (let py = s.rows.lo; py < s.rows.hi; py++) {
    if (!res.beginRow(py)) continue;
    let o = py * stride + pxLo * 4;
    for (let px = pxLo; px < pxHi; px++, o += 4) {
      const key = d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24);
      if (key !== lastKey) {
        lastKey = key;
        const slot = ColorMemo.slot(key);
        if (vals[slot] !== 0 && keys[slot] === key) {
          lastInk = vals[slot] === 2;
        } else {
          const a = d[o + 3]!;
          if (a === 255) oklabInto(d[o]!, d[o + 1]!, d[o + 2]!, lab);
          else oklabInto(composite(d[o]!, bg[0], a), composite(d[o + 1]!, bg[1], a), composite(d[o + 2]!, bg[2], a), lab);
          lastInk = oklabDistance(lab, bgLab) > threshold;
          keys[slot] = key;
          vals[slot] = lastInk ? 2 : 1;
        }
      }
      if (lastInk) res.addOne(0, px);
    }
    res.endRow(py);
  }
  return res.finish()[0]!;
}

function alpha(s: Setup, img: Rgba, threshold: number): Uint8Array {
  const table = new Uint8Array(256);
  for (let a = 0; a < 256; a++) table[a] = a / 255 > threshold ? 1 : 0;
  const res = new Resampler(s.cols, s.rows, s.gcols, s.grows, 1);
  const d = img.data;
  for (let py = s.rows.lo; py < s.rows.hi; py++) {
    if (!res.beginRow(py)) continue;
    const row = py * s.w * 4;
    for (let px = s.cols.lo; px < s.cols.hi; px++) if (table[d[row + px * 4 + 3]!] === 1) res.addOne(0, px);
    res.endRow(py);
  }
  return res.finish()[0]!;
}

function cost(s: Setup, img: Rgba, invert: boolean): Uint8Array {
  const res = new Resampler(s.cols, s.rows, s.gcols, s.grows, 1);
  const d = img.data;
  for (let py = s.rows.lo; py < s.rows.hi; py++) {
    if (!res.beginRow(py)) continue;
    const row = py * s.w * 4;
    for (let px = s.cols.lo; px < s.cols.hi; px++) {
      const n = lumaNumerator(d, row + px * 4);
      const v = (invert ? n : LUMA_DENOM - n) / LUMA_DENOM;
      if (v !== 0) res.add(0, px, v);
    }
    res.endRow(py);
  }
  return res.finish()[0]!;
}

function classmap(
  s: Setup,
  img: Rgba,
  mode: Extract<Mode, { kind: "classmap" }>,
  bg: Rgb,
): ClassCoverage[] {
  const classes: string[] = [];
  const indexOf = (name: string): number => {
    const i = classes.indexOf(name);
    if (i >= 0) return i;
    classes.push(name);
    return classes.length - 1;
  };
  const entryClass = mode.palette.map(([, name]) => (name === IGNORE ? NONE : indexOf(name)));
  const unmatched = mode.unmatchedInk ? indexOf(INK) : NONE;
  if (classes.length === 0) return [];
  const bgLab = new Float64Array(3);
  oklabInto(bg[0], bg[1], bg[2], bgLab);
  const palLab = mode.palette.map(([rgb]) => {
    const lab = new Float64Array(3);
    oklabInto(rgb[0], rgb[1], rgb[2], lab);
    return lab;
  });
  const { tolerance, inkThreshold } = mode;
  const lab = new Float64Array(3);
  const labelOf = (r: number, g: number, b: number, a: number): number => {
    if (a === 255) oklabInto(r, g, b, lab);
    else oklabInto(composite(r, bg[0], a), composite(g, bg[1], a), composite(b, bg[2], a), lab);
    if (oklabDistance(lab, bgLab) <= inkThreshold) return NONE;
    let best = NONE;
    let bestD = 0;
    for (let k = 0; k < palLab.length; k++) {
      const dk = oklabDistance(lab, palLab[k]!);
      if (dk <= tolerance && (best === NONE || dk < bestD)) {
        best = k;
        bestD = dk;
      }
    }
    return best === NONE ? unmatched : entryClass[best]!;
  };
  const memo = new ColorMemo();
  const { keys, vals } = memo;
  const res = new Resampler(s.cols, s.rows, s.gcols, s.grows, classes.length);
  const d = img.data;
  let lastKey = 0.5;
  let lastLabel = NONE;
  for (let py = s.rows.lo; py < s.rows.hi; py++) {
    if (!res.beginRow(py)) continue;
    let o = py * s.w * 4 + s.cols.lo * 4;
    for (let px = s.cols.lo; px < s.cols.hi; px++, o += 4) {
      const key = d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24);
      if (key !== lastKey) {
        lastKey = key;
        const slot = ColorMemo.slot(key);
        if (vals[slot] !== 0 && keys[slot] === key) {
          lastLabel = vals[slot]! - 2;
        } else {
          lastLabel = labelOf(d[o]!, d[o + 1]!, d[o + 2]!, d[o + 3]!);
          keys[slot] = key;
          vals[slot] = lastLabel + 2;
        }
      }
      if (lastLabel !== NONE) res.addOne(lastLabel, px);
    }
    res.endRow(py);
  }
  const grids = res.finish();
  const out: ClassCoverage[] = [];
  for (let c = 0; c < classes.length; c++) {
    const g = grids[c]!;
    if (g.some((q) => q > 0)) out.push({ class: classes[c]!, coverage: g });
  }
  return out;
}

/** Saliency on exact integer luma numerators (see the Rust implementation). */
function saliency(s: Setup, img: Rgba): Uint8Array {
  const { w, h } = s;
  const d = img.data;
  const n = new Int32Array(w * h);
  for (let i = 0; i < w * h; i++) n[i] = lumaNumerator(d, i * 4);
  const hs = new Int32Array(w * h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      let sum = 0;
      const x1 = Math.min(x + 2, w - 1);
      for (let xx = Math.max(x - 2, 0); xx <= x1; xx++) sum += n[r + xx]!;
      hs[r + x] = sum;
    }
  }
  let g = 0;
  let c = 0;
  const gc = (x: number, y: number): void => {
    const xm = x > 0 ? x - 1 : 0;
    const xp = x + 1 < w ? x + 1 : w - 1;
    const ym = (y > 0 ? y - 1 : 0) * w;
    const yc = y * w;
    const yp = (y + 1 < h ? y + 1 : h - 1) * w;
    const gx = n[ym + xp]! + 2 * n[yc + xp]! + n[yp + xp]! - (n[ym + xm]! + 2 * n[yc + xm]! + n[yp + xm]!);
    const gy = n[yp + xm]! + 2 * n[yp + x]! + n[yp + xp]! - (n[ym + xm]! + 2 * n[ym + x]! + n[ym + xp]!);
    g = Math.sqrt(gx * gx + gy * gy);
    const y0 = y > 2 ? y - 2 : 0;
    const y1 = y + 2 < h ? y + 2 : h - 1;
    let sum = 0;
    for (let yy = y0; yy <= y1; yy++) sum += hs[yy * w + x]!;
    const k = (Math.min(x + 2, w - 1) - Math.max(x - 2, 0) + 1) * (y1 - y0 + 1);
    c = Math.abs(k * n[yc + x]! - sum) / k;
  };
  let maxG = 0;
  let maxC = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      gc(x, y);
      if (g > maxG) maxG = g;
      if (c > maxC) maxC = c;
    }
  }
  const res = new Resampler(s.cols, s.rows, s.gcols, s.grows, 1);
  for (let py = s.rows.lo; py < s.rows.hi; py++) {
    if (!res.beginRow(py)) continue;
    for (let px = s.cols.lo; px < s.cols.hi; px++) {
      gc(px, py);
      const tg = maxG > 0 ? g / maxG : 0;
      const tc = maxC > 0 ? c / maxC : 0;
      const v = (tg + tc) / 2;
      if (v !== 0) res.add(0, px, v);
    }
    res.endRow(py);
  }
  return res.finish()[0]!;
}
