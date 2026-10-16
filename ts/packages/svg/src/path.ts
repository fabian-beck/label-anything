// SVG path data → absolute segments. Mirrors path.rs. On the first error the path is
// rendered up to (and excluding) the offending command.

import { scanNumber, skipCommaWsp, skipWsp } from "./num.js";

export type Seg =
  | { k: "M"; x: number; y: number }
  | { k: "L"; x: number; y: number }
  | { k: "Q"; x1: number; y1: number; x: number; y: number }
  | { k: "C"; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { k: "A"; rx: number; ry: number; rot: number; large: boolean; sweep: boolean; x: number; y: number }
  | { k: "Z" };

const COMMANDS = "MmLlHhVvCcSsQqTtAaZz";

function startsNumber(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || b === 0x2e || b === 0x2d || b === 0x2b;
}

class Args {
  constructor(
    readonly s: string,
    public i: number,
  ) {}
  num(): number | null {
    const r = scanNumber(this.s, this.i);
    if (r === null) return null;
    this.i = skipCommaWsp(this.s, r[1]);
    return r[0];
  }
  flag(): boolean | null {
    const c = this.s.charCodeAt(this.i);
    let v: boolean;
    if (c === 0x30) v = false;
    else if (c === 0x31) v = true;
    else return null;
    this.i = skipCommaWsp(this.s, this.i + 1);
    return v;
  }
}

/** Parses path data into absolute segments. */
export function parsePath(d: string): Seg[] {
  const segs: Seg[] = [];
  const a = new Args(d, skipWsp(d, 0));
  let cx = 0;
  let cy = 0;
  let sx = 0;
  let sy = 0;
  let lastCubic: [number, number] | null = null;
  let lastQuad: [number, number] | null = null;
  let prev: string | null = null;
  for (;;) {
    a.i = skipWsp(d, a.i);
    if (a.i >= d.length) break;
    const chCode = d.charCodeAt(a.i);
    const ch = d.charAt(a.i);
    let cmd: string;
    if (COMMANDS.includes(ch)) {
      a.i++;
      a.i = skipWsp(d, a.i);
      cmd = ch;
    } else if (startsNumber(chCode)) {
      if (prev === "M") cmd = "L";
      else if (prev === "m") cmd = "l";
      else if (prev !== null && prev !== "Z" && prev !== "z") cmd = prev;
      else break;
    } else break;
    if (prev === null && cmd !== "M" && cmd !== "m") break;
    const rel = cmd >= "a";
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    let cubicCtrl: [number, number] | null = null;
    let quadCtrl: [number, number] | null = null;
    const up = cmd.toUpperCase();
    if (up === "Z") {
      segs.push({ k: "Z" });
      cx = sx;
      cy = sy;
    } else if (up === "M") {
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      cx = ox + x;
      cy = oy + y;
      sx = cx;
      sy = cy;
      segs.push({ k: "M", x: cx, y: cy });
    } else if (up === "L") {
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      cx = ox + x;
      cy = oy + y;
      segs.push({ k: "L", x: cx, y: cy });
    } else if (up === "H") {
      const x = a.num();
      if (x === null) break;
      cx = ox + x;
      segs.push({ k: "L", x: cx, y: cy });
    } else if (up === "V") {
      const y = a.num();
      if (y === null) break;
      cy = oy + y;
      segs.push({ k: "L", x: cx, y: cy });
    } else if (up === "C") {
      const x1 = a.num();
      if (x1 === null) break;
      const y1 = a.num();
      if (y1 === null) break;
      const x2r = a.num();
      if (x2r === null) break;
      const y2r = a.num();
      if (y2r === null) break;
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      const x2 = ox + x2r;
      const y2 = oy + y2r;
      segs.push({ k: "C", x1: ox + x1, y1: oy + y1, x2, y2, x: ox + x, y: oy + y });
      cubicCtrl = [x2, y2];
      cx = ox + x;
      cy = oy + y;
    } else if (up === "S") {
      const x2r = a.num();
      if (x2r === null) break;
      const y2r = a.num();
      if (y2r === null) break;
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      let x1 = cx;
      let y1 = cy;
      if (lastCubic !== null) {
        x1 = 2 * cx - lastCubic[0];
        y1 = 2 * cy - lastCubic[1];
      }
      const x2 = ox + x2r;
      const y2 = oy + y2r;
      segs.push({ k: "C", x1, y1, x2, y2, x: ox + x, y: oy + y });
      cubicCtrl = [x2, y2];
      cx = ox + x;
      cy = oy + y;
    } else if (up === "Q") {
      const x1r = a.num();
      if (x1r === null) break;
      const y1r = a.num();
      if (y1r === null) break;
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      const x1 = ox + x1r;
      const y1 = oy + y1r;
      segs.push({ k: "Q", x1, y1, x: ox + x, y: oy + y });
      quadCtrl = [x1, y1];
      cx = ox + x;
      cy = oy + y;
    } else if (up === "T") {
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      let x1 = cx;
      let y1 = cy;
      if (lastQuad !== null) {
        x1 = 2 * cx - lastQuad[0];
        y1 = 2 * cy - lastQuad[1];
      }
      segs.push({ k: "Q", x1, y1, x: ox + x, y: oy + y });
      quadCtrl = [x1, y1];
      cx = ox + x;
      cy = oy + y;
    } else if (up === "A") {
      const rx = a.num();
      if (rx === null) break;
      const ry = a.num();
      if (ry === null) break;
      const rot = a.num();
      if (rot === null) break;
      const large = a.flag();
      if (large === null) break;
      const sweep = a.flag();
      if (sweep === null) break;
      const x = a.num();
      if (x === null) break;
      const y = a.num();
      if (y === null) break;
      cx = ox + x;
      cy = oy + y;
      segs.push({ k: "A", rx, ry, rot, large, sweep, x: cx, y: cy });
    } else break;
    lastCubic = cubicCtrl;
    lastQuad = quadCtrl;
    prev = cmd;
  }
  return segs;
}
