import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Pcg32 } from "../src/pcg.js";
import { f64ToHex } from "../src/detmath.js";

interface PcgFile {
  streams: { seed: string; next_u32: string[] }[];
  next_below: { seed: string; n: number; values: number[] }[];
  next_f64: { seed: string; values: string[] }[];
  shuffle: { seed: string; len: number; result: number[]; next_u32_after: string }[];
}

const doc = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../conformance/math/pcg32.json", import.meta.url)), "utf8"),
) as PcgFile;

const seedOf = (hex: string): bigint => BigInt(hex);
const hex32 = (u: number) => "0x" + u.toString(16).padStart(8, "0");

describe("Pcg32 (conformance/math/pcg32.json)", () => {
  it("first 1000 outputs for seeds 0, 1, 42, 2^32-1", () => {
    expect(doc.streams.map((s) => BigInt(s.seed))).toEqual([0n, 1n, 42n, 4294967295n]);
    for (const s of doc.streams) {
      expect(s.next_u32.length).toBe(1000);
      const viaBigint = new Pcg32(seedOf(s.seed));
      const viaNumber = new Pcg32(Number(BigInt(s.seed)));
      const got = s.next_u32.map(() => hex32(viaBigint.nextU32()));
      expect(got).toEqual(s.next_u32);
      expect(s.next_u32.map(() => hex32(viaNumber.nextU32()))).toEqual(s.next_u32);
    }
  });

  it("nextBelow", () => {
    for (const c of doc.next_below) {
      const rng = new Pcg32(seedOf(c.seed));
      expect(c.values.map(() => rng.nextBelow(c.n))).toEqual(c.values);
    }
  });

  it("nextF64", () => {
    for (const c of doc.next_f64) {
      const rng = new Pcg32(seedOf(c.seed));
      expect(c.values.map(() => f64ToHex(rng.nextF64()))).toEqual(c.values);
    }
  });

  it("shuffle", () => {
    for (const c of doc.shuffle) {
      const rng = new Pcg32(seedOf(c.seed));
      const a = Array.from({ length: c.len }, (_, i) => i);
      rng.shuffle(a);
      expect(a).toEqual(c.result);
      expect(hex32(rng.nextU32())).toBe(c.next_u32_after);
    }
  });

  it("does not use BigInt after construction", () => {
    const proto = Pcg32.prototype as unknown as Record<string, () => unknown>;
    for (const name of ["nextU32", "nextF64", "nextBelow", "shuffle", "step"]) {
      const src = String(proto[name]);
      expect(src).not.toMatch(/BigInt|\d+n\b/);
    }
  });

  it("rejects invalid seeds and bounds", () => {
    expect(() => new Pcg32(-1)).toThrow(RangeError);
    expect(() => new Pcg32(1.5)).toThrow(RangeError);
    expect(() => new Pcg32(2n ** 64n)).toThrow(RangeError);
    expect(() => new Pcg32(0).nextBelow(2 ** 32)).toThrow(RangeError);
    expect(() => new Pcg32(0).nextBelow(0.5)).toThrow(RangeError);
    expect(new Pcg32(2n ** 64n - 1n).nextU32()).toBe(new Pcg32(0xffffffffffffffffn).nextU32());
  });
});
