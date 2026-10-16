import { describe, expect, it } from "vitest";
import { Font, FontBook, needsComplexShaping, TextError } from "../src/index.js";
import { NOTO_SANS_REGULAR_BASE64 } from "../src/generated/fonts.js";
import { decodeBase64 } from "../src/base64.js";

const regular = (): Uint8Array => decodeBase64(NOTO_SANS_REGULAR_BASE64);

function expectError(data: Uint8Array, code: TextError["code"], message: RegExp): void {
  try {
    Font.fromBytes(data);
  } catch (error) {
    expect(error).toBeInstanceOf(TextError);
    expect((error as TextError).code).toBe(code);
    expect((error as TextError).message).toMatch(message);
    return;
  }
  throw new Error("expected a TextError");
}

describe("Font", () => {
  it("decodes the bundled font", () => {
    const data = regular();
    expect(data.length).toBe(79776);
    const font = Font.fromBytes(data);
    expect([font.unitsPerEm, font.ascender, font.descender, font.lineGap]).toEqual([1000, 1069, -293, 0]);
    expect(font.advanceUnits("AV")).toBe(1199);
    expect(font.width("AV", 12)).toBe((1199 * 12) / 1000);
    expect(font.advanceUnits("")).toBe(0);
    // unmapped code points use glyph 0, also outside the BMP
    expect(font.advanceUnits("\u{1F600}")).toBe(font.advanceUnits("￿"));
  });

  it("measures long texts without losing precision", () => {
    const font = FontBook.withBundled().font(0);
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(50);
    expect(font.advanceUnits(text)).toBe(50 * font.advanceUnits("The quick brown fox jumps over the lazy dog. "));
  });

  it("rejects invalid and unsupported data", () => {
    expectError(new Uint8Array(0), "invalid_font", /too short/);
    expectError(new TextEncoder().encode("not a font at all"), "invalid_font", /not a TrueType\/OpenType font/);
    expectError(new TextEncoder().encode("wOFFxxxxxxxxxxxx"), "unsupported", /WOFF 1\.0/);
    expectError(new TextEncoder().encode("wOF2xxxxxxxxxxxx"), "unsupported", /WOFF2/);
    const truncated = regular().slice(0, 300);
    expectError(truncated, "invalid_font", /missing|malformed|too short/);
  });

  it("rejects corrupted fonts with TextError or measures them, never throws otherwise", () => {
    const original = regular();
    const view = new DataView(original.buffer, original.byteOffset, original.byteLength);
    const tables: [number, number][] = [];
    for (let i = 0; i < view.getUint16(4); i++) {
      const length = view.getUint32(12 + 16 * i + 12);
      if (length > 0) tables.push([view.getUint32(12 + 16 * i + 8), length]);
    }
    let state = 0x2545f491; // xorshift32
    const next = (): number => {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return state >>> 0;
    };
    let loaded = 0;
    let rejected = 0;
    for (let round = 0; round < 400; round++) {
      let data = original.slice();
      const [offset, length] = tables[next() % tables.length];
      for (let k = 1 + (next() % 8); k > 0; k--) data[offset + (next() % length)] = next() & 0xff;
      if (round % 10 === 0) data = data.slice(0, next() % original.length);
      let font: Font;
      try {
        font = Font.fromBytes(data);
      } catch (error) {
        expect(error).toBeInstanceOf(TextError);
        rejected++;
        continue;
      }
      loaded++;
      for (const text of ["AV", "Hello, World", "Αθήνα", "éx", "中文\u{1F600}"]) {
        expect(Number.isFinite(font.width(text, 12))).toBe(true);
      }
    }
    expect(loaded).toBeGreaterThan(0);
    expect(rejected).toBeGreaterThan(0);
  });

  it("detects texts that need complex shaping", () => {
    expect(needsComplexShaping("abc א")).toBe(true);
    expect(needsComplexShaping("कि")).toBe(true);
    expect(needsComplexShaping("ก")).toBe(true);
    expect(needsComplexShaping("Hello, Ελλάδα, Привет, 中文")).toBe(false);
  });
});

describe("FontBook", () => {
  it("resolves family, style and weight", () => {
    const book = FontBook.withBundled();
    expect(book.resolve("default", 400, false)).toBe(0);
    expect(book.resolve("NOTO SANS", 700, false)).toBe(1);
    expect(book.resolve("Unknown", 900, true)).toBe(1);
    expect(book.resolve("default", 550, false)).toBe(0);
    expect(book.resolve("default", 551, false)).toBe(1);
    expect(book.resolve("default", 100, false)).toBe(0);
  });

  it("prefers registered fonts and the requested style", () => {
    const book = FontBook.withBundled();
    const italic = book.register("default", 400, true, regular());
    expect(book.resolve("default", 700, true)).toBe(italic);
    expect(book.resolve("default", 700, false)).toBe(1);
    const shadow = book.register("default", 700, false, regular());
    expect(book.resolve("default", 700, false)).toBe(shadow);
    expect(book.font(shadow).unitsPerEm).toBe(1000);

    const custom = FontBook.empty();
    expect(() => custom.resolve("default", 400, false)).toThrow(/at least one font/);
    const only = custom.register("Custom", 300, false, regular());
    expect(custom.resolve("default", 400, true)).toBe(only);
    expect(() => custom.font(5)).toThrow(RangeError);
  });
});
