import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { constants, deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { decode, RasterError } from "../src/index.js";
import { inflateZlib } from "../src/inflate.js";
import { MAX_DECODED_BYTES } from "../src/png.js";

const IMAGES = join(dirname(fileURLToPath(import.meta.url)), "../../../../conformance/raster/images");

class Rng {
  constructor(private state: number) {}
  next(): number {
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state;
  }
  below(n: number): number {
    return Math.floor((this.next() / 2 ** 32) * n);
  }
}

describe("inflateZlib", () => {
  const rng = new Rng(99);
  const samples: Uint8Array[] = [new Uint8Array(0), new Uint8Array([7]), new Uint8Array(70000).fill(3)];
  for (let k = 0; k < 6; k++) {
    // Mixed content: runs, repeats with long distances, noise.
    const n = 1000 + rng.below(90000);
    const a = new Uint8Array(n);
    for (let i = 0; i < n; i++) a[i] = i % 977 < 300 ? (i * 7) & 0xff : rng.below(k < 3 ? 4 : 256);
    samples.push(a);
  }
  const options = [
    { level: 0 },
    { level: 1 },
    { level: 6 },
    { level: 9, memLevel: 9 },
    { level: 9, strategy: constants.Z_FIXED },
    { level: 6, strategy: constants.Z_HUFFMAN_ONLY },
    { level: 6, strategy: constants.Z_RLE },
    { level: 9, windowBits: 9 },
  ];
  it("matches node:zlib for every block type and strategy", () => {
    for (const data of samples) {
      for (const opt of options) {
        const z = deflateSync(data, opt);
        const out = new Uint8Array(data.length);
        inflateZlib(new Uint8Array(z), out);
        expect(Buffer.from(out).equals(Buffer.from(data)), JSON.stringify(opt)).toBe(true);
      }
    }
  });
  it("stops when the output is full and ignores the rest", () => {
    const data = new Uint8Array(5000).map((_, i) => i & 0xff);
    const z = new Uint8Array(deflateSync(data));
    const out = new Uint8Array(1234);
    inflateZlib(z, out);
    expect(Array.from(out)).toEqual(Array.from(data.subarray(0, 1234)));
  });
  it("rejects bad headers, truncation and invalid codes", () => {
    const z = new Uint8Array(deflateSync(new Uint8Array(3000).map((_, i) => (i * 31) & 0xff)));
    const fails = (src: Uint8Array, n = 3000) => {
      expect(() => inflateZlib(src, new Uint8Array(n))).toThrow(RasterError);
    };
    fails(new Uint8Array([0x78]));
    fails(new Uint8Array([0x79, 0x9c, ...z.subarray(2)])); // CM = 9
    fails(new Uint8Array([0x78, 0xbb, ...z.subarray(2)])); // FDICT
    fails(z.subarray(0, z.length >> 1)); // truncated
    fails(new Uint8Array([0x78, 0x01, 0x07, 0x00])); // block type 3
    fails(new Uint8Array([0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xfe, 1, 2, 3, 4, 5]), 5); // LEN/NLEN mismatch
    fails(new Uint8Array(deflateSync(new Uint8Array(10))), 11); // ends early
  });
});

describe("decode (PNG)", () => {
  it("decodes every conformance image or throws a RasterError", () => {
    for (const f of readdirSync(IMAGES).sort()) {
      const bytes = new Uint8Array(readFileSync(join(IMAGES, f)));
      try {
        const img = decode(bytes);
        expect(img.data.length).toBe(img.width * img.height * 4);
      } catch (e) {
        expect(e, f).toBeInstanceOf(RasterError);
        expect(f.startsWith("corrupt-") || f.startsWith("limit-")).toBe(true);
      }
    }
  });

  it("decodes known pixels (palette, grey, 16 bit)", () => {
    const p8 = decode(new Uint8Array(readFileSync(join(IMAGES, "p8-out-of-range.png"))));
    // index (x + 2y) % 8: 0 white, 1 red with alpha 0xc0, 2 green with alpha 0x40, 5.. black opaque
    expect(Array.from(p8.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(p8.data.subarray(4, 8))).toEqual([250, 0, 0, 0xc0]);
    expect(Array.from(p8.data.subarray(8, 12))).toEqual([0, 250, 0, 0x40]);
    expect(Array.from(p8.data.subarray(20, 24))).toEqual([0, 0, 0, 255]);
    const g1 = decode(new Uint8Array(readFileSync(join(IMAGES, "g1.png"))));
    expect(Array.from(g1.data.subarray(0, 4))).toEqual([255, 255, 255, 255]);
    expect(Array.from(g1.data.subarray(4, 8))).toEqual([0, 0, 0, 255]);
  });

  it("checks the memory limit before decoding image data", () => {
    expect(MAX_DECODED_BYTES).toBe(512 * 1024 * 1024);
    const huge = new Uint8Array(readFileSync(join(IMAGES, "limit-exceeded.png")));
    expect(() => decode(huge)).toThrow(expect.objectContaining({ code: "limit_exceeded" }));
  });
});

function crc32(b: Uint8Array): number {
  let c = -1;
  for (const v of b) {
    c ^= v;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ -1) >>> 0;
}

function chunks(png: Uint8Array): [number, number, number][] {
  const out: [number, number, number][] = [];
  let pos = 8;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (pos + 12 <= png.length) {
    const len = view.getUint32(pos);
    const end = pos + 8 + len;
    if (end + 4 > png.length) break;
    out.push([pos, pos + 8, end]);
    pos = end + 4;
  }
  return out;
}

function mutate(rng: Rng, src: Uint8Array): Uint8Array {
  let b = src.slice();
  const cs = chunks(b);
  const fixCrc = (c: [number, number, number]) => new DataView(b.buffer).setUint32(c[2], crc32(b.subarray(c[0] + 4, c[2])));
  switch (rng.below(7)) {
    case 0:
      b[rng.below(b.length)] ^= 1 << rng.below(8);
      break;
    case 1:
      b = b.slice(0, rng.below(b.length));
      break;
    case 2: {
      const i = rng.below(b.length);
      b = Uint8Array.from([...b.subarray(0, i), rng.below(256), ...b.subarray(i)]);
      break;
    }
    case 3:
    case 4: {
      if (cs.length === 0) break;
      const c = cs[rng.below(cs.length)]!;
      if (c[2] > c[1]) {
        b[c[1] + rng.below(c[2] - c[1])] = rng.below(256);
        fixCrc(c);
      }
      break;
    }
    case 5: {
      if (cs.length === 0) break;
      const c = cs[rng.below(cs.length)]!;
      b[c[0] + rng.below(4)] = rng.below(256);
      break;
    }
    default: {
      const c = cs.find((x) => String.fromCharCode(...b.subarray(x[0] + 4, x[0] + 8)) === "IDAT");
      if (c && c[2] > c[1]) {
        for (let k = 0; k < 1 + rng.below(4); k++) b[c[1] + rng.below(c[2] - c[1])] ^= 1 << rng.below(8);
        fixCrc(c);
      }
    }
  }
  return b;
}

describe("robustness", () => {
  it("never throws anything but RasterError on mutated PNGs", () => {
    const rng = new Rng(0x5eed);
    let ok = 0;
    let errors = 0;
    for (const f of readdirSync(IMAGES).sort()) {
      const original = new Uint8Array(readFileSync(join(IMAGES, f)));
      for (let i = 0; i < 120; i++) {
        const bytes = mutate(rng, original);
        try {
          decode(bytes);
          ok++;
        } catch (e) {
          if (!(e instanceof RasterError)) throw new Error(`${f} mutation ${i}: ${String(e)}`);
          errors++;
        }
      }
    }
    expect(ok).toBeGreaterThan(0);
    expect(errors).toBeGreaterThan(0);
  });
});
