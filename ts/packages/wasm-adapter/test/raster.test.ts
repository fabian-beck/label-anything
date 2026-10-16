// Raster backgrounds supplied as pixels (`options.raster`), copied once into WASM memory.
import { beforeAll, describe, expect, it } from "vitest";
import type { PlaceOptions, RgbaPixels } from "@label-anything/core";
import { built, type AnyProblem } from "./helpers.js";

type Wasm = typeof import("../src/node.js");
let la: Wasm;

const W = 80;
const H = 60;

/** White image with a black block left of and above the anchor at (40, 30). */
function blob(): Uint8ClampedArray {
  const px = new Uint8ClampedArray(W * H * 4).fill(255);
  for (let y = 10; y < 30; y++) {
    for (let x = 10; x < 40; x++) px.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3);
  }
  return px;
}

function problem(raster?: Record<string, unknown>): AnyProblem {
  return {
    canvas: { width: W, height: H },
    items: [{ id: "r", anchor: { type: "point", x: 40, y: 30 }, label: { type: "text", text: "Blob" } }],
    ...(raster ? { obstacles: { raster } } : {}),
    avoid: { label: { ink: "hard" } },
  } as AnyProblem;
}

const base64 = (px: Uint8Array | Uint8ClampedArray) => Buffer.from(px.buffer, px.byteOffset, px.byteLength).toString("base64");

describe.skipIf(!built)("raster pixels", () => {
  beforeAll(async () => {
    la = await import("../src/node.js");
  });

  it("give the same result as the same pixels in the problem (rgba base64)", () => {
    const px = blob();
    const inline = la.place(problem({ rgba: { width: W, height: H, data: base64(px) }, mode: "ink" }));
    const box = inline.placements[0].box;
    expect(inline.stats.hard_violations).toBe(0);
    expect(box && (box.x >= 40 || box.y >= 30)).toBe(true); // the label avoids the block
    expect(la.place(problem()).placements[0].box).not.toEqual(box); // without the raster it sits top left

    // the pixels replace the image of the first raster source (its options still apply)
    const replaced = la.place(problem({ source: "host", mode: "ink" }), { raster: { width: W, height: H, data: px } });
    expect(replaced.placements).toEqual(inline.placements);
    // without a raster source, they add one with default options
    const added = la.place(problem(), { raster: { width: W, height: H, data: new Uint8Array(px.buffer) } });
    expect(added.placements).toEqual(inline.placements);
    expect(added.stats.grid.classes).toContain("ink");
  });

  it("accept views and ImageData-like objects", () => {
    const px = blob();
    const padded = new Uint8Array(px.length + 16);
    padded.set(px, 8);
    const view = padded.subarray(8, 8 + px.length);
    const imageData: RgbaPixels = { width: W, height: H, data: px };
    const a = la.place(problem(), { raster: imageData });
    const b = la.place(problem(), { raster: { width: W, height: H, data: view } });
    expect(b.placements).toEqual(a.placements);
  });

  it("are checked", () => {
    const p = problem();
    const opts = (raster: unknown) => ({ raster }) as unknown as PlaceOptions;
    expect(() => la.place(p, opts({ width: W, height: H, data: new Uint8Array(10) }))).toThrow(RangeError);
    expect(() => la.place(p, opts({ width: W, height: H, data: [1, 2, 3] }))).toThrow(TypeError);
    expect(() => la.place(p, opts({ width: 1.5, height: H, data: new Uint8Array(4) }))).toThrow(/positive integer/);
    expect(() => la.place(p, opts(7))).toThrow(TypeError);
  });
});
