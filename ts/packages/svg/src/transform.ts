// `transform` lists, `viewBox` and `preserveAspectRatio`. Mirrors transform.rs.

import { type Affine, IDENTITY, affine, mul, rotate, scale, skewX, skewY, translate } from "./geom.js";
import { scanNumber, skipCommaWsp, skipWsp } from "./num.js";

function isAlpha(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);
}

/** Parses a transform list. An invalid list yields null (the attribute is ignored). */
export function parseTransform(s: string): Affine | null {
  let m = IDENTITY;
  let i = skipWsp(s, 0);
  while (i < s.length) {
    const ns = i;
    while (i < s.length && isAlpha(s.charCodeAt(i))) i++;
    const name = s.slice(ns, i);
    i = skipWsp(s, i);
    if (i >= s.length || s.charCodeAt(i) !== 0x28) return null;
    i = skipWsp(s, i + 1);
    const args: number[] = [];
    while (i < s.length && s.charCodeAt(i) !== 0x29) {
      const r = scanNumber(s, i);
      if (r === null) return null;
      if (args.length === 6) return null;
      args.push(r[0]);
      i = skipCommaWsp(s, r[1]);
    }
    if (i >= s.length) return null;
    i++;
    const n = args.length;
    const a = (k: number): number => args[k]!;
    let t: Affine;
    if (name === "matrix" && n === 6) t = affine(a(0), a(1), a(2), a(3), a(4), a(5));
    else if (name === "translate" && n === 1) t = translate(a(0), 0);
    else if (name === "translate" && n === 2) t = translate(a(0), a(1));
    else if (name === "scale" && n === 1) t = scale(a(0), a(0));
    else if (name === "scale" && n === 2) t = scale(a(0), a(1));
    else if (name === "rotate" && n === 1) t = rotate(a(0));
    else if (name === "rotate" && n === 3) {
      t = mul(mul(translate(a(1), a(2)), rotate(a(0))), translate(-a(1), -a(2)));
    } else if (name === "skewX" && n === 1) t = skewX(a(0));
    else if (name === "skewY" && n === 1) t = skewY(a(0));
    else return null;
    m = mul(m, t);
    i = skipCommaWsp(s, i);
  }
  return m;
}

/** `viewBox="min-x min-y width height"`; null if invalid or width/height ≤ 0. */
export function parseViewBox(s: string): [number, number, number, number] | null {
  const v = [0, 0, 0, 0] as [number, number, number, number];
  let i = skipWsp(s, 0);
  for (let k = 0; k < 4; k++) {
    const r = scanNumber(s, i);
    if (r === null) return null;
    v[k] = r[0];
    i = k < 3 ? skipCommaWsp(s, r[1]) : skipWsp(s, r[1]);
  }
  if (i !== s.length || v[2] <= 0 || v[3] <= 0) return null;
  return v;
}

/** `preserveAspectRatio`: alignment fractions (null = `none`) and `slice`. */
export interface AspectRatio {
  align: [number, number] | null;
  slice: boolean;
}

export const DEFAULT_ASPECT_RATIO: AspectRatio = { align: [0.5, 0.5], slice: false };

const ALIGN: Record<string, number> = { xMin: 0, xMid: 0.5, xMax: 1, YMin: 0, YMid: 0.5, YMax: 1 };

export function parseAspectRatio(s: string): AspectRatio {
  const toks = s.split(/[ \t\n\r\f]+/).filter((t) => t.length > 0);
  let k = 0;
  if (toks[k] === "defer") k++;
  const tok = toks[k++];
  let align: [number, number] | null;
  if (tok === "none") align = null;
  else if (tok !== undefined && tok.length === 8) {
    const fx = ALIGN[tok.slice(0, 4)];
    const fy = ALIGN[tok.slice(4, 8)];
    if (fx === undefined || fy === undefined || !tok.startsWith("x") || tok.charAt(4) !== "Y") {
      return DEFAULT_ASPECT_RATIO;
    }
    align = [fx, fy];
  } else return DEFAULT_ASPECT_RATIO;
  const m = toks[k++];
  let slice: boolean;
  if (m === undefined || m === "meet") slice = false;
  else if (m === "slice") slice = true;
  else return DEFAULT_ASPECT_RATIO;
  if (toks[k] !== undefined) return DEFAULT_ASPECT_RATIO;
  return { align, slice };
}

/** The transform mapping `viewBox` into the viewport `(0, 0, w, h)`. */
export function viewBoxTransform(
  vb: [number, number, number, number] | null,
  par: AspectRatio,
  w: number,
  h: number,
): Affine {
  if (vb === null) return IDENTITY;
  const [vx, vy, vw, vh] = vb;
  let sx = w / vw;
  let sy = h / vh;
  let fx = 0;
  let fy = 0;
  if (par.align !== null) {
    const s = par.slice ? Math.max(sx, sy) : Math.min(sx, sy);
    sx = s;
    sy = s;
    [fx, fy] = par.align;
  }
  const tx = -vx * sx + (w - vw * sx) * fx;
  const ty = -vy * sy + (h - vh * sy) * fy;
  return affine(sx, 0, 0, sy, tx, ty);
}
