// Decoding entry points: PNG synchronously (pure TypeScript, identical to Rust), JPEG
// and WebP asynchronously through the platform decoder where available.

import { sourceBytes } from "./base64.js";
import { RasterError } from "./errors.js";
import { decodePng, isPng } from "./png.js";
import type { Rgba } from "./rgba.js";

/** Image formats recognized by their file signature. */
export type ImageFormat = "png" | "jpeg" | "webp";

const MIME: Readonly<Record<ImageFormat, string>> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function asBytes(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
}

/** Recognizes PNG, JPEG and WebP by their signature (`null` otherwise). */
export function sniffFormat(bytes: Uint8Array | ArrayBuffer): ImageFormat | null {
  const b = asBytes(bytes);
  if (isPng(b)) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 // WEBP
  ) {
    return "webp";
  }
  return null;
}

function unknownFormat(): RasterError {
  return new RasterError("unsupported_format", "not a PNG, JPEG or WebP image");
}

/**
 * Decodes a PNG file to RGBA8 (straight alpha), bit-identical to the Rust crate.
 *
 * Synchronous decoding supports PNG only: JPEG and WebP throw a {@link RasterError} with
 * code `unsupported` (use {@link decodeAsync}); unknown signatures throw
 * `unsupported_format`, broken files `corrupt_image`, oversized ones `limit_exceeded`.
 */
export function decode(bytes: Uint8Array | ArrayBuffer): Rgba {
  const b = asBytes(bytes);
  const format = sniffFormat(b);
  if (format === null) throw unknownFormat();
  if (format !== "png") {
    throw new RasterError(
      "unsupported",
      `synchronous decoding supports PNG only; use decodeAsync() for ${MIME[format]}`,
    );
  }
  return decodePng(b);
}

interface BitmapLike {
  readonly width: number;
  readonly height: number;
  close?(): void;
}

interface Context2DLike {
  drawImage(image: BitmapLike, dx: number, dy: number): void;
  getImageData(sx: number, sy: number, sw: number, sh: number): { data: Uint8ClampedArray };
}

interface PlatformDecoders {
  createImageBitmap?: (image: Blob, options?: Record<string, string>) => Promise<BitmapLike>;
  OffscreenCanvas?: new (width: number, height: number) => {
    getContext(kind: "2d", options?: Record<string, boolean>): Context2DLike | null;
  };
  Blob?: typeof Blob;
}

/**
 * Decodes a PNG, JPEG or WebP file. PNG uses the deterministic built-in decoder (same
 * result as {@link decode}); JPEG and WebP use `createImageBitmap` and `OffscreenCanvas`
 * (browsers, Deno, workers) with colour-space conversion and premultiplication
 * disabled, and throw `unsupported` where those APIs are missing (e.g. Node.js).
 *
 * Platform-decoded pixels can differ slightly from the Rust decoder (JPEG IDCT and
 * chroma upsampling differ between decoders, and canvases store premultiplied alpha).
 */
export async function decodeAsync(bytes: Uint8Array | ArrayBuffer): Promise<Rgba> {
  const b = asBytes(bytes);
  const format = sniffFormat(b);
  if (format === null) throw unknownFormat();
  if (format === "png") return decodePng(b);
  const g = globalThis as unknown as PlatformDecoders;
  if (typeof g.createImageBitmap !== "function" || typeof g.OffscreenCanvas !== "function" || typeof g.Blob !== "function") {
    throw new RasterError(
      "unsupported",
      `no platform decoder for ${MIME[format]} (needs createImageBitmap and OffscreenCanvas)`,
    );
  }
  let bitmap: BitmapLike;
  try {
    bitmap = await g.createImageBitmap(new g.Blob([b.slice()], { type: MIME[format] }), {
      premultiplyAlpha: "none",
      colorSpaceConversion: "none",
    });
  } catch (e) {
    throw new RasterError("corrupt_image", `cannot decode ${MIME[format]}: ${String(e)}`);
  }
  try {
    const { width, height } = bitmap;
    const ctx = new g.OffscreenCanvas(width, height).getContext("2d", { willReadFrequently: true });
    if (ctx === null) throw new RasterError("unsupported", "OffscreenCanvas has no 2d context");
    ctx.drawImage(bitmap, 0, 0);
    const data = ctx.getImageData(0, 0, width, height).data;
    return { width, height, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    bitmap.close?.();
  }
}

/**
 * Decodes a raster `source` string: a `data:` URL (base64 or percent-encoded) or bare
 * base64 of a PNG file (synchronous; see {@link decode}). File paths are resolved by the
 * callers.
 */
export function decodeSource(src: string): Rgba {
  return decode(sourceBytes(src));
}

/** Like {@link decodeSource}, accepting JPEG and WebP through {@link decodeAsync}. */
export async function decodeSourceAsync(src: string): Promise<Rgba> {
  return decodeAsync(sourceBytes(src));
}
