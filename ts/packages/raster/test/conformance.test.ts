// Runs every case of conformance/raster (format: conformance/raster/README.md). The
// expected coverage arrays come from the Rust implementation and must match byte for byte.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  backdropLuma,
  decode,
  decodeBase64,
  decodeSource,
  estimateBackground,
  parseHexColor,
  process,
  RasterError,
  rgbaFromBase64,
  srgbToOklab,
  type GridSpec,
  type Mode,
  type RasterPlacement,
  type Rgb,
  type Rgba,
} from "../src/index.js";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/raster");

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

/**
 * Compares a grid of bytes (`cols` per row) with an expectation: the complete array (base64
 * under `key`) if present, the checksum, sum and non-zero count, and `samples`.
 */
function compare(got: Uint8Array, cols: number, e: Json, key: string, what: string): void {
  if (e[key] !== undefined) {
    const want = new Uint8Array(Buffer.from(e[key], "base64"));
    expect(got.length, `${what}: length`).toBe(want.length);
    const first = got.findIndex((v, k) => v !== want[k]);
    expect(first, `${what}: first differing cell`).toBe(-1);
  }
  let sum = 0;
  let nonzero = 0;
  for (const v of got) {
    sum += v;
    if (v > 0) nonzero++;
  }
  expect([fnv1a32(got), sum, nonzero], what).toEqual([e.fnv1a32, e.sum, e.nonzero]);
  for (const [x, y, v] of e.samples ?? []) expect(got[y * cols + x], `${what}: cell ${x},${y}`).toBe(v);
}

export function fnv1a32(bytes: Uint8Array | Uint8ClampedArray): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

function color(v: Json): Rgb | null {
  if (v === null || v === undefined) return null;
  const c = parseHexColor(v);
  if (c === null) throw new Error(`bad colour ${v}`);
  return c;
}

export function parseMode(v: Json): Mode {
  switch (v.kind) {
    case "ink":
      return { kind: "ink", background: color(v.background), threshold: v.threshold, dilate: v.dilate };
    case "alpha":
      return { kind: "alpha", threshold: v.threshold };
    case "cost":
      return { kind: "cost", invert: v.invert };
    case "saliency":
      return { kind: "saliency" };
    case "classmap":
      return {
        kind: "classmap",
        palette: v.palette.map(([hex, cls]: [string, string]) => [color(hex)!, cls] as const),
        tolerance: v.tolerance,
        unmatchedInk: v.unmatched_ink,
        background: color(v.background),
        inkThreshold: v.ink_threshold,
      };
    default:
      throw new Error(`unknown mode ${v.kind}`);
  }
}

export function parseGrid(v: Json): GridSpec {
  return { originX: v.origin[0], originY: v.origin[1], cell: v.cell, cols: v.cols, rows: v.rows };
}

export function parsePlacement(v: Json): RasterPlacement {
  return { scale: v.scale, offset: [v.offset[0], v.offset[1]] };
}

function loadImage(v: Json): Rgba {
  if (v.file !== undefined) return decode(new Uint8Array(readFileSync(join(DIR, v.file))));
  if (v.base64 !== undefined) return decodeSource(v.base64);
  if (v.source !== undefined) return decodeSource(v.source);
  if (v.rgba !== undefined) return rgbaFromBase64(v.rgba.width, v.rgba.height, v.rgba.data);
  throw new Error("image: expected file, base64, source or rgba");
}

function bitsOf(x: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  let s = "";
  for (let i = 0; i < 8; i++) s += view.getUint8(i).toString(16).padStart(2, "0");
  return s;
}

const files = readdirSync(DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("conformance/raster", () => {
  it("has the cases", () => {
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  for (const file of files) {
    const c: Json = JSON.parse(readFileSync(join(DIR, file), "utf8"));
    it(`${file}: ${c.name}`, () => {
      expect(c.kind).toBe("raster");
      if (c.image !== undefined) {
        let img: Rgba | null = null;
        let error: unknown = null;
        try {
          img = loadImage(c.image);
        } catch (e) {
          error = e;
        }
        if (c.decode.error !== undefined) {
          expect(error, "expected a decode error").toBeInstanceOf(RasterError);
          expect((error as RasterError).code).toBe(c.decode.error);
          return;
        }
        if (error !== null) throw error;
        expect([img!.width, img!.height, fnv1a32(img!.data)]).toEqual([c.decode.width, c.decode.height, c.decode.rgba_fnv1a32]);
        if (c.background !== undefined) expect(estimateBackground(img!)).toEqual(c.background);
        for (const r of c.runs ?? []) {
          const grid = parseGrid(r.grid);
          const got = process(img!, parseMode(r.mode), r.class ?? "ink", parsePlacement(r.placement), grid);
          expect(got.map((g) => g.class), r.name).toEqual(r.expect.map((e: Json) => e.class));
          got.forEach((g, i) => compare(g.coverage, grid.cols, r.expect[i], "coverage", `${r.name} (${g.class})`));
        }
        for (const r of c.backdrop ?? []) {
          const grid = parseGrid(r.grid);
          const layers = r.layers.map((l: Json) => [img!, parsePlacement(l)] as const);
          const got = backdropLuma(layers, r.background, grid);
          compare(got, grid.cols, r.expect, "luma", `backdrop ${r.name}`);
        }
      }
      for (const e of c.oklab ?? []) {
        expect(srgbToOklab(e.rgb).map(bitsOf), `oklab ${e.rgb}`).toEqual(e.lab_bits);
        expect(srgbToOklab(e.rgb)).toEqual(e.lab);
      }
      for (const e of c.hex ?? []) expect(parseHexColor(e.input), `hex ${JSON.stringify(e.input)}`).toEqual(e.rgb);
      for (const e of c.base64 ?? []) {
        if (e.error !== undefined) {
          expect(() => decodeBase64(e.input), JSON.stringify(e.input)).toThrow(RasterError);
          try {
            decodeBase64(e.input);
          } catch (err) {
            expect((err as RasterError).code).toBe(e.error);
          }
        } else {
          expect(Buffer.from(decodeBase64(e.input)).toString("hex"), JSON.stringify(e.input)).toBe(e.hex);
        }
      }
    });
  }
});
