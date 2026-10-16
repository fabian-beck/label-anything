import { decodeBase64 } from "./base64.js";
import { RasterError } from "./errors.js";

/**
 * A decoded raster: row-major RGBA8 with straight (non-premultiplied) alpha;
 * `data.length === width * height * 4`.
 */
export interface Rgba {
  /** Width in raster pixels. */
  readonly width: number;
  /** Height in raster pixels. */
  readonly height: number;
  /** `width * height` pixels of 4 bytes (R, G, B, A), row by row from the top. */
  readonly data: Uint8Array | Uint8ClampedArray;
}

/** Largest width or height (the Rust crate uses `u32`). */
const MAX_DIMENSION = 0xffffffff;

function isDimension(n: number): boolean {
  return Number.isInteger(n) && n >= 1 && n <= MAX_DIMENSION;
}

/** `true` if the dimensions are positive integers and match `data.length`. */
export function isValidRgba(img: Rgba): boolean {
  return (
    isDimension(img.width) &&
    isDimension(img.height) &&
    img.data != null &&
    img.data.length === img.width * img.height * 4
  );
}

/**
 * Wraps raw RGBA8 pixels without copying (typed-array fast path) after checking the
 * dimensions. An `ArrayBuffer` is viewed as a `Uint8Array`.
 * Throws a {@link RasterError} with code `invalid_dimensions`.
 */
export function rgbaFromBytes(
  width: number,
  height: number,
  data: Uint8Array | Uint8ClampedArray | ArrayBuffer,
): Rgba {
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  if (!isDimension(width) || !isDimension(height)) {
    throw new RasterError("invalid_dimensions", `invalid raster dimensions ${width}x${height}`);
  }
  const expected = width * height * 4;
  if (bytes.length !== expected) {
    throw new RasterError(
      "invalid_dimensions",
      `RGBA data of a ${width}x${height} raster must have ${expected} bytes, got ${bytes.length}`,
    );
  }
  return { width, height, data: bytes };
}

/**
 * Builds an {@link Rgba} from base64-encoded raw pixels (`rgba.data` of a raster source:
 * `width * height * 4` bytes, row-major RGBA8, straight alpha).
 */
export function rgbaFromBase64(width: number, height: number, b64: string): Rgba {
  return rgbaFromBytes(width, height, decodeBase64(b64));
}
