import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as dm from "../src/detmath.js";

const MATH_DIR = fileURLToPath(new URL("../../../../conformance/math/", import.meta.url));

interface MathFile {
  kind: string;
  function: string;
  inputs: number;
  outputs: number;
  vectors: string[][];
}

const FUNCS: Record<string, (a: number[]) => number[]> = {
  ln: (a) => [dm.ln(a[0]!)],
  ln_1p: (a) => [dm.ln1p(a[0]!)],
  exp: (a) => [dm.exp(a[0]!)],
  pow: (a) => [dm.pow(a[0]!, a[1]!)],
  sin_cos_deg: (a) => dm.sinCosDeg(a[0]!),
  atan2_deg: (a) => [dm.atan2Deg(a[0]!, a[1]!)],
  cbrt: (a) => [dm.cbrt(a[0]!)],
  floor: (a) => [dm.floor(a[0]!)],
  ceil: (a) => [dm.ceil(a[0]!)],
  trunc: (a) => [dm.trunc(a[0]!)],
  round_half_away: (a) => [dm.roundHalfAway(a[0]!)],
};

function sameBits(got: number, wantHex: string): boolean {
  const want = dm.hexToF64(wantHex);
  if (Number.isNaN(want)) return Number.isNaN(got);
  return dm.f64ToHex(got) === wantHex;
}

describe("conformance/math vectors (bit parity with Rust)", () => {
  const files = readdirSync(MATH_DIR)
    .filter((f) => f.endsWith(".json") && f !== "pcg32.json")
    .sort();

  it("covers every det_math function with >= 500 vectors", () => {
    const names = files.map((f) => (JSON.parse(readFileSync(MATH_DIR + f, "utf8")) as MathFile).function);
    expect(names.sort()).toEqual(Object.keys(FUNCS).sort());
  });

  for (const file of files) {
    it(file, () => {
      const doc = JSON.parse(readFileSync(MATH_DIR + file, "utf8")) as MathFile;
      expect(doc.kind).toBe("math");
      const f = FUNCS[doc.function];
      expect(f).toBeDefined();
      expect(doc.vectors.length).toBeGreaterThanOrEqual(500);
      const failures: string[] = [];
      for (const v of doc.vectors) {
        const args = v.slice(0, doc.inputs).map(dm.hexToF64);
        const got = f!(args);
        for (let k = 0; k < doc.outputs; k++) {
          const want = v[doc.inputs + k]!;
          if (!sameBits(got[k]!, want)) {
            failures.push(`${doc.function}(${v.slice(0, doc.inputs).join(", ")})[${k}] = ${dm.f64ToHex(got[k]!)}, want ${want}`);
          }
        }
      }
      expect(failures.slice(0, 5)).toEqual([]);
      expect(failures.length).toBe(0);
    });
  }
});

describe("bit helpers", () => {
  it("round-trips hex and handles signed zero and NaN", () => {
    expect(dm.f64ToHex(1)).toBe("0x3ff0000000000000");
    expect(dm.f64ToHex(-0)).toBe("0x8000000000000000");
    expect(dm.f64ToHex(5e-324)).toBe("0x0000000000000001");
    expect(dm.f64ToHex(NaN)).toBe("0x7ff8000000000000");
    expect(Object.is(dm.hexToF64("0x8000000000000000"), -0)).toBe(true);
    expect(dm.hexToF64("0x3fe6a09e667f3bcd")).toBe(Math.SQRT1_2);
  });
});

describe("special values", () => {
  const is = (a: number, b: number) => expect(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b))).toBe(true);

  it("ln / ln1p", () => {
    is(dm.ln(1), 0);
    is(dm.ln(0), -Infinity);
    is(dm.ln(-0), -Infinity);
    is(dm.ln(-1), NaN);
    is(dm.ln(Infinity), Infinity);
    is(dm.ln(Math.E), 1);
    is(dm.ln(2), Math.LN2);
    is(dm.ln(10), Math.LN10);
    is(dm.ln1p(-0), -0);
    is(dm.ln1p(-1), -Infinity);
    is(dm.ln1p(-2), NaN);
    is(dm.ln1p(1), Math.LN2);
  });

  it("exp", () => {
    is(dm.exp(0), 1);
    is(dm.exp(1), Math.E);
    is(dm.exp(-Infinity), 0);
    is(dm.exp(Infinity), Infinity);
    is(dm.exp(709.8), Infinity);
    is(dm.exp(-745), 5e-324);
    is(dm.exp(-745.2), 0);
  });

  it("pow follows C99, not Math.pow, on the edge cases", () => {
    is(dm.pow(1, NaN), 1);
    is(dm.pow(-1, Infinity), 1);
    is(dm.pow(NaN, 0), 1);
    is(dm.pow(-0, -3), -Infinity);
    is(dm.pow(-0, 3), -0);
    is(dm.pow(-Infinity, -3), -0);
    is(dm.pow(-Infinity, 3), -Infinity);
    is(dm.pow(-8, 1 / 3), NaN);
    is(dm.pow(-2, 3), -8);
    is(dm.pow(2, 0.5), Math.SQRT2);
    is(dm.pow(2, -1074), 5e-324);
    is(dm.pow(10, 22), 1e22);
    for (let i = 1; i < 200; i++) {
      const x = 1 + i / 128;
      is(dm.pow(x, 2), x * x);
      is(dm.pow(x, -1), 1 / x);
    }
  });

  it("sinCosDeg is exact at multiples of 30 and 45 degrees", () => {
    const h = Math.SQRT1_2;
    const s3 = Math.sqrt(0.75);
    const cases: [number, number, number][] = [
      [0, 0, 1],
      [30, 0.5, s3],
      [45, h, h],
      [60, s3, 0.5],
      [90, 1, 0],
      [135, h, -h],
      [180, 0, -1],
      [270, -1, 0],
      [-90, -1, 0],
      [-180, -0, -1],
      [-360, -0, 1],
      [-0, -0, 1],
    ];
    for (const [d, s, c] of cases) {
      const [gs, gc] = dm.sinCosDeg(d);
      is(gs, s);
      is(gc, c);
      is(dm.sinDeg(d), s);
      is(dm.cosDeg(d), c);
    }
    const [ns, nc] = dm.sinCosDeg(Infinity);
    is(ns, NaN);
    is(nc, NaN);
  });

  it("atan2Deg special cases", () => {
    is(dm.atan2Deg(0, 0), 0);
    is(dm.atan2Deg(-0, 0), -0);
    is(dm.atan2Deg(0, -0), 180);
    is(dm.atan2Deg(-0, -0), -180);
    is(dm.atan2Deg(1, 0), 90);
    is(dm.atan2Deg(-1, -0), -90);
    is(dm.atan2Deg(Infinity, -Infinity), 135);
    is(dm.atan2Deg(-Infinity, Infinity), -45);
    is(dm.atan2Deg(1, 1), 45);
    is(dm.atan2Deg(2, -2), 135);
    is(dm.atan2Deg(NaN, 1), NaN);
  });

  it("cbrt", () => {
    is(dm.cbrt(-0), -0);
    is(dm.cbrt(-Infinity), -Infinity);
    for (let k = 1; k < 2000; k++) {
      is(dm.cbrt(k * k * k), k);
      is(dm.cbrt(-(k * k * k)), -k);
    }
  });

  it("rounding matches Math.floor/ceil/trunc exactly; roundHalfAway is C round", () => {
    const xs = [0, -0, 0.5, -0.5, 0.49999999999999994, -0.49999999999999994, 2.5, -2.5,
      4503599627370495.5, -4503599627370495.5, 4503599627370496, 1e300, 5e-324, -5e-324,
      Infinity, -Infinity];
    for (let i = 0; i < 100000; i++) xs.push((i - 50000) / 7, (i - 50000) * 0.25);
    const bad: number[] = [];
    for (const x of xs) {
      if (!Object.is(dm.floor(x), Math.floor(x))) bad.push(x);
      if (!Object.is(dm.ceil(x), Math.ceil(x))) bad.push(x);
      if (!Object.is(dm.trunc(x), Math.trunc(x))) bad.push(x);
      // C round via exact integer arithmetic on |x| (|x| + 0.5 is exact for these inputs)
      const ax = Math.abs(x);
      if (ax < 4503599627370496 && ax !== 0.49999999999999994) {
        const m = Math.floor(ax + 0.5);
        const r = x < 0 || Object.is(x, -0) ? -m : m;
        if (!Object.is(dm.roundHalfAway(x), r)) bad.push(x);
      }
    }
    expect(bad).toEqual([]);
    is(dm.roundHalfAway(0.49999999999999994), 0);
    is(dm.roundHalfAway(-0.49999999999999994), -0);
    is(dm.roundHalfAway(-2.5), -3);
    is(dm.roundHalfAway(2.5), 3);
    is(dm.floor(NaN), NaN);
  });
});
