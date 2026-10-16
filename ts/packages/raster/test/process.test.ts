import { describe, expect, it } from "vitest";
import {
  isValidRgba,
  process,
  rgbaFromBase64,
  rgbaFromBytes,
  RasterError,
  type ClassCoverage,
  type GridSpec,
  type Mode,
  type RasterPlacement,
  type Rgba,
} from "../src/index.js";

const WHITE = [255, 255, 255, 255];
const BLACK = [0, 0, 0, 255];

function image(w: number, h: number, f: (x: number, y: number) => number[]): Rgba {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return rgbaFromBytes(w, h, data);
}

const grid = (cols: number, rows: number, cell: number): GridSpec => ({ originX: 0, originY: 0, cell, cols, rows });
const at = (scale: number, x = 0, y = 0): RasterPlacement => ({ scale, offset: [x, y] });
const ink = (dilate: number, background: [number, number, number] | null = null): Mode => ({
  kind: "ink",
  background,
  threshold: 0.12,
  dilate,
});
const cov = (out: ClassCoverage[]): number[] => Array.from(out[0]!.coverage);

describe("process", () => {
  it("area-averages and quantizes", () => {
    const img = image(4, 2, (x, y) => (x === 0 && y === 0 ? BLACK : WHITE));
    const out = process(img, ink(0), "ink", at(1), grid(2, 1, 2));
    expect(out.map((c) => c.class)).toEqual(["ink"]);
    expect(cov(out)).toEqual([64, 0]);
    const sparse = image(100, 100, (x, y) => (x === 50 && y === 50 ? BLACK : WHITE));
    expect(cov(process(sparse, ink(0), "ink", at(1), grid(1, 1, 100)))).toEqual([1]);
  });

  it("maps HiDPI scale and offsets", () => {
    const img = image(4, 4, (x, y) => (x < 2 && y < 2 ? BLACK : WHITE));
    expect(cov(process(img, ink(0), "ink", at(2), grid(2, 2, 1)))).toEqual([255, 0, 0, 0]);
    expect(cov(process(img, ink(0), "ink", at(2, 0.5, 0.5), grid(3, 3, 1)))).toEqual([64, 64, 0, 64, 64, 0, 0, 0, 0]);
    const one = image(1, 1, () => BLACK);
    expect(cov(process(one, ink(0, [255, 255, 255]), "ink", at(0.5, 1, 0), grid(4, 2, 1)))).toEqual([0, 255, 255, 0, 0, 255, 255, 0]);
    expect(cov(process(img, ink(0), "ink", at(1, 10, 10), grid(2, 2, 1)))).toEqual([0, 0, 0, 0]);
  });

  it("dilates by whole cells", () => {
    const img = image(5, 5, (x, y) => (x === 2 && y === 2 ? BLACK : WHITE));
    const expected = Array.from({ length: 25 }, (_, i) => (i % 5 >= 1 && i % 5 <= 3 && i / 5 >= 1 && i / 5 < 4 ? 255 : 0));
    expect(cov(process(img, ink(1), "ink", at(1), grid(5, 5, 1)))).toEqual(expected);
    expect(cov(process(img, ink(7), "ink", at(1), grid(5, 5, 1)))).toEqual(new Array(25).fill(255));
    expect(cov(process(img, ink(70), "ink", at(1), grid(5, 5, 1)))).toEqual(new Array(25).fill(255));
  });

  it("composites transparency for ink, alpha and cost", () => {
    const img = image(2, 1, (x) => (x === 0 ? [0, 0, 0, 128] : [0, 0, 0, 10]));
    expect(cov(process(img, ink(0, [255, 255, 255]), "ink", at(1), grid(2, 1, 1)))).toEqual([255, 0]);
    const a = image(3, 1, (x) => [0, 0, 0, [0, 26, 255][x]!]);
    expect(cov(process(a, { kind: "alpha", threshold: 0.1 }, "ink", at(1), grid(3, 1, 1)))).toEqual([0, 255, 255]);
    const g = image(3, 1, (x) => {
      const v = [0, 255, 128][x]!;
      return [v, v, v, 255];
    });
    expect(cov(process(g, { kind: "cost", invert: false }, "cost", at(1), grid(3, 1, 1)))).toEqual([255, 0, 127]);
    expect(cov(process(g, { kind: "cost", invert: true }, "cost", at(1), grid(3, 1, 1)))).toEqual([0, 255, 128]);
  });

  it("orders classmap classes and appends ink", () => {
    const colors = [[255, 0, 0], [0, 0, 255], [0, 200, 0], [120, 0, 120], [255, 255, 255]];
    const img = image(5, 1, (x) => [...colors[x]!, 255]);
    const mode = (unmatchedInk: boolean): Mode => ({
      kind: "classmap",
      palette: [
        [[0, 0, 255], "water"],
        [[255, 0, 0], "roads"],
        [[0, 200, 0], "ignore"],
        [[1, 0, 254], "water"],
        [[0, 0, 0], "text"],
      ],
      tolerance: 0.08,
      unmatchedInk,
      background: [255, 255, 255],
      inkThreshold: 0.12,
    });
    const out = process(img, mode(true), "unused", at(1), grid(5, 1, 1));
    expect(out.map((c) => c.class)).toEqual(["water", "roads", "ink"]);
    expect(Array.from(out[0]!.coverage)).toEqual([0, 255, 0, 0, 0]);
    expect(Array.from(out[2]!.coverage)).toEqual([0, 0, 0, 255, 0]);
    expect(process(img, mode(false), "unused", at(1), grid(5, 1, 1)).map((c) => c.class)).toEqual(["water", "roads"]);
  });

  it("computes saliency", () => {
    const flat = image(6, 6, () => [90, 90, 90, 255]);
    expect(cov(process(flat, { kind: "saliency" }, "s", at(1), grid(3, 3, 2)))).toEqual(new Array(9).fill(0));
    const edge = image(6, 6, (x) => (x < 3 ? BLACK : WHITE));
    const c = cov(process(edge, { kind: "saliency" }, "s", at(1), grid(3, 3, 2)));
    for (let r = 0; r < 3; r++) expect(c[r * 3 + 1]!).toBeGreaterThan(Math.max(c[r * 3]!, c[r * 3 + 2]!));
  });

  it("returns zero coverage for invalid input instead of throwing", () => {
    const img = image(2, 2, () => BLACK);
    for (const place of [at(0), at(-1), at(Number.NaN), at(Infinity), at(1, Number.NaN)]) {
      expect(cov(process(img, ink(1), "ink", place, grid(2, 2, 1)))).toEqual([0, 0, 0, 0]);
    }
    for (const g of [grid(2, 2, 0), grid(2, 2, Number.NaN), { ...grid(2, 2, 1), originX: Infinity }]) {
      expect(cov(process(img, ink(1), "ink", at(1), g))).toEqual([0, 0, 0, 0]);
    }
    const broken: Rgba = { width: 2, height: 2, data: new Uint8Array(7) };
    expect(isValidRgba(broken)).toBe(false);
    expect(cov(process(broken, ink(1), "ink", at(1), grid(2, 2, 1)))).toEqual([0, 0, 0, 0]);
    expect(process(img, ink(1), "ink", at(1), grid(0, 5, 1))[0]!.coverage.length).toBe(0);
    expect(cov(process(img, ink(1), "ink", at(1), { ...grid(2, 2, 1), cols: 1.5 }))).toEqual([]);
  });

  it("gives identical results for aligned, unaligned and clamped pixel arrays", () => {
    const base = image(37, 23, (x, y) => [(x * 37) & 255, (y * 91) & 255, (x * y) & 255, (x + y) % 3 ? 255 : 100]);
    const unalignedBuf = new Uint8Array(base.data.length + 1);
    unalignedBuf.set(base.data, 1);
    const variants: Rgba[] = [
      base,
      rgbaFromBytes(37, 23, unalignedBuf.subarray(1)),
      rgbaFromBytes(37, 23, new Uint8ClampedArray(base.data)),
      rgbaFromBytes(37, 23, base.data.slice().buffer),
    ];
    const modes: Mode[] = [
      ink(1),
      { kind: "alpha", threshold: 0.5 },
      { kind: "cost", invert: false },
      { kind: "saliency" },
      { kind: "classmap", palette: [[[255, 0, 0], "r"]], tolerance: 0.5, unmatchedInk: true, background: null, inkThreshold: 0.12 },
    ];
    for (const mode of modes) {
      const want = process(base, mode, "k", at(1.5, 0.25, -0.5), grid(30, 20, 2));
      for (const v of variants) expect(process(v, mode, "k", at(1.5, 0.25, -0.5), grid(30, 20, 2))).toEqual(want);
    }
  });
});

describe("raw RGBA", () => {
  it("wraps typed arrays without copying and validates sizes", () => {
    const data = new Uint8Array(8);
    expect(rgbaFromBytes(2, 1, data).data).toBe(data);
    expect(Array.from(rgbaFromBase64(1, 1, "AQIDBA").data)).toEqual([1, 2, 3, 4]);
    for (const [w, h, n] of [
      [0, 1, 0],
      [2, 1, 4],
      [1.5, 2, 12],
      [-1, 1, 4],
    ] as const) {
      expect(() => rgbaFromBytes(w, h, new Uint8Array(n))).toThrow(expect.objectContaining({ code: "invalid_dimensions" }));
    }
    expect(() => rgbaFromBase64(2, 1, "AQIDBA")).toThrow(RasterError);
  });
});
