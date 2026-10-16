/** Text measurement with the host's own font rendering (a 2D canvas). */
import type { FontSpec, TextMetrics } from "@label-anything/core";

export type MeasureFn = (text: string, font: FontSpec) => TextMetrics | null;

/** A resolved label font: CSS family list, size in px, numeric weight, italic flag. */
export interface CssFont {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
}

/** The CSS `font` shorthand of a font. */
export function cssFont(font: { family: string; size: number; weight?: number; italic?: boolean }): string {
  return `${font.italic ? "italic " : ""}${font.weight ?? 400} ${font.size}px ${font.family}`;
}

type Ctx2d = Pick<CanvasRenderingContext2D, "font" | "measureText">;

function context2d(): Ctx2d | null {
  try {
    if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(1, 1).getContext("2d") as Ctx2d | null;
    if (typeof document === "object" && document && !/jsdom/i.test(globalThis.navigator?.userAgent ?? "")) {
      return document.createElement("canvas").getContext("2d");
    }
  } catch {
    // no usable canvas
  }
  return null;
}

/**
 * Measures text with `CanvasRenderingContext2D.measureText`, so that label boxes match how
 * the browser renders the same CSS font (pass it as `PlaceOptions.measure`). Returns
 * `undefined` where no canvas exists (Node, jsdom); the engine then uses its built-in
 * metrics. Works in Web Workers through `OffscreenCanvas`.
 */
export function canvasMeasure(): MeasureFn | undefined {
  const ctx = context2d();
  if (!ctx) return undefined;
  const cache = new Map<string, TextMetrics>();
  return (text, font) => {
    const css = cssFont(font);
    const key = `${css}\u0000${text}`;
    let m = cache.get(key);
    if (m === undefined) {
      ctx.font = css;
      const t = ctx.measureText(text);
      m = {
        width: t.width,
        ascent: positive(t.fontBoundingBoxAscent) ?? 0.8 * font.size,
        descent: positive(t.fontBoundingBoxDescent) ?? 0.2 * font.size,
      };
      if (cache.size >= 50_000) cache.clear();
      cache.set(key, m);
    }
    return m;
  };
}

function positive(v: number | undefined): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Numeric CSS font weight (`bold` = 700, `normal` = 400). */
export function numericWeight(w: string | number | undefined | null): number {
  if (typeof w === "number") return w;
  if (w === "bold" || w === "bolder") return 700;
  if (w === "lighter") return 300;
  const n = Number.parseFloat(w ?? "");
  return Number.isFinite(n) && n >= 1 && n <= 1000 ? n : 400;
}
