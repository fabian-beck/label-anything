/**
 * `@label-anything/raster` — raster backgrounds for the Label Anything label placement
 * engine (spec §4.6), in pure TypeScript with zero dependencies.
 *
 * Decode a PNG (or take raw RGBA; JPEG/WebP via {@link decodeAsync} where the platform
 * provides a decoder), turn every pixel into a value in [0, 1] with one of five modes
 * (`ink`, `alpha`, `cost`, `classmap`, `saliency`) and area-average the values into
 * per-class `Uint8Array` coverage grids. The arithmetic is specified to the bit, so the
 * coverage is identical to the Rust crate `label-anything-raster` (checked by
 * `conformance/raster`).
 *
 * @packageDocumentation
 */
export { decodeBase64, sourceBytes } from "./base64.js";
export { cbrt, estimateBackground, oklabDistance, parseHexColor, srgbToOklab, type Oklab, type Rgb } from "./color.js";
export { decode, decodeAsync, decodeSource, decodeSourceAsync, sniffFormat, type ImageFormat } from "./decode.js";
export { RasterError, type RasterErrorCode } from "./errors.js";
export type { GridSpec, RasterPlacement } from "./grid.js";
export { MAX_DECODED_BYTES } from "./png.js";
export { process, type ClassCoverage, type Mode } from "./process.js";
export { isValidRgba, rgbaFromBase64, rgbaFromBytes, type Rgba } from "./rgba.js";
