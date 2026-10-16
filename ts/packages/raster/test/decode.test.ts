import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { decode, decodeAsync, decodeSource, decodeSourceAsync, RasterError, sniffFormat } from "../src/index.js";

const IMAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/raster/images");
const png = new Uint8Array(readFileSync(join(IMAGES, "interlaced-3x2.png")));
const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8L")]);

const codeOf = async (f: () => unknown): Promise<string> => {
  try {
    await f();
    return "ok";
  } catch (e) {
    return e instanceof RasterError ? e.code : `not a RasterError: ${String(e)}`;
  }
};

describe("sniffFormat", () => {
  it("recognizes signatures", () => {
    expect(sniffFormat(png)).toBe("png");
    expect(sniffFormat(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength))).toBe("png");
    expect(sniffFormat(jpeg)).toBe("jpeg");
    expect(sniffFormat(webp)).toBe("webp");
    expect(sniffFormat(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(sniffFormat(new Uint8Array(0))).toBeNull();
  });
});

describe("decode", () => {
  it("decodes PNG synchronously; JPEG/WebP are unsupported synchronously", async () => {
    expect(decode(png).width).toBe(3);
    expect(await codeOf(() => decode(jpeg))).toBe("unsupported");
    expect(await codeOf(() => decode(webp))).toBe("unsupported");
    expect(await codeOf(() => decode(new Uint8Array([1, 2, 3])))).toBe("unsupported_format");
  });

  it("decodes data URLs and bare base64", () => {
    const b64 = Buffer.from(png).toString("base64");
    expect(decodeSource(`data:image/png;base64,${b64}`)).toEqual(decode(png));
    expect(decodeSource(b64)).toEqual(decode(png));
  });
});

describe("decodeAsync", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { createImageBitmap: g.createImageBitmap, OffscreenCanvas: g.OffscreenCanvas };
  afterEach(() => {
    g.createImageBitmap = saved.createImageBitmap;
    g.OffscreenCanvas = saved.OffscreenCanvas;
  });

  it("uses the built-in decoder for PNG", async () => {
    expect(await decodeAsync(png)).toEqual(decode(png));
    const b64 = Buffer.from(png).toString("base64");
    expect(await decodeSourceAsync(b64)).toEqual(decode(png));
  });

  it("reports unsupported without platform decoders (Node.js)", async () => {
    g.createImageBitmap = undefined;
    g.OffscreenCanvas = undefined;
    expect(await codeOf(() => decodeAsync(jpeg))).toBe("unsupported");
    expect(await codeOf(() => decodeAsync(new Uint8Array([9])))).toBe("unsupported_format");
  });

  it("uses createImageBitmap + OffscreenCanvas when present", async () => {
    const calls: Record<string, unknown>[] = [];
    g.createImageBitmap = async (blob: Blob, options: Record<string, unknown>) => {
      calls.push({ type: blob.type, size: blob.size, ...options });
      return { width: 2, height: 1, close: () => calls.push({ closed: true }) };
    };
    g.OffscreenCanvas = class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return {
          drawImage: () => undefined,
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            data: new Uint8ClampedArray(w * h * 4).map((_, i) => i),
          }),
        };
      }
    };
    const img = await decodeAsync(jpeg);
    expect([img.width, img.height, Array.from(img.data)]).toEqual([2, 1, [0, 1, 2, 3, 4, 5, 6, 7]]);
    expect(calls[0]).toEqual({ type: "image/jpeg", size: jpeg.length, premultiplyAlpha: "none", colorSpaceConversion: "none" });
    expect(calls[1]).toEqual({ closed: true });
    g.createImageBitmap = async () => {
      throw new Error("broken");
    };
    expect(await codeOf(() => decodeAsync(webp))).toBe("corrupt_image");
  });
});
