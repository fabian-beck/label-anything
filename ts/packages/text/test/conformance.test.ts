// Runs the `text` conformance cases in conformance/text/*.json (keys: see
// tools/text/gen_text_cases.py). Widths must match within the case's tolerance and,
// stricter, be bit-identical to the reference values. The wrapping cases run twice: with the
// callback `(s) => font.width(s, size)` and with a `FontMeasure` (lines measured with
// `MeasuredText`), whose variants must be bit-identical to the callback's.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  balancedWrap,
  breakOpportunities,
  extraWrapVariants,
  FontBook,
  greedyWrap,
  truncateEnd,
  truncateMiddle,
  wrapVariants,
  type Font,
  type FontMeasure,
  type Measure,
  type TextVariant,
  type Truncate,
} from "../src/index.js";

const caseDir = fileURLToPath(new URL("../../../../conformance/text/", import.meta.url));

interface ExpectedVariant {
  lines: string[];
  widths: number[];
  truncated: boolean;
}

interface TextCase {
  kind: string;
  font: { family?: string; weight?: number | "normal" | "bold"; style?: string; file?: string };
  size: number;
  metrics?: { units_per_em: number; ascender: number; descender: number; line_gap: number };
  widths?: { text: string; width: number; units?: number; tol?: number }[];
  breaks?: { text: string; breaks: number[] }[];
  wrap?: { text: string; max_width: number; lines: string[] }[];
  balanced?: { text: string; lines_target: number; max_width?: number | null; lines: string[] }[];
  truncate?: {
    text: string;
    max_width: number;
    mode: "end" | "middle";
    max_lines?: number;
    result?: string;
    lines?: string[];
  }[];
  variants?: {
    text: string;
    options: { max_width: number | null; max_lines?: number; balance?: boolean; truncate?: Truncate };
    variants: ExpectedVariant[];
  }[];
  extra_variants?: { text: string; max_lines: number; variants: ExpectedVariant[] }[];
}

function loadFont(spec: TextCase["font"]): Font {
  const book = FontBook.withBundled();
  const weight = spec.weight === "bold" ? 700 : typeof spec.weight === "number" ? spec.weight : 400;
  const italic = spec.style === "italic";
  const id =
    spec.file !== undefined
      ? book.register(spec.file, weight, italic, readFileSync(join(caseDir, spec.file)))
      : book.resolve(spec.family ?? "default", weight, italic);
  return book.font(id);
}

function expectVariants(got: TextVariant[], expected: ExpectedVariant[]): void {
  expect(got.map((v) => [v.lines, v.truncated])).toEqual(expected.map((v) => [v.lines, v.truncated]));
  got.forEach((v, i) => {
    expect(v.widths.length).toBe(expected[i].widths.length);
    v.widths.forEach((w, j) => expect(Math.abs(w - expected[i].widths[j])).toBeLessThanOrEqual(0.01));
  });
}

/** Variants of a `FontMeasure` must be bit-identical to the callback's. */
function expectSameBits(got: TextVariant[], callback: TextVariant[]): void {
  expect(got.map((v) => [v.lines, v.truncated])).toEqual(callback.map((v) => [v.lines, v.truncated]));
  got.forEach((v, i) => v.widths.forEach((w, j) => expect(Object.is(w, callback[i].widths[j])).toBe(true)));
}

const files = readdirSync(caseDir)
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("text conformance", () => {
  it("has cases", () => expect(files.length).toBeGreaterThan(0));

  for (const file of files) {
    describe(file, () => {
      const c = JSON.parse(readFileSync(join(caseDir, file), "utf8")) as TextCase;
      const font = loadFont(c.font);
      const callback = (s: string): number => font.width(s, c.size);

      it("is a text case", () => expect(c.kind).toBe("text"));

      if (c.metrics !== undefined) {
        it("metrics", () => {
          expect([font.unitsPerEm, font.ascender, font.descender, font.lineGap]).toEqual([
            c.metrics!.units_per_em,
            c.metrics!.ascender,
            c.metrics!.descender,
            c.metrics!.line_gap,
          ]);
        });
      }

      if (c.widths !== undefined) {
        it("widths (within tolerance and bit-identical)", () => {
          for (const e of c.widths!) {
            const w = font.width(e.text, c.size);
            expect(Math.abs(w - e.width), e.text).toBeLessThanOrEqual(e.tol ?? 0.01);
            expect(Object.is(w, e.width), `${e.text}: ${w} vs ${e.width}`).toBe(true);
            if (e.units !== undefined) expect(font.advanceUnits(e.text), e.text).toBe(e.units);
          }
        });
      }

      if (c.breaks !== undefined) {
        it("breaks", () => {
          for (const e of c.breaks!) expect(breakOpportunities(e.text), e.text).toEqual(e.breaks);
        });
      }

      const measures: [string, Measure | FontMeasure][] = [
        ["", callback],
        [" with a FontMeasure", { font, size: c.size }],
      ];
      for (const [suffix, measure] of measures) {
        if (c.wrap !== undefined) {
          it(`greedy wrap${suffix}`, () => {
            for (const e of c.wrap!) expect(greedyWrap(e.text, e.max_width, measure), e.text).toEqual(e.lines);
          });
        }

        if (c.balanced !== undefined) {
          it(`balanced wrap${suffix}`, () => {
            for (const e of c.balanced!) {
              expect(balancedWrap(e.text, e.lines_target, e.max_width, measure), e.text).toEqual(e.lines);
            }
          });
        }

        if (c.truncate !== undefined) {
          it(`truncation${suffix}`, () => {
            for (const e of c.truncate!) {
              const got =
                e.mode === "end"
                  ? [truncateEnd(e.text, e.max_width, measure)]
                  : truncateMiddle(e.text, e.max_width, e.max_lines ?? 1, measure);
              expect(got, `${e.mode} ${e.text} ${e.max_width}`).toEqual(e.result !== undefined ? [e.result] : e.lines);
            }
          });
        }

        if (c.variants !== undefined) {
          it(`wrap variants${suffix}`, () => {
            for (const e of c.variants!) {
              const o = e.options;
              const options = {
                maxWidth: o.max_width,
                maxLines: o.max_lines,
                balance: o.balance,
                truncate: o.truncate,
              };
              const got = wrapVariants(e.text, options, measure);
              expectVariants(got, e.variants);
              if (measure !== callback) expectSameBits(got, wrapVariants(e.text, options, callback));
            }
          });
        }

        if (c.extra_variants !== undefined) {
          it(`extra wrap variants${suffix}`, () => {
            for (const e of c.extra_variants!) {
              const got = extraWrapVariants(e.text, e.max_lines, measure);
              expectVariants(got, e.variants);
              if (measure !== callback) expectSameBits(got, extraWrapVariants(e.text, e.max_lines, callback));
            }
          });
        }
      }
    });
  }
});
