// PNG decoder (pure TypeScript) producing exactly the RGBA8 of the Rust crate, which
// decodes through `image` 0.25 / `png` 0.18 with the EXPAND transformation:
//
// * colour types 0, 2, 3, 4, 6; bit depths 1, 2, 4, 8, 16; Adam7 interlacing; all filters;
// * grey < 8 bit is scaled by 255 / (2^bits − 1); 16-bit samples become (v + 128) div 257;
// * palette entries beyond PLTE are opaque black; a palette tRNS longer than the palette is
//   ignored; a grey/RGB tRNS colour (low bytes below 16 bit) becomes alpha 0;
// * chunk rules: IHDR first; CRC checked for every chunk read (a bad CRC is fatal for
//   critical chunks, ancillary chunks with a bad CRC are skipped); unknown critical chunks
//   before the image data, duplicate IHDR/PLTE, a PLTE length outside 3..768 or not a
//   multiple of 3, and IEND before IDAT are errors; ancillary chunks other than tRNS are
//   ignored (malformed tRNS chunks too); decoding stops after the first IDAT sequence,
//   which must be followed by a complete chunk header (length + type);
// * zlib: header checked, Adler-32 not checked, data beyond the image is ignored;
// * decoded samples are limited to 512 MiB (`limit_exceeded`), checked at the first IDAT.
//
// Gamma, colour profiles and APNG control chunks are ignored (the default image is decoded).

import { RasterError } from "./errors.js";
import { inflateZlib } from "./inflate.js";
import type { Rgba } from "./rgba.js";

/** Limit on decoded samples (the default `max_alloc` of the Rust `image` crate). */
export const MAX_DECODED_BYTES = 512 * 1024 * 1024;

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const ADAM7: ReadonlyArray<readonly [number, number, number, number]> = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
];
const NOT_INTERLACED: ReadonlyArray<readonly [number, number, number, number]> = [[0, 0, 1, 1]];

const IHDR = 0x49484452;
const PLTE = 0x504c5445;
const IDAT = 0x49444154;
const IEND = 0x49454e44;
const TRNS = 0x74524e53;

const CRC_TABLE: Int32Array = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
}

function corrupt(message: string): never {
  throw new RasterError("corrupt_image", `PNG: ${message}`);
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** `true` if `bytes` starts with the PNG signature. */
export function isPng(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  for (let i = 0; i < 8; i++) if (bytes[i] !== PNG_SIGNATURE[i]) return false;
  return true;
}

interface Header {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlaced: boolean;
}

function parseHeader(b: Uint8Array, p: number): Header {
  const width = u32(b, p);
  const height = u32(b, p + 4);
  const bitDepth = b[p + 8]!;
  const colorType = b[p + 9]!;
  if (width === 0 || height === 0) corrupt("zero width or height");
  if (![1, 2, 4, 8, 16].includes(bitDepth)) corrupt(`invalid bit depth ${bitDepth}`);
  const ok =
    colorType === 0 ||
    (colorType === 3 && bitDepth <= 8) ||
    ((colorType === 2 || colorType === 4 || colorType === 6) && bitDepth >= 8);
  if (!(colorType in CHANNELS)) corrupt(`invalid colour type ${colorType}`);
  if (!ok) corrupt(`invalid bit depth ${bitDepth} for colour type ${colorType}`);
  if (b[p + 10] !== 0) corrupt("unknown compression method");
  if (b[p + 11] !== 0) corrupt("unknown filter method");
  const interlace = b[p + 12]!;
  if (interlace > 1) corrupt("unknown interlace method");
  return { width, height, bitDepth, colorType, interlaced: interlace === 1 };
}

/** Bytes per pixel of the `png` crate's EXPAND output (used for the memory limit). */
function outputBytesPerPixel(h: Header, hasTrns: boolean): number {
  const wide = h.bitDepth === 16 ? 2 : 1;
  switch (h.colorType) {
    case 3:
      return hasTrns ? 4 : 3;
    case 0:
      return (hasTrns ? 2 : 1) * wide;
    case 2:
      return (hasTrns ? 4 : 3) * wide;
    case 4:
      return 2 * wide;
    default:
      return 4 * wide;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Reverses the filter of the row at `raw[start..start+n]` in place (`prior < 0`: none). */
function unfilter(raw: Uint8Array, ftype: number, start: number, n: number, prior: number, bpp: number): void {
  const end = start + n;
  switch (ftype) {
    case 0:
      return;
    case 1:
      for (let i = start + bpp; i < end; i++) raw[i] = raw[i]! + raw[i - bpp]!;
      return;
    case 2:
      if (prior >= 0) for (let i = start, j = prior; i < end; i++, j++) raw[i] = raw[i]! + raw[j]!;
      return;
    case 3:
      if (prior >= 0) {
        for (let i = start, j = prior; i < end; i++, j++) {
          const left = i - start >= bpp ? raw[i - bpp]! : 0;
          raw[i] = raw[i]! + ((left + raw[j]!) >> 1);
        }
      } else {
        for (let i = start + bpp; i < end; i++) raw[i] = raw[i]! + (raw[i - bpp]! >> 1);
      }
      return;
    case 4:
      if (prior >= 0) {
        for (let i = start, j = prior; i < end; i++, j++) {
          const k = i - start >= bpp;
          raw[i] = raw[i]! + paeth(k ? raw[i - bpp]! : 0, raw[j]!, k ? raw[j - bpp]! : 0);
        }
      } else {
        for (let i = start + bpp; i < end; i++) raw[i] = raw[i]! + raw[i - bpp]!;
      }
      return;
    default:
      corrupt(`unknown filter type ${ftype}`);
  }
}

/** Per-image conversion state from unfiltered rows to RGBA8. */
interface Converter {
  header: Header;
  /** 256 × RGBA for palette images. */
  palette: Uint8Array | null;
  /** Transparent grey sample (native depth, low byte below 16 bit), or −1. */
  trnsGray: number;
  /** Transparent RGB key, or null. */
  trnsRgb: [number, number, number] | null;
}

function makeConverter(h: Header, plte: Uint8Array | null, trns: Uint8Array | null): Converter {
  let palette: Uint8Array | null = null;
  let trnsGray = -1;
  let trnsRgb: [number, number, number] | null = null;
  if (h.colorType === 3) {
    if (plte === null) corrupt("missing palette of an indexed image");
    const n = Math.floor(plte.length / 3);
    palette = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) palette[i * 4 + 3] = 255;
    for (let i = 0; i < n; i++) {
      palette[i * 4] = plte[i * 3]!;
      palette[i * 4 + 1] = plte[i * 3 + 1]!;
      palette[i * 4 + 2] = plte[i * 3 + 2]!;
    }
    if (trns !== null && trns.length <= n) for (let i = 0; i < trns.length; i++) palette[i * 4 + 3] = trns[i]!;
  } else if (h.colorType === 0 && trns !== null) {
    if (h.bitDepth < 16) trnsGray = trns[1]!;
    else if (trns.length === 2) trnsGray = (trns[0]! << 8) | trns[1]!;
  } else if (h.colorType === 2 && trns !== null) {
    if (h.bitDepth < 16) trnsRgb = [trns[1]!, trns[3]!, trns[5]!];
    else if (trns.length === 6) trnsRgb = [(trns[0]! << 8) | trns[1]!, (trns[2]! << 8) | trns[3]!, (trns[4]! << 8) | trns[5]!];
  }
  return { header: h, palette, trnsGray, trnsRgb };
}

/** Allocates a byte buffer; an allocation failure becomes `limit_exceeded`. */
function allocate(n: number): Uint8Array {
  try {
    return new Uint8Array(n);
  } catch {
    throw new RasterError("limit_exceeded", `PNG: cannot allocate ${n} bytes`);
  }
}

/** 16-bit sample to 8 bits: round(v / 257) = (v + 128) div 257. */
function to8(v: number): number {
  return ((v + 128) / 257) | 0;
}

/**
 * Converts `count` pixels of the unfiltered row at `raw[p..]` to RGBA8, writing pixel `i`
 * to `out` at `base + i * step` (byte offsets).
 */
function convertRow(cv: Converter, raw: Uint8Array, p: number, count: number, out: Uint8Array, base: number, step: number): void {
  const { bitDepth: bd, colorType: ct } = cv.header;
  let o = base;
  if (bd < 8) {
    const mask = (1 << bd) - 1;
    const ppb = 8 / bd;
    if (ct === 3) {
      const pal = cv.palette!;
      for (let i = 0; i < count; i++, o += step) {
        const v = (raw[p + ((i / ppb) | 0)]! >> (8 - bd - (i % ppb) * bd)) & mask;
        out[o] = pal[v * 4]!;
        out[o + 1] = pal[v * 4 + 1]!;
        out[o + 2] = pal[v * 4 + 2]!;
        out[o + 3] = pal[v * 4 + 3]!;
      }
    } else {
      const scale = (255 / mask) | 0;
      for (let i = 0; i < count; i++, o += step) {
        const v = (raw[p + ((i / ppb) | 0)]! >> (8 - bd - (i % ppb) * bd)) & mask;
        const g = v * scale;
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = v === cv.trnsGray ? 0 : 255;
      }
    }
    return;
  }
  if (bd === 8) {
    switch (ct) {
      case 0:
        for (let i = 0; i < count; i++, o += step) {
          const g = raw[p + i]!;
          out[o] = g;
          out[o + 1] = g;
          out[o + 2] = g;
          out[o + 3] = g === cv.trnsGray ? 0 : 255;
        }
        return;
      case 2: {
        const key = cv.trnsRgb;
        for (let i = 0, q = p; i < count; i++, o += step, q += 3) {
          const r = raw[q]!;
          const g = raw[q + 1]!;
          const b = raw[q + 2]!;
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = key !== null && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
        }
        return;
      }
      case 3: {
        const pal = cv.palette!;
        for (let i = 0; i < count; i++, o += step) {
          const v = raw[p + i]! * 4;
          out[o] = pal[v]!;
          out[o + 1] = pal[v + 1]!;
          out[o + 2] = pal[v + 2]!;
          out[o + 3] = pal[v + 3]!;
        }
        return;
      }
      case 4:
        for (let i = 0, q = p; i < count; i++, o += step, q += 2) {
          const g = raw[q]!;
          out[o] = g;
          out[o + 1] = g;
          out[o + 2] = g;
          out[o + 3] = raw[q + 1]!;
        }
        return;
      default:
        if (step === 4) {
          out.set(raw.subarray(p, p + count * 4), o);
        } else {
          for (let i = 0, q = p; i < count; i++, o += step, q += 4) {
            out[o] = raw[q]!;
            out[o + 1] = raw[q + 1]!;
            out[o + 2] = raw[q + 2]!;
            out[o + 3] = raw[q + 3]!;
          }
        }
        return;
    }
  }
  // 16 bit
  const s = (q: number): number => (raw[q]! << 8) | raw[q + 1]!;
  switch (ct) {
    case 0:
      for (let i = 0, q = p; i < count; i++, o += step, q += 2) {
        const v = s(q);
        const g = to8(v);
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = v === cv.trnsGray ? 0 : 255;
      }
      return;
    case 2: {
      const key = cv.trnsRgb;
      for (let i = 0, q = p; i < count; i++, o += step, q += 6) {
        const r = s(q);
        const g = s(q + 2);
        const b = s(q + 4);
        out[o] = to8(r);
        out[o + 1] = to8(g);
        out[o + 2] = to8(b);
        out[o + 3] = key !== null && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      }
      return;
    }
    case 4:
      for (let i = 0, q = p; i < count; i++, o += step, q += 4) {
        const g = to8(s(q));
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = to8(s(q + 2));
      }
      return;
    default:
      for (let i = 0, q = p; i < count; i++, o += step, q += 8) {
        out[o] = to8(s(q));
        out[o + 1] = to8(s(q + 2));
        out[o + 2] = to8(s(q + 4));
        out[o + 3] = to8(s(q + 6));
      }
  }
}

/**
 * Decodes a PNG file to RGBA8. Throws a {@link RasterError}: `corrupt_image` for invalid
 * or truncated files, `limit_exceeded` above {@link MAX_DECODED_BYTES} of samples.
 */
export function decodePng(bytes: Uint8Array): Rgba {
  if (!isPng(bytes)) corrupt("missing PNG signature");
  let pos = 8;
  let header: Header | null = null;
  let plte: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let idatBytes = 0;
  let inIdat = false;
  for (;;) {
    if (pos + 8 > bytes.length) {
      corrupt(inIdat ? "file ends after the image data (no further chunk header)" : "truncated file");
    }
    const length = u32(bytes, pos);
    const type = u32(bytes, pos + 4);
    if (inIdat && type !== IDAT) break;
    if (header === null && type !== IHDR) corrupt("first chunk is not IHDR");
    const critical = (bytes[pos + 4]! & 0x20) === 0;
    if (type === IHDR && length !== 13) corrupt("IHDR chunk has the wrong length");
    if (type === PLTE && (length < 3 || length > 768)) corrupt("PLTE chunk has the wrong length");
    if (type === IEND && length !== 0) corrupt("IEND chunk has the wrong length");
    if (critical && type !== IHDR && type !== PLTE && type !== IDAT && type !== IEND) {
      corrupt("unknown critical chunk");
    }
    if (type === IEND) corrupt("no image data");
    if (type === IDAT && !inIdat) {
      // Header complete: check the memory limit before reading image data.
      const h = header!;
      const samples = h.width * h.height * outputBytesPerPixel(h, trns !== null);
      if (samples > MAX_DECODED_BYTES) {
        throw new RasterError("limit_exceeded", `PNG: ${h.width}x${h.height} image exceeds the decoding limit`);
      }
      inIdat = true;
    }
    const start = pos + 8;
    const end = start + length;
    if (end + 4 > bytes.length) corrupt("truncated chunk");
    const crcOk = crc32(bytes, pos + 4, end) === u32(bytes, end);
    pos = end + 4;
    if (!crcOk) {
      if (critical) corrupt("CRC mismatch");
      continue;
    }
    switch (type) {
      case IHDR:
        if (header !== null) corrupt("duplicate IHDR chunk");
        header = parseHeader(bytes, start);
        break;
      case PLTE:
        if (plte !== null) corrupt("duplicate PLTE chunk");
        if (length % 3 !== 0) corrupt(`PLTE chunk length ${length} is not a multiple of 3`);
        plte = bytes.subarray(start, end);
        break;
      case IDAT:
        idat.push(bytes.subarray(start, end));
        idatBytes += length;
        break;
      case TRNS: {
        // Ancillary: malformed or misplaced chunks are ignored.
        if (trns !== null || length < 1 || length > 256) break;
        const ct = header!.colorType;
        if ((ct === 0 && length >= 2) || (ct === 2 && length >= 6) || (ct === 3 && plte !== null)) {
          trns = bytes.subarray(start, end);
        }
        break;
      }
      default:
        break;
    }
  }
  const h = header!;
  const cv = makeConverter(h, plte, trns);
  const bitsPerPixel = CHANNELS[h.colorType]! * h.bitDepth;
  const bpp = Math.max(1, bitsPerPixel >> 3);
  const passes = h.interlaced ? ADAM7 : NOT_INTERLACED;
  let total = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = h.width > x0 ? Math.ceil((h.width - x0) / dx) : 0;
    const ph = h.height > y0 ? Math.ceil((h.height - y0) / dy) : 0;
    if (pw > 0 && ph > 0) total += ph * (1 + Math.ceil((pw * bitsPerPixel) / 8));
  }
  let zdata: Uint8Array;
  if (idat.length === 1) {
    zdata = idat[0]!;
  } else {
    zdata = new Uint8Array(idatBytes);
    let o = 0;
    for (const part of idat) {
      zdata.set(part, o);
      o += part.length;
    }
  }
  const raw = allocate(total);
  inflateZlib(zdata, raw);
  const out = allocate(h.width * h.height * 4);
  let rp = 0;
  for (const [x0, y0, dx, dy] of passes) {
    const pw = h.width > x0 ? Math.ceil((h.width - x0) / dx) : 0;
    const ph = h.height > y0 ? Math.ceil((h.height - y0) / dy) : 0;
    if (pw === 0 || ph === 0) continue;
    const rowBytes = Math.ceil((pw * bitsPerPixel) / 8);
    let prior = -1;
    for (let j = 0; j < ph; j++) {
      const ftype = raw[rp]!;
      const start = rp + 1;
      unfilter(raw, ftype, start, rowBytes, prior, bpp);
      const y = y0 + j * dy;
      convertRow(cv, raw, start, pw, out, (y * h.width + x0) * 4, dx * 4);
      prior = start;
      rp = start + rowBytes;
    }
  }
  return { width: h.width, height: h.height, data: out };
}
