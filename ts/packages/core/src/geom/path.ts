/**
 * SVG path data: parsing and flattening to polylines, used by `path` marks (port of
 * `rust/crates/la-core/src/geom/path.rs`).
 *
 * The flattening is deterministic (adaptive de Casteljau subdivision with a fixed
 * flatness test; arcs with a sagitta-based segment count) and identical to Rust.
 *
 * @module
 */

import { atan2Deg, sinCosDeg } from "../detmath.js";
import { toIndex } from "../math.js";
import { P } from "./index.js";

/** A flattened sub-path. */
export interface SubPath {
  points: P[];
  closed: boolean;
}

/**
 * Error with the offset of the problem in the path string. Offsets are UTF-8 byte
 * offsets as in Rust; they equal UTF-16 indices because the lexer stops at the first
 * non-ASCII character.
 */
export class PathError extends Error {
  /** Offset of the problem (UTF-8 bytes). */
  readonly offset: number;

  constructor(offset: number, message: string) {
    super(message);
    this.name = "PathError";
    this.offset = offset;
  }
}

// ASCII character codes
const C_PLUS = 43;
const C_COMMA = 44;
const C_MINUS = 45;
const C_DOT = 46;
const C_0 = 48;
const C_1 = 49;
const C_9 = 57;
const C_E = 69;
const C_e = 101;

/** Rust `u8::is_ascii_whitespace` (space, \t, \n, \f, \r) or ','. */
function isSep(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 12 || c === 13 || c === C_COMMA;
}

function isDigit(c: number): boolean {
  return c >= C_0 && c <= C_9;
}

function isAlpha(c: number): boolean {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}

function isLower(c: number): boolean {
  return c >= 97 && c <= 122;
}

function upper(c: number): number {
  return isLower(c) ? c - 32 : c;
}

class Lexer {
  readonly s: string;
  i = 0;

  constructor(s: string) {
    this.s = s;
  }

  /** Code at `j`, or -1 past the end. */
  at(j: number): number {
    return j < this.s.length ? this.s.charCodeAt(j) : -1;
  }

  skipWs(): void {
    while (this.i < this.s.length && isSep(this.s.charCodeAt(this.i))) this.i += 1;
  }

  peekCmd(): number | null {
    this.skipWs();
    const c = this.at(this.i);
    return c >= 0 && isAlpha(c) && c !== C_e && c !== C_E ? c : null;
  }

  atNumber(): boolean {
    this.skipWs();
    const c = this.at(this.i);
    return c >= 0 && (isDigit(c) || c === C_MINUS || c === C_PLUS || c === C_DOT);
  }

  number(): number {
    this.skipWs();
    const start = this.i;
    let j = this.i;
    let c = this.at(j);
    if (c === C_PLUS || c === C_MINUS) j += 1;
    let digits = 0;
    while (isDigit(this.at(j))) {
      j += 1;
      digits += 1;
    }
    if (this.at(j) === C_DOT) {
      j += 1;
      while (isDigit(this.at(j))) {
        j += 1;
        digits += 1;
      }
    }
    if (digits === 0) throw new PathError(start, "expected a number");
    c = this.at(j);
    if (c === C_e || c === C_E) {
      let k = j + 1;
      const s = this.at(k);
      if (s === C_PLUS || s === C_MINUS) k += 1;
      const ks = k;
      while (isDigit(this.at(k))) k += 1;
      if (k > ks) j = k;
    }
    this.i = j;
    // The token is [+-]digits[.digits][e[+-]digits]: JS Number() and Rust's
    // f64::from_str both round it correctly.
    const v = Number(this.s.slice(start, j));
    if (!Number.isFinite(v)) throw new PathError(start, "invalid number");
    return v;
  }

  flag(): boolean {
    this.skipWs();
    const c = this.at(this.i);
    if (c === C_0) {
      this.i += 1;
      return false;
    }
    if (c === C_1) {
      this.i += 1;
      return true;
    }
    throw new PathError(this.i, "expected an arc flag (0 or 1)");
  }
}

const CMD_M = 77;
const CMD_L = 76;
const CMD_H = 72;
const CMD_V = 86;
const CMD_C = 67;
const CMD_S = 83;
const CMD_Q = 81;
const CMD_T = 84;
const CMD_A = 65;
const CMD_Z = 90;
const CMD_NONE = 32; // b' '

/** Parse and flatten SVG path data with the given tolerance (px). Throws {@link PathError}. */
export function flatten(d: string, tol: number): SubPath[] {
  tol = tol > 0 ? tol : 0.25;
  const lx = new Lexer(d);
  const out: SubPath[] = [];
  let cur: P[] = [];
  let pos = new P(0, 0);
  let start = new P(0, 0);
  let lastCtrl: P | null = null; // reflected control for S/T
  let lastCmd = CMD_NONE;
  let cmd: number | null = null;
  const finish = (closed: boolean): void => {
    if (cur.length >= 2 || (closed && cur.length > 0)) {
      out.push({ points: cur, closed });
      cur = [];
    } else {
      cur.length = 0;
    }
  };
  for (;;) {
    const pc = lx.peekCmd();
    if (pc !== null) {
      lx.i += 1;
      cmd = pc;
    } else if (lx.i >= lx.s.length) {
      break;
    } else if (!lx.atNumber() || cmd === null) {
      throw new PathError(lx.i, "expected a path command");
    }
    const c: number = cmd ?? CMD_M;
    const rel = isLower(c);
    const base = rel ? pos : new P(0, 0);
    switch (upper(c)) {
      case CMD_M: {
        const x = lx.number();
        const y = lx.number();
        finish(false);
        pos = new P(base.x + x, base.y + y);
        start = pos;
        cur.push(pos);
        // subsequent pairs are implicit line-tos
        cmd = rel ? 108 /* l */ : CMD_L;
        lastCtrl = null;
        break;
      }
      case CMD_L: {
        const x = lx.number();
        const y = lx.number();
        pos = new P(base.x + x, base.y + y);
        pushPt(cur, pos);
        lastCtrl = null;
        break;
      }
      case CMD_H: {
        const x = lx.number();
        pos = new P(rel ? pos.x + x : x, pos.y);
        pushPt(cur, pos);
        lastCtrl = null;
        break;
      }
      case CMD_V: {
        const y = lx.number();
        pos = new P(pos.x, rel ? pos.y + y : y);
        pushPt(cur, pos);
        lastCtrl = null;
        break;
      }
      case CMD_C:
      case CMD_S: {
        const isS = upper(c) === CMD_S;
        let c1: P;
        if (isS) {
          const lu = upper(lastCmd);
          c1 = (lu === CMD_C || lu === CMD_S) && lastCtrl !== null ? pos.mul(2).sub(lastCtrl) : pos;
        } else {
          const x1 = lx.number();
          const y1 = lx.number();
          c1 = new P(base.x + x1, base.y + y1);
        }
        const x2 = lx.number();
        const y2 = lx.number();
        const x = lx.number();
        const y = lx.number();
        const c2 = new P(base.x + x2, base.y + y2);
        const end = new P(base.x + x, base.y + y);
        if (cur.length === 0) cur.push(pos);
        cubic(cur, pos, c1, c2, end, tol, 0);
        lastCtrl = c2;
        pos = end;
        break;
      }
      case CMD_Q:
      case CMD_T: {
        const isT = upper(c) === CMD_T;
        let q: P;
        if (isT) {
          const lu = upper(lastCmd);
          q = (lu === CMD_Q || lu === CMD_T) && lastCtrl !== null ? pos.mul(2).sub(lastCtrl) : pos;
        } else {
          const x1 = lx.number();
          const y1 = lx.number();
          q = new P(base.x + x1, base.y + y1);
        }
        const x = lx.number();
        const y = lx.number();
        const end = new P(base.x + x, base.y + y);
        if (cur.length === 0) cur.push(pos);
        // elevate to cubic
        const c1 = pos.add(q.sub(pos).mul(2 / 3));
        const c2 = end.add(q.sub(end).mul(2 / 3));
        cubic(cur, pos, c1, c2, end, tol, 0);
        lastCtrl = q;
        pos = end;
        break;
      }
      case CMD_A: {
        const rx = Math.abs(lx.number());
        const ry = Math.abs(lx.number());
        const rot = lx.number();
        const large = lx.flag();
        const sweep = lx.flag();
        const x = lx.number();
        const y = lx.number();
        const end = new P(base.x + x, base.y + y);
        if (cur.length === 0) cur.push(pos);
        arc(cur, pos, rx, ry, rot, large, sweep, end, tol);
        pos = end;
        lastCtrl = null;
        break;
      }
      case CMD_Z: {
        pos = start;
        finish(true);
        lastCtrl = null;
        lastCmd = CMD_Z;
        cmd = null;
        continue;
      }
      default:
        throw new PathError(lx.i > 0 ? lx.i - 1 : 0, `unknown path command '${String.fromCharCode(c)}'`);
    }
    lastCmd = c;
  }
  finish(false);
  return out;
}

function pushPt(cur: P[], p: P): void {
  if (cur.length === 0 || !cur[cur.length - 1]!.eq(p)) cur.push(p);
}

function cubic(out: P[], p0: P, p1: P, p2: P, p3: P, tol: number, depth: number): void {
  // Flatness: max distance of the control points from the chord.
  const d = p3.sub(p0);
  const l = d.len();
  let flat: number;
  if (l > 0) {
    const a = Math.abs(p1.sub(p0).cross(d)) / l;
    const b = Math.abs(p2.sub(p0).cross(d)) / l;
    flat = a > b ? a : b;
  } else {
    const a = p1.dist(p0);
    const b = p2.dist(p0);
    flat = a > b ? a : b;
  }
  if (flat <= tol || depth >= 16) {
    pushPt(out, p3);
    return;
  }
  const p01 = p0.lerp(p1, 0.5);
  const p12 = p1.lerp(p2, 0.5);
  const p23 = p2.lerp(p3, 0.5);
  const p012 = p01.lerp(p12, 0.5);
  const p123 = p12.lerp(p23, 0.5);
  const mid = p012.lerp(p123, 0.5);
  cubic(out, p0, p01, p012, mid, tol, depth + 1);
  cubic(out, mid, p123, p23, p3, tol, depth + 1);
}

function arc(
  out: P[],
  p0: P,
  rx: number,
  ry: number,
  rotDeg: number,
  large: boolean,
  sweep: boolean,
  p1: P,
  tol: number,
): void {
  if (p0.eq(p1)) return;
  if (rx === 0 || ry === 0) {
    pushPt(out, p1);
    return;
  }
  const [sinR, cosR] = sinCosDeg(rotDeg);
  // Step 1: compute (x1', y1')
  const dx = (p0.x - p1.x) * 0.5;
  const dy = (p0.y - p1.y) * 0.5;
  const x1p = cosR * dx + sinR * dy;
  const y1p = -sinR * dx + cosR * dy;
  // Step 2: correct radii
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s;
    ry *= s;
  }
  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const num = rx2 * ry2 - rx2 * y1p * y1p - ry2 * x1p * x1p;
  const den = rx2 * y1p * y1p + ry2 * x1p * x1p;
  let coef = den > 0 && num > 0 ? Math.sqrt(num / den) : 0;
  if (large === sweep) coef = -coef;
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);
  const cx = cosR * cxp - sinR * cyp + (p0.x + p1.x) * 0.5;
  const cy = sinR * cxp + cosR * cyp + (p0.y + p1.y) * 0.5;
  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;
  const theta1 = atan2Deg(uy, ux);
  let dtheta = atan2Deg(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && dtheta > 0) {
    dtheta -= 360;
  } else if (sweep && dtheta < 0) {
    dtheta += 360;
  }
  const r = rx > ry ? rx : ry;
  // segment angle so that the sagitta r(1 - cos(δ/2)) ≈ r δ²/8 ≤ tol
  const stepRad = Math.sqrt((8 * tol) / r);
  const stepDeg = stepRad * (180 / Math.PI);
  const steps = toIndex(Math.ceil(Math.abs(dtheta) / stepDeg));
  const n = steps < 1 ? 1 : steps > 4096 ? 4096 : steps;
  for (let k = 1; k <= n; k++) {
    if (k === n) {
      pushPt(out, p1);
      break;
    }
    const t = theta1 + dtheta * (k / n);
    const [s, c] = sinCosDeg(t);
    const x = rx * c;
    const y = ry * s;
    pushPt(out, new P(cosR * x - sinR * y + cx, sinR * x + cosR * y + cy));
  }
}
