import { describe, expect, it } from "vitest";
import { cbrt, decodeBase64, estimateBackground, parseHexColor, rgbaFromBytes, sourceBytes, srgbToOklab, RasterError } from "../src/index.js";

function ulps(a: number, b: number): number {
  return Math.abs(a - b) / Number.EPSILON / Math.max(Math.abs(b), Number.MIN_VALUE);
}

describe("cbrt", () => {
  it("handles special values", () => {
    expect(cbrt(0)).toBe(0);
    expect(Object.is(cbrt(-0), -0)).toBe(true);
    expect(cbrt(Number.NaN)).toBeNaN();
    expect(cbrt(Infinity)).toBe(Infinity);
    expect(cbrt(-Infinity)).toBe(-Infinity);
    expect(cbrt(-8)).toBe(-2);
    expect(cbrt(1)).toBe(1);
    expect(cbrt(0.125)).toBe(0.5);
  });

  it("is within 2 ulp of Math.cbrt over a wide range", () => {
    let state = 12345;
    let worst = 0;
    for (let i = 0; i < 200000; i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      const x = Math.exp((state / 2 ** 32) * 60 - 40);
      worst = Math.max(worst, ulps(cbrt(x), Math.cbrt(x)));
    }
    expect(worst).toBeLessThanOrEqual(2);
    for (const x of [Number.MIN_VALUE, 2.2250738585072014e-308, 1e-300, 1e300, Number.MAX_VALUE]) {
      expect(ulps(cbrt(x), Math.cbrt(x))).toBeLessThanOrEqual(2);
    }
  });
});

describe("srgbToOklab", () => {
  it("matches the published values", () => {
    expect(srgbToOklab([0, 0, 0])).toEqual([0, 0, 0]);
    const red = srgbToOklab([255, 0, 0]);
    expect(red[0]).toBeCloseTo(0.627955, 6);
    expect(red[1]).toBeCloseTo(0.224863, 6);
    expect(red[2]).toBeCloseTo(0.125846, 6);
    const white = srgbToOklab([255, 255, 255]);
    expect(white[0]).toBeCloseTo(1, 7);
  });

  it("rejects non-byte channels", () => {
    expect(() => srgbToOklab([256, 0, 0])).toThrow(RangeError);
    expect(() => srgbToOklab([1.5, 0, 0])).toThrow(RangeError);
    expect(() => srgbToOklab([-1, 0, 0])).toThrow(RangeError);
  });
});

describe("parseHexColor", () => {
  it("parses #rgb and #rrggbb", () => {
    expect(parseHexColor("#000")).toEqual([0, 0, 0]);
    expect(parseHexColor("#fA0")).toEqual([255, 170, 0]);
    expect(parseHexColor("#1a2B3c")).toEqual([0x1a, 0x2b, 0x3c]);
  });
  it("rejects everything else", () => {
    for (const s of ["", "#", "#ab", "#abcd", "#abcde", "#abcdef0", "#ggg", " #abc", "#abc ", "abc", "#１２３"]) {
      expect(parseHexColor(s)).toBeNull();
    }
  });
});

describe("base64 and data URLs", () => {
  const text = (b: Uint8Array): string => String.fromCharCode(...b);
  it("decodes both alphabets with optional padding and whitespace", () => {
    expect(text(decodeBase64("TWFu"))).toBe("Man");
    expect(text(decodeBase64("TWE="))).toBe("Ma");
    expect(text(decodeBase64("TQ"))).toBe("M");
    expect(text(decodeBase64(" T W\nF u\r\n"))).toBe("Man");
    expect(decodeBase64("-_-_")).toEqual(decodeBase64("+/+/"));
    expect(decodeBase64("")).toEqual(new Uint8Array(0));
  });
  it("rejects malformed base64", () => {
    for (const s of ["T", "TQ=", "TQ===", "TQ==TQ==", "TWFu=", "TW*u", "TWFuT", "é", "TWFĀ"]) {
      expect(() => decodeBase64(s), s).toThrow(RasterError);
      try {
        decodeBase64(s);
      } catch (e) {
        expect((e as RasterError).code).toBe("invalid_base64");
      }
    }
  });
  it("parses data URLs", () => {
    expect(text(sourceBytes("data:image/png;base64,TWFu"))).toBe("Man");
    expect(text(sourceBytes("  DATA:;BASE64,TWFu \n"))).toBe("Man");
    expect(text(sourceBytes("data:,M%61n"))).toBe("Man");
    expect(Array.from(sourceBytes("data:,é"))).toEqual([0xc3, 0xa9]);
    expect(text(sourceBytes("TWFu"))).toBe("Man");
    const code = (s: string): string => {
      try {
        sourceBytes(s);
        return "ok";
      } catch (e) {
        return (e as RasterError).code;
      }
    };
    expect(code("data:image/png;base64")).toBe("invalid_data_url");
    expect(code("data:,%6")).toBe("invalid_data_url");
    expect(code("data:;base64,T")).toBe("invalid_base64");
  });
});

describe("estimateBackground", () => {
  const img = (w: number, h: number, f: (x: number, y: number) => number[]) => {
    const data = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
    return rgbaFromBytes(w, h, data);
  };
  it("takes the most frequent quantized border colour", () => {
    const a = img(5, 4, (x, y) => (x === 0 || y === 0 || x === 4 || y === 3 ? [250, 251, 252, 255] : [0, 0, 0, 255]));
    expect(estimateBackground(a)).toEqual([255, 255, 255]);
  });
  it("breaks ties by the smallest packed value and skips transparent pixels", () => {
    const tie = img(4, 2, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
    expect(estimateBackground(tie)).toEqual([0, 0, 255]);
    expect(estimateBackground(img(3, 3, () => [10, 20, 30, 127]))).toEqual([255, 255, 255]);
    expect(estimateBackground(img(1, 1, () => [10, 20, 30, 128]))).toEqual([8, 16, 24]);
    expect(estimateBackground({ width: 2, height: 2, data: new Uint8Array(3) })).toEqual([255, 255, 255]);
  });
});
