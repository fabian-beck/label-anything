// Colour helpers (spec §4.6): hex colours, deterministic OKLab, background estimation.
//
// Only IEEE-754 `+ − × ÷ sqrt` in the same evaluation order as the Rust crate, so both
// produce the same bits. No Math.pow / Math.cbrt / Math.round / Math.hypot.

import { isValidRgba, type Rgba } from "./rgba.js";
import { SRGB_TO_LINEAR } from "./srgb-lut.js";

/** An 8-bit sRGB colour `[r, g, b]` (integers 0..255). */
export type Rgb = [number, number, number];

/** An OKLab colour `[L, a, b]`. */
export type Oklab = [number, number, number];

function hexDigit(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

/**
 * Parses `#rgb` or `#rrggbb` (hex digits in either case); `#rgb` expands each digit `d`
 * to `dd`. Anything else (no `#`, other lengths, whitespace) gives `null`.
 */
export function parseHexColor(s: string): Rgb | null {
  if (s.charCodeAt(0) !== 0x23) return null;
  const n = s.length - 1;
  if (n !== 3 && n !== 6) return null;
  const d: number[] = [];
  for (let i = 1; i <= n; i++) {
    const v = hexDigit(s.charCodeAt(i));
    if (v < 0) return null;
    d.push(v);
  }
  return n === 3
    ? [d[0]! * 17, d[1]! * 17, d[2]! * 17]
    : [(d[0]! << 4) | d[1]!, (d[2]! << 4) | d[3]!, (d[4]! << 4) | d[5]!];
}

/** Coefficients of the initial guess `((C3·m + C2)·m + C1)·m + C0 ≈ ∛m` on `[1/8, 1)`. */
const CBRT_C0 = 0.3408421562;
const CBRT_C1 = 1.458110692;
const CBRT_C2 = -1.385919418;
const CBRT_C3 = 0.5921815819;

/**
 * Deterministic cube root using only `+ − × ÷` (spec §4.6; identical to Rust):
 * exact range reduction `x = m · 8^k`, `m ∈ [1/8, 1)`; a cubic initial guess; three
 * Newton steps `y = y − (y·y·y − m) / (3·y·y)`; result `y · 2^k`. Within 1 ulp.
 */
export function cbrt(x: number): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  if (x < 0) return -cbrt(-x);
  let m = x;
  let s = 1;
  while (m < 0.125) {
    m *= 8;
    s *= 0.5;
  }
  while (m >= 1) {
    m *= 0.125;
    s *= 2;
  }
  let y = ((CBRT_C3 * m + CBRT_C2) * m + CBRT_C1) * m + CBRT_C0;
  y -= (y * y * y - m) / (3 * y * y);
  y -= (y * y * y - m) / (3 * y * y);
  y -= (y * y * y - m) / (3 * y * y);
  return y * s;
}

/** OKLab of an 8-bit colour into `out` (no validation; hot path). */
export function oklabInto(r: number, g: number, b: number, out: Float64Array | number[]): void {
  const lr = SRGB_TO_LINEAR[r]!;
  const lg = SRGB_TO_LINEAR[g]!;
  const lb = SRGB_TO_LINEAR[b]!;
  const l = cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  out[0] = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  out[1] = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  out[2] = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
}

function isByte(v: number): boolean {
  return Number.isInteger(v) && v >= 0 && v <= 255;
}

/**
 * Converts an 8-bit sRGB colour to OKLab `[L, a, b]` (Björn Ottosson's published
 * matrices) with the exactly rounded sRGB table and {@link cbrt}; bit-identical to the
 * Rust `srgb_to_oklab`. Throws a `RangeError` unless the channels are integers 0..255.
 */
export function srgbToOklab(rgb: readonly [number, number, number]): Oklab {
  if (!isByte(rgb[0]) || !isByte(rgb[1]) || !isByte(rgb[2])) {
    throw new RangeError(`srgbToOklab: channels must be integers 0..255, got ${String(rgb)}`);
  }
  const out: Oklab = [0, 0, 0];
  oklabInto(rgb[0], rgb[1], rgb[2], out);
  return out;
}

/** Euclidean OKLab distance `sqrt((ΔL·ΔL + Δa·Δa) + Δb·Δb)`. */
export function oklabDistance(p: ArrayLike<number>, q: ArrayLike<number>): number {
  const dl = p[0]! - q[0]!;
  const da = p[1]! - q[1]!;
  const db = p[2]! - q[2]!;
  return Math.sqrt(dl * dl + da * da + db * db);
}

/**
 * Composites an 8-bit channel over a background channel by alpha `a`, rounded to 8 bits:
 * `(c·a + bg·(255 − a) + 127) div 255` (exact; no halves exist).
 */
export function composite(c: number, bg: number, a: number): number {
  return ((c * a + bg * (255 - a) + 127) / 255) | 0;
}

/**
 * Estimates the background colour (spec §4.6): the most frequent colour among the
 * border pixels (first/last row and column, each counted once), quantized to 5 bits per
 * channel; pixels with alpha < 128 are skipped; ties go to the smallest packed value
 * `(r5 << 10) | (g5 << 5) | b5`; the winner is expanded as `(q << 3) | (q >> 2)`.
 * White if no border pixel qualifies (or the image is invalid).
 */
export function estimateBackground(img: Rgba): Rgb {
  if (!isValidRgba(img)) return [255, 255, 255];
  const w = img.width;
  const h = img.height;
  const d = img.data;
  const hist = new Uint32Array(1 << 15);
  let counted = 0;
  const count = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    if (d[i + 3]! >= 128) {
      hist[((d[i]! >> 3) << 10) | ((d[i + 1]! >> 3) << 5) | (d[i + 2]! >> 3)]!++;
      counted++;
    }
  };
  for (let x = 0; x < w; x++) count(x, 0);
  if (h > 1) for (let x = 0; x < w; x++) count(x, h - 1);
  for (let y = 1; y < h - 1; y++) {
    count(0, y);
    if (w > 1) count(w - 1, y);
  }
  if (counted === 0) return [255, 255, 255];
  let best = 0;
  for (let key = 1; key < hist.length; key++) if (hist[key]! > hist[best]!) best = key;
  const expand = (q: number): number => (q << 3) | (q >> 2);
  return [expand(best >> 10), expand((best >> 5) & 31), expand(best & 31)];
}
