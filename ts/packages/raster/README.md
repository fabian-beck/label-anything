# @label-anything/raster

Raster backgrounds for the [Label Anything](https://github.com/fabian-beck/label-anything)
label placement engine, in pure TypeScript with zero dependencies: decode an image, turn
every pixel into an obstacle value with one of five modes and area-average the values
into per-class coverage grids (spec §4.6). The results are **bit-identical** to the Rust
crate `label-anything-raster` (checked by `conformance/raster`).

```ts
import { decode, process } from "@label-anything/raster";

const img = decode(pngBytes); // Uint8Array of a PNG file -> { width, height, data: RGBA8 }
const [ink] = process(
  img,
  { kind: "ink", background: null, threshold: 0.12, dilate: 1 }, // null = estimate
  "ink",
  { scale: 2, offset: [0, 0] }, // HiDPI: a 1600×1200 PNG covers an 800×600 canvas
  { originX: 0, originY: 0, cell: 2, cols: 400, rows: 300 },
);
ink.coverage; // Uint8Array(400 * 300), 0..255 = covered fraction of each cell
```

## API

```ts
interface Rgba { readonly width: number; readonly height: number; readonly data: Uint8Array | Uint8ClampedArray }
function decode(bytes: Uint8Array | ArrayBuffer): Rgba;                 // PNG (sync)
function decodeAsync(bytes: Uint8Array | ArrayBuffer): Promise<Rgba>;   // PNG, JPEG, WebP
function decodeSource(src: string): Rgba;                                // data: URL or bare base64 (PNG)
function decodeSourceAsync(src: string): Promise<Rgba>;
function rgbaFromBase64(width: number, height: number, b64: string): Rgba;
function rgbaFromBytes(width: number, height: number, data: Uint8Array | Uint8ClampedArray | ArrayBuffer): Rgba; // no copy
function isValidRgba(img: Rgba): boolean;
function sniffFormat(bytes: Uint8Array | ArrayBuffer): "png" | "jpeg" | "webp" | null;
function decodeBase64(text: string): Uint8Array;  // without Buffer/atob
function sourceBytes(src: string): Uint8Array;    // bytes of a data: URL or base64

interface GridSpec { originX: number; originY: number; cell: number; cols: number; rows: number }
interface RasterPlacement { scale: number; offset: readonly [number, number] }
type Mode =
  | { kind: "ink"; background?: Rgb | null; threshold: number; dilate: number }
  | { kind: "alpha"; threshold: number }
  | { kind: "cost"; invert: boolean }
  | { kind: "classmap"; palette: ReadonlyArray<readonly [Rgb, string]>; tolerance: number;
      unmatchedInk: boolean; background?: Rgb | null; inkThreshold: number }
  | { kind: "saliency" };
interface ClassCoverage { readonly class: string; readonly coverage: Uint8Array }
function process(img: Rgba, mode: Mode, className: string, place: RasterPlacement, grid: GridSpec): ClassCoverage[];

function estimateBackground(img: Rgba): Rgb;
function srgbToOklab(rgb: readonly [number, number, number]): Oklab;
function parseHexColor(s: string): Rgb | null;  // "#rgb" | "#rrggbb"
function oklabDistance(p: ArrayLike<number>, q: ArrayLike<number>): number;
function cbrt(x: number): number;               // the deterministic cube root of the spec
class RasterError extends Error { readonly code: RasterErrorCode }
const MAX_DECODED_BYTES: number;                // 512 MiB
```

`process` returns one entry for `ink`, `alpha`, `cost` and `saliency` (named
`className`) and, for `classmap`, one entry per class with coverage in palette order
(then `"ink"` for unmatched pixels). Invalid geometry or pixel data gives zero coverage;
it never throws. Mode defaults (`spec/defaults.md`): ink threshold 0.12, dilate 1, alpha
threshold 0.1, classmap tolerance 0.08.

Errors are `RasterError`s with a stable `code`, shared with Rust: `invalid_base64`,
`invalid_data_url`, `unsupported_format`, `corrupt_image`, `invalid_dimensions`,
`limit_exceeded`, `unsupported`.

## Decoding support and limitations

* **PNG** is decoded by the built-in decoder, synchronously and identically to the Rust
  crate: zlib/inflate (stored, fixed and dynamic Huffman blocks), all filter types,
  colour types 0/2/3/4/6, bit depths 1/2/4/8/16, palette + `tRNS`, Adam7. **CRCs are
  checked**: a bad CRC in a critical chunk is a `corrupt_image` error, ancillary chunks
  with a bad CRC are skipped; the Adler-32 checksum is not checked (like the Rust `png`
  crate). Gamma, colour profiles (`gAMA`, `iCCP`, `sRGB`, `cHRM`) and APNG frames are
  ignored; 16-bit samples become `(v + 128) div 257`. Images with more than 512 MiB of
  decoded samples are rejected (`limit_exceeded`).
* **JPEG and WebP are not decoded synchronously**: `decode()` throws `unsupported`.
  `decodeAsync()` decodes them with the platform decoder — `createImageBitmap` +
  `OffscreenCanvas` (browsers, web workers, Deno) with `premultiplyAlpha: "none"` and
  `colorSpaceConversion: "none"` — and throws `unsupported` where these APIs are missing,
  e.g. in **Node.js**. There, decode with a library of your choice and pass the pixels
  to `rgbaFromBytes`. Platform-decoded pixels can differ slightly from the Rust decoder
  (JPEG IDCT/upsampling differ between decoders; canvases store premultiplied alpha), so
  coverage from JPEG/WebP is not guaranteed to be bit-identical across implementations.
* Raw RGBA (`rgbaFromBase64`, `rgbaFromBytes`) is always exact; `rgbaFromBytes` wraps the
  typed array without copying.

## Performance

`process` is O(pixels + cells): per-colour results are memoized, the area averaging is
separable and streams raster rows through a small ring of grid rows, and dilation is
O(cells). On a 2048×2048 raster with 2 px cells (Node 22, one core of a 2.1 GHz Xeon),
`ink` takes about 30 ms on line art and about 120 ms on photographic content with
~860 000 distinct colours (dominated by exact OKLab evaluations). Run
`node packages/raster/bench/bench.mjs` (after building) to measure; it prints the same
coverage checksums as `cargo run --release -p label-anything-raster --example bench`.
