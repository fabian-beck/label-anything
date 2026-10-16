// Base64 and `data:` URL parsing without Buffer/atob, identical to the Rust crate.
//
// Base64 rules: the standard (`+ /`) and URL-safe (`- _`) alphabets are both accepted
// (and may be mixed); ASCII whitespace (space, tab, LF, CR, FF) is ignored anywhere;
// padding is optional, but if present it must complete the last 4-character quantum and
// nothing but whitespace may follow it; a quantum of a single character is an error;
// non-zero trailing bits are ignored.

import { RasterError } from "./errors.js";

const INVALID = 0xff;
const SKIP = 0xfe;
const PAD = 0xfd;

const TABLE: Uint8Array = (() => {
  const t = new Uint8Array(256).fill(INVALID);
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < alphabet.length; i++) t[alphabet.charCodeAt(i)] = i;
  t[0x2b] = 62; // +
  t[0x2d] = 62; // -
  t[0x2f] = 63; // /
  t[0x5f] = 63; // _
  t[0x3d] = PAD; // =
  for (const c of [0x20, 0x09, 0x0a, 0x0d, 0x0c]) t[c] = SKIP;
  return t;
})();

/** Bit set by {@link SHIFTED} for characters outside the alphabet. */
const FAST_INVALID = 1 << 24;

/**
 * `TABLE` values shifted into place for the fast path: quantum position `k` holds the
 * sextet at bit `18 − 6k`; other characters have {@link FAST_INVALID} set.
 */
const SHIFTED: Int32Array[] = [0, 1, 2, 3].map((k) => {
  const t = new Int32Array(256);
  for (let c = 0; c < 256; c++) {
    const v = TABLE[c]!;
    t[c] = v < 64 ? v << (18 - 6 * k) : FAST_INVALID;
  }
  return t;
});

/**
 * Decodes base64 text (standard or URL-safe alphabet, padding optional, ASCII
 * whitespace ignored). Throws a {@link RasterError} with code `invalid_base64`.
 */
export function decodeBase64(input: string): Uint8Array {
  const n = input.length;
  const out = new Uint8Array(Math.floor((n * 3) / 4) + 3);
  // fast path: leading whole quanta of four alphabet characters (no whitespace or
  // padding), three bytes at a time; the general decoder continues from the first other
  // character (mirrors the Rust decoder)
  const t0 = SHIFTED[0]!;
  const t1 = SHIFTED[1]!;
  const t2 = SHIFTED[2]!;
  const t3 = SHIFTED[3]!;
  const whole = n - (n % 4);
  let start = 0;
  let o = 0;
  for (; start < whole; start += 4) {
    const c0 = input.charCodeAt(start);
    const c1 = input.charCodeAt(start + 1);
    const c2 = input.charCodeAt(start + 2);
    const c3 = input.charCodeAt(start + 3);
    if ((c0 | c1 | c2 | c3) > 0xff) break;
    const v = t0[c0]! | t1[c1]! | t2[c2]! | t3[c3]!;
    if (v >= FAST_INVALID) break;
    out[o] = v >> 16;
    out[o + 1] = (v >> 8) & 0xff;
    out[o + 2] = v & 0xff;
    o += 3;
  }
  let acc = 0;
  let nbits = 0;
  let chars = start;
  let pad = 0;
  for (let pos = start; pos < n; pos++) {
    const c = input.charCodeAt(pos);
    const v = c < 256 ? TABLE[c]! : INVALID;
    if (v === SKIP) continue;
    if (v === PAD) {
      pad++;
      continue;
    }
    if (v === INVALID) throw new RasterError("invalid_base64", `invalid base64 character at offset ${pos}`);
    if (pad > 0) throw new RasterError("invalid_base64", `base64 data after padding at offset ${pos}`);
    acc = (acc << 6) | v;
    nbits += 6;
    chars++;
    if (nbits >= 8) {
      nbits -= 8;
      out[o++] = (acc >>> nbits) & 0xff;
      acc &= (1 << nbits) - 1;
    }
  }
  if (chars % 4 === 1) throw new RasterError("invalid_base64", "truncated base64 data (dangling character)");
  if (pad > 0 && (pad > 2 || (chars + pad) % 4 !== 0)) {
    throw new RasterError("invalid_base64", "invalid base64 padding");
  }
  return out.subarray(0, o);
}

function isAsciiWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
}

function hexValue(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

/** Appends the UTF-8 encoding of the code point at `s[i]`; returns the next index. */
function pushUtf8(s: string, i: number, out: number[]): number {
  let cp = s.codePointAt(i)!;
  const next = i + (cp > 0xffff ? 2 : 1);
  if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd; // lone surrogate (not representable in Rust)
  if (cp < 0x80) out.push(cp);
  else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
  else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  return next;
}

/**
 * The bytes of a raster `source` string: a `data:` URL (`;base64` or percent-encoded)
 * or bare base64. Surrounding ASCII whitespace is ignored; the `data:` prefix and the
 * `;base64` marker are case-insensitive; the media type is not interpreted.
 */
export function sourceBytes(src: string): Uint8Array {
  let start = 0;
  let end = src.length;
  while (start < end && isAsciiWs(src.charCodeAt(start))) start++;
  while (end > start && isAsciiWs(src.charCodeAt(end - 1))) end--;
  const s = src.slice(start, end);
  if (s.length < 5 || s.slice(0, 5).toLowerCase() !== "data:") return decodeBase64(s);
  const comma = s.indexOf(",", 5);
  if (comma < 0) throw new RasterError("invalid_data_url", "data: URL without ','");
  const meta = s.slice(5, comma);
  const payload = s.slice(comma + 1);
  if (meta.length >= 7 && meta.slice(meta.length - 7).toLowerCase() === ";base64") return decodeBase64(payload);
  const out: number[] = [];
  let i = 0;
  while (i < payload.length) {
    const c = payload.charCodeAt(i);
    if (c === 0x25) {
      const hi = i + 1 < payload.length ? hexValue(payload.charCodeAt(i + 1)) : -1;
      const lo = i + 2 < payload.length ? hexValue(payload.charCodeAt(i + 2)) : -1;
      if (hi < 0 || lo < 0) {
        throw new RasterError("invalid_data_url", `invalid percent escape in data: URL at offset ${i}`);
      }
      out.push((hi << 4) | lo);
      i += 3;
    } else if (c < 0x80) {
      out.push(c);
      i++;
    } else {
      i = pushUtf8(payload, i, out);
    }
  }
  return Uint8Array.from(out);
}
