// zlib (RFC 1950) / DEFLATE (RFC 1951) decompression into a preallocated buffer, as
// needed by the PNG decoder. Stored, fixed-Huffman and dynamic-Huffman blocks; code
// validation follows zlib (over-subscribed or incomplete codes are errors, except a
// single code of length 1). The Adler-32 checksum is not verified (like the Rust `png`
// crate), and decompression stops as soon as the output is full.

import { RasterError } from "./errors.js";

const LEN_BASE = Uint16Array.from([
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258,
]);
const LEN_EXTRA = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_BASE = Uint16Array.from([
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145,
  8193, 12289, 16385, 24577,
]);
const DIST_EXTRA = Uint8Array.from([
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
]);
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** A single-level decoding table: `table[next `bits` input bits] = symbol | (length << 9)`; 0 = invalid. */
interface Huffman {
  readonly table: Uint16Array;
  readonly bits: number;
}

function fail(message: string): never {
  throw new RasterError("corrupt_image", `PNG image data: ${message}`);
}

/**
 * Builds a canonical Huffman decoding table. `allowSingle`: an incomplete code is
 * accepted when its longest length is 1 (zlib's rule for literal/length and distance
 * codes); an empty code (no lengths) gives a table that rejects every symbol.
 */
function buildHuffman(lengths: Uint8Array, allowSingle: boolean): Huffman {
  const count = new Uint16Array(16);
  let max = 0;
  for (let i = 0; i < lengths.length; i++) {
    const l = lengths[i]!;
    count[l]!++;
    if (l > max) max = l;
  }
  if (max === 0) return { table: new Uint16Array(1), bits: 0 };
  let left = 1;
  for (let len = 1; len <= 15; len++) {
    left = (left << 1) - count[len]!;
    if (left < 0) fail("over-subscribed Huffman code");
  }
  if (left > 0 && (!allowSingle || max !== 1)) fail("incomplete Huffman code");
  // Canonical codes (RFC 1951 §3.2.2): the first code of length len + 1 is
  // (first code of length len + number of codes of length len) << 1.
  const next = new Uint16Array(16);
  let code = 0;
  for (let len = 1; len <= 15; len++) {
    next[len] = code;
    code = (code + count[len]!) << 1;
  }
  const size = 1 << max;
  const table = new Uint16Array(size);
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym]!;
    if (len === 0) continue;
    let c = next[len]!++;
    let rev = 0;
    for (let k = 0; k < len; k++) {
      rev = (rev << 1) | (c & 1);
      c >>= 1;
    }
    const entry = sym | (len << 9);
    for (let i = rev; i < size; i += 1 << len) table[i] = entry;
  }
  return { table, bits: max };
}

let fixedTables: [Huffman, Huffman] | null = null;

function fixed(): [Huffman, Huffman] {
  if (fixedTables === null) {
    const lit = new Uint8Array(288);
    lit.fill(8, 0, 144);
    lit.fill(9, 144, 256);
    lit.fill(7, 256, 280);
    lit.fill(8, 280, 288);
    fixedTables = [buildHuffman(lit, true), buildHuffman(new Uint8Array(32).fill(5), true)];
  }
  return fixedTables;
}

/**
 * Decompresses the zlib stream `src` until `out` is full. Throws a {@link RasterError}
 * (`corrupt_image`) for a bad header, malformed data, or a stream that ends early.
 */
export function inflateZlib(src: Uint8Array, out: Uint8Array): void {
  const srcLen = src.length;
  if (srcLen < 2) fail("truncated zlib header");
  const cmf = src[0]!;
  const flg = src[1]!;
  if ((cmf & 0x0f) !== 8 || (cmf & 0xf0) > 0x70 || (flg & 0x20) !== 0 || ((cmf << 8) | flg) % 31 !== 0) {
    fail("bad zlib header");
  }
  const outLen = out.length;
  if (outLen === 0) return;
  let pos = 2;
  let bitbuf = 0;
  let bitcnt = 0;
  let op = 0;

  /** Ensures `n` (≤ 24) bits are buffered or throws. */
  const need = (n: number): void => {
    while (bitcnt < n) {
      if (pos >= srcLen) fail("compressed data ends early");
      bitbuf |= src[pos++]! << bitcnt;
      bitcnt += 8;
    }
  };

  for (;;) {
    need(3);
    const final = bitbuf & 1;
    const type = (bitbuf >>> 1) & 3;
    bitbuf >>>= 3;
    bitcnt -= 3;
    if (type === 0) {
      // Stored block: skip to the byte boundary and give whole prefetched bytes back.
      const drop = bitcnt & 7;
      bitbuf >>>= drop;
      bitcnt -= drop;
      pos -= bitcnt >>> 3;
      bitbuf = 0;
      bitcnt = 0;
      if (pos + 4 > srcLen) fail("compressed data ends early");
      const len = src[pos]! | (src[pos + 1]! << 8);
      const nlen = src[pos + 2]! | (src[pos + 3]! << 8);
      pos += 4;
      if ((len ^ 0xffff) !== nlen) fail("invalid stored block lengths");
      const n = Math.min(len, outLen - op);
      if (pos + n > srcLen) fail("compressed data ends early");
      out.set(src.subarray(pos, pos + n), op);
      op += n;
      pos += n;
      if (op === outLen) return;
    } else if (type === 1 || type === 2) {
      let lit: Huffman;
      let dist: Huffman;
      if (type === 1) {
        [lit, dist] = fixed();
      } else {
        need(14);
        const hlit = (bitbuf & 31) + 257;
        const hdist = ((bitbuf >>> 5) & 31) + 1;
        const hclen = ((bitbuf >>> 10) & 15) + 4;
        bitbuf >>>= 14;
        bitcnt -= 14;
        if (hlit > 286 || hdist > 30) fail("too many length or distance symbols");
        const clLens = new Uint8Array(19);
        for (let i = 0; i < hclen; i++) {
          need(3);
          clLens[CL_ORDER[i]!] = bitbuf & 7;
          bitbuf >>>= 3;
          bitcnt -= 3;
        }
        const cl = buildHuffman(clLens, false);
        const clMask = (1 << cl.bits) - 1;
        const total = hlit + hdist;
        const lens = new Uint8Array(total);
        let i = 0;
        while (i < total) {
          while (bitcnt < 7 && pos < srcLen) {
            bitbuf |= src[pos++]! << bitcnt;
            bitcnt += 8;
          }
          const e = cl.table[bitbuf & clMask]!;
          const l = e >>> 9;
          if (l === 0) fail("invalid code-length code");
          if (l > bitcnt) fail("compressed data ends early");
          bitbuf >>>= l;
          bitcnt -= l;
          const sym = e & 511;
          if (sym < 16) {
            lens[i++] = sym;
            continue;
          }
          let rep: number;
          let val = 0;
          if (sym === 16) {
            if (i === 0) fail("length repeat without a previous length");
            val = lens[i - 1]!;
            need(2);
            rep = 3 + (bitbuf & 3);
            bitbuf >>>= 2;
            bitcnt -= 2;
          } else if (sym === 17) {
            need(3);
            rep = 3 + (bitbuf & 7);
            bitbuf >>>= 3;
            bitcnt -= 3;
          } else {
            need(7);
            rep = 11 + (bitbuf & 127);
            bitbuf >>>= 7;
            bitcnt -= 7;
          }
          if (i + rep > total) fail("too many code lengths");
          lens.fill(val, i, i + rep);
          i += rep;
        }
        if (lens[256] === 0) fail("missing end-of-block code");
        lit = buildHuffman(lens.subarray(0, hlit), true);
        dist = buildHuffman(lens.subarray(hlit), true);
      }
      const lt = lit.table;
      const lmask = (1 << lit.bits) - 1;
      const dt = dist.table;
      const dmask = (1 << dist.bits) - 1;
      for (;;) {
        while (bitcnt < 15 && pos < srcLen) {
          bitbuf |= src[pos++]! << bitcnt;
          bitcnt += 8;
        }
        const e = lt[bitbuf & lmask]!;
        const l = e >>> 9;
        if (l === 0) fail("invalid literal/length code");
        if (l > bitcnt) fail("compressed data ends early");
        bitbuf >>>= l;
        bitcnt -= l;
        const sym = e & 511;
        if (sym < 256) {
          out[op++] = sym;
          if (op === outLen) return;
          continue;
        }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= 29) fail("invalid literal/length code");
        let length = LEN_BASE[li]!;
        const le = LEN_EXTRA[li]!;
        if (le > 0) {
          need(le);
          length += bitbuf & ((1 << le) - 1);
          bitbuf >>>= le;
          bitcnt -= le;
        }
        while (bitcnt < 15 && pos < srcLen) {
          bitbuf |= src[pos++]! << bitcnt;
          bitcnt += 8;
        }
        const de = dt[bitbuf & dmask]!;
        const dl = de >>> 9;
        if (dl === 0) fail("invalid distance code");
        if (dl > bitcnt) fail("compressed data ends early");
        bitbuf >>>= dl;
        bitcnt -= dl;
        const ds = de & 511;
        if (ds >= 30) fail("invalid distance code");
        let distance = DIST_BASE[ds]!;
        const dx = DIST_EXTRA[ds]!;
        if (dx > 0) {
          need(dx);
          distance += bitbuf & ((1 << dx) - 1);
          bitbuf >>>= dx;
          bitcnt -= dx;
        }
        if (distance > op) fail("distance too far back");
        const end = Math.min(op + length, outLen);
        let from = op - distance;
        if (distance >= length && length > 16) {
          out.copyWithin(op, from, from + (end - op));
          op = end;
        } else {
          while (op < end) out[op++] = out[from++]!;
        }
        if (op === outLen) return;
      }
    } else {
      fail("invalid block type");
    }
    if (final) break;
  }
  fail("image data ends early");
}
