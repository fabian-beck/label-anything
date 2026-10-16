// Accuracy of detmath against the platform `Math` functions (V8: fdlibm ports).
// Target: at most 2 ulp over the tested ranges (same ranges as the Rust test
// rust/crates/la-expr/tests/det_math_accuracy.rs). Set LA_ACCURACY_SAMPLES to change the
// number of samples per range (default 100 000).
import { describe, expect, it } from "vitest";
import * as dm from "../src/detmath.js";
import { Pcg32 } from "../src/pcg.js";

const N = Number(process.env.LA_ACCURACY_SAMPLES ?? 100000);
const MAX_ULP = 2n;

const buf = new DataView(new ArrayBuffer(8));
function ord(x: number): bigint {
  buf.setFloat64(0, x);
  const b = buf.getBigUint64(0);
  return b >> 63n ? -(b & 0x7fffffffffffffffn) : b;
}
function ulpDiff(a: number, b: number): bigint {
  if (Number.isNaN(a) || Number.isNaN(b)) return Number.isNaN(a) && Number.isNaN(b) ? 0n : 1n << 62n;
  const d = ord(a) - ord(b);
  return d < 0n ? -d : d;
}

class Stat {
  max = 0n;
  worst = "";
  n = 0;
  constructor(readonly name: string) {}
  add(got: number, want: number, what: () => string): void {
    this.n++;
    const d = ulpDiff(got, want);
    if (d > this.max) {
      this.max = d;
      this.worst = `${what()} got ${got} want ${want}`;
    }
  }
  check(): void {
    console.log(`${this.name.padEnd(42)} n=${this.n} max=${this.max} ulp ${this.worst}`);
    expect(this.max, `${this.name}: ${this.worst}`).toBeLessThanOrEqual(MAX_ULP);
  }
}

function logUniform(rng: Pcg32, lo: number, hi: number): number {
  const e = Math.floor(lo + (hi - lo) * rng.nextF64());
  return (1 + rng.nextF64()) * 2 ** e; // test-only use of ** to build inputs
}

describe("detmath vs Math (<= 2 ulp)", () => {
  it("ln", () => {
    const rng = new Pcg32(1);
    const a = new Stat("ln, 2^-1074..2^1024");
    const b = new Stat("ln, [0.5, 2]");
    for (let i = 0; i < N; i++) {
      const x = logUniform(rng, -1074, 1023);
      if (x > 0 && Number.isFinite(x)) a.add(dm.ln(x), Math.log(x), () => `ln(${x})`);
      const y = 0.5 + 1.5 * rng.nextF64();
      b.add(dm.ln(y), Math.log(y), () => `ln(${y})`);
    }
    a.check();
    b.check();
  });

  it("ln1p", () => {
    const rng = new Pcg32(2);
    const a = new Stat("ln1p, (-1, 1e300]");
    const b = new Stat("ln1p, |x| < 1");
    for (let i = 0; i < N; i++) {
      const x = logUniform(rng, -60, 997);
      a.add(dm.ln1p(x), Math.log1p(x), () => `ln1p(${x})`);
      const y = rng.nextF64() * 2 - 1;
      if (y > -1) b.add(dm.ln1p(y), Math.log1p(y), () => `ln1p(${y})`);
      const t = -logUniform(rng, -60, -0.0001);
      if (t > -1) b.add(dm.ln1p(t), Math.log1p(t), () => `ln1p(${t})`);
    }
    a.check();
    b.check();
  });

  it("exp", () => {
    const rng = new Pcg32(3);
    const a = new Stat("exp, [-745, 709.78]");
    const b = new Stat("exp, |x| in [2^-60, 1]");
    for (let i = 0; i < N; i++) {
      const x = -745 + (709.78 + 745) * rng.nextF64();
      a.add(dm.exp(x), Math.exp(x), () => `exp(${x})`);
      let y = logUniform(rng, -60, 0);
      if (rng.nextU32() & 1) y = -y;
      b.add(dm.exp(y), Math.exp(y), () => `exp(${y})`);
    }
    a.check();
    b.check();
  });

  it("pow", () => {
    const rng = new Pcg32(4);
    const a = new Stat("pow, x in (2^-40, 2^40), |y| < 50");
    const b = new Stat("pow, |x| < 1000, integer |y| <= 64");
    const c = new Stat("pow, x near 1, |y| up to 1e12");
    for (let i = 0; i < N; i++) {
      const x = logUniform(rng, -40, 40);
      const y = (rng.nextF64() - 0.5) * 100;
      const w = Math.pow(x, y);
      if (Number.isFinite(w) && w !== 0) a.add(dm.pow(x, y), w, () => `pow(${x}, ${y})`);
      const xi = (rng.nextF64() - 0.5) * 2000;
      const yi = rng.nextBelow(129) - 64;
      b.add(dm.pow(xi, yi), Math.pow(xi, yi), () => `pow(${xi}, ${yi})`);
      const x1 = 1 + (rng.nextF64() - 0.5) * 1e-9;
      const y1 = (rng.nextF64() - 0.5) * 2e12;
      const w1 = Math.pow(x1, y1);
      if (Number.isFinite(w1) && w1 !== 0) c.add(dm.pow(x1, y1), w1, () => `pow(${x1}, ${y1})`);
    }
    a.check();
    b.check();
    c.check();
  });

  it("sinCosDeg", () => {
    const rng = new Pcg32(5);
    const s = new Stat("sinDeg, [-45, 45] vs Math.sin(d·π/180)");
    const c = new Stat("cosDeg, [-45, 45] vs Math.cos(d·π/180)");
    const s2 = new Stat("sinDeg, [-1e6, 1e6] vs Math on reduced angle");
    const c2 = new Stat("cosDeg, [-1e6, 1e6] vs Math on reduced angle");
    for (let i = 0; i < N; i++) {
      const d = (rng.nextF64() - 0.5) * 90;
      const [gs, gc] = dm.sinCosDeg(d);
      s.add(gs, Math.sin(d * (Math.PI / 180)), () => `sinDeg(${d})`);
      c.add(gc, Math.cos(d * (Math.PI / 180)), () => `cosDeg(${d})`);
      // reduced reference: exact reduction in degrees (as detmath), Math on [-45, 45]
      const e = (rng.nextF64() - 0.5) * 2e6;
      const r = e % 360;
      const a = Math.abs(r);
      const [t, q] = a <= 45 ? [a, 0] : a < 135 ? [a - 90, 1] : a <= 225 ? [a - 180, 2] : a < 315 ? [a - 270, 3] : [a - 360, 0];
      const x = t * (Math.PI / 180);
      let ws = Math.sin(x);
      let wc = Math.cos(x);
      [ws, wc] = q === 0 ? [ws, wc] : q === 1 ? [wc, -ws] : q === 2 ? [-ws, -wc] : [-wc, ws];
      if (r < 0) ws = -ws;
      const [es, ec] = dm.sinCosDeg(e);
      s2.add(es, ws, () => `sinDeg(${e})`);
      c2.add(ec, wc, () => `cosDeg(${e})`);
    }
    s.check();
    c.check();
    s2.check();
    c2.check();
  });

  // Math.atan2 works in radians; converting its result to degrees with the rounded 180/π
  // adds up to ~2.5 ulp of error on the platform side (verified with mpmath), so the
  // comparison is done in radians: detmath's degrees are converted with a double-double
  // π/180 (one rounding) and compared with Math.atan2 directly.
  const D2R_HI = Math.PI / 180;
  const D2R_LO = 2.9486522708701687e-19;
  function split(a: number): [number, number] {
    const c = 134217729 * a;
    const h = c - (c - a);
    return [h, a - h];
  }
  function toRadians(deg: number): number {
    const p = deg * D2R_HI;
    const [ah, al] = split(deg);
    const [bh, bl] = split(D2R_HI);
    const e = ((ah * bh - p) + ah * bl + al * bh) + al * bl;
    return p + (e + deg * D2R_LO);
  }

  it("atan2Deg", () => {
    const rng = new Pcg32(6);
    const a = new Stat("atan2Deg (in rad), unit square");
    const b = new Stat("atan2Deg (in rad), magnitudes 2^-500..2^500");
    for (let i = 0; i < N; i++) {
      const y = (rng.nextF64() - 0.5) * 2;
      const x = (rng.nextF64() - 0.5) * 2;
      a.add(toRadians(dm.atan2Deg(y, x)), Math.atan2(y, x), () => `atan2Deg(${y}, ${x})`);
      let yw = logUniform(rng, -500, 500);
      let xw = logUniform(rng, -500, 500);
      if (rng.nextU32() & 1) yw = -yw;
      if (rng.nextU32() & 1) xw = -xw;
      const w = Math.atan2(yw, xw);
      if (Math.abs(w) > 1e-290) b.add(toRadians(dm.atan2Deg(yw, xw)), w, () => `atan2Deg(${yw}, ${xw})`);
    }
    a.check();
    b.check();
  });

  it("cbrt", () => {
    const rng = new Pcg32(7);
    const a = new Stat("cbrt, 2^-1074..2^1024 both signs");
    for (let i = 0; i < N; i++) {
      let x = logUniform(rng, -1074, 1023);
      if (rng.nextU32() & 1) x = -x;
      if (Number.isFinite(x)) a.add(dm.cbrt(x), Math.cbrt(x), () => `cbrt(${x})`);
    }
    a.check();
  });
});
