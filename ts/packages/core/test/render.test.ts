// Port of the unit tests of rust/crates/la-render/src/lib.rs.
import { describe, expect, it } from "vitest";
import { base64, pngRgba } from "../src/render.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

describe("render", () => {
  it("png_has_signature_and_iend", () => {
    const p = pngRgba(3, 2, (i, out, o) => {
      out[o] = i;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 255;
    });
    expect(Array.from(p.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new TextDecoder().decode(p.subarray(p.length - 8, p.length - 4))).toBe("IEND");
  });

  it("base64_roundtrip_known", () => {
    expect(base64(enc("Man"))).toBe("TWFu");
    expect(base64(enc("Ma"))).toBe("TWE=");
    expect(base64(enc("M"))).toBe("TQ==");
  });
});
