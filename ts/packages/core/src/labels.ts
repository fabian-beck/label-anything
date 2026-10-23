/**
 * Label measurement and label variants (spec §5.1–5.4); port of
 * `rust/crates/la-core/src/labels.rs`.
 *
 * TypeScript has no full OpenType shaping (spec §5.2): texts that would need it are
 * measured with simple shaping unless the host measures them.
 *
 * @module
 */

import {
  type Font,
  FontBook,
  type FontMeasure,
  type Measure,
  balancedWrap,
  extraWrapVariants,
  needsComplexShaping,
  truncateEnd,
  truncateMiddle,
  wrapVariants,
  type WrapOptions,
} from "@label-anything/text";
import { type Env, envHasMeasureCallback, envReadFile } from "./env.js";
import { P, Rect } from "./geom/index.js";
import { fmtFixed } from "./json.js";
import { maxf, minf } from "./math.js";
import {
  FixedKind,
  type FontSel,
  type Item,
  type LabelShape,
  type Model,
  type PartSpec,
  type Step,
  type TextSpec,
  dataUrlBytes,
} from "./model/index.js";

let BUNDLED: FontBook | null = null;

/** The bundled font book (parsed once). */
export function bundledFonts(): FontBook {
  BUNDLED ??= FontBook.withBundled();
  return BUNDLED;
}

/** A font-loading failure: the pointer of the font file and a message. */
export class FontError extends Error {
  readonly pointer: string;
  constructor(pointer: string, message: string) {
    super(message);
    this.name = "FontError";
    this.pointer = pointer;
  }
}

/**
 * Load the font files referenced by the items into a font book (bundled fonts first).
 * Returns null when no item references a font file. Font families named `default` that
 * carry a file are renamed so they never shadow the bundled font for other labels.
 * Throws {@link FontError}.
 */
export function userFonts(model: Model, env: Env): FontBook | null {
  let book: FontBook | null = null;
  const loaded: [file: string, family: string][] = [];
  for (let i = 0; i < model.items.length; i++) {
    const item = model.items[i]!;
    // [composite part index, font]
    const fonts: [part: number | null, font: FontSel][] = [[null, item.font]];
    const label = item.label;
    if (label.kind === "text") fonts.push([null, label.spec.font]);
    else if (label.kind === "composite") {
      label.parts.forEach((p, k) => {
        if (p.kind === "text") fonts.push([k, p.spec.font]);
      });
    }
    for (const [part, f] of fonts) {
      const file = f.file;
      if (file === null) continue;
      const known = loaded.find(([fl]) => fl === file);
      if (known !== undefined) {
        f.family = known[1];
        continue;
      }
      const ptr = fontFilePtr(item.raw, i, part, file);
      let bytes: Uint8Array;
      if (file.startsWith("data:")) {
        const b = dataUrlBytes(file);
        if (b === null) throw new FontError(ptr, "invalid data URL");
        bytes = b;
      } else {
        try {
          bytes = envReadFile(env, file);
        } catch (e) {
          throw new FontError(ptr, e instanceof Error ? e.message : String(e));
        }
      }
      const family = asciiEqIgnoreCase(f.family, "default") ? `user-font-${loaded.length}` : f.family;
      book ??= FontBook.withBundled();
      try {
        book.register(family, f.weight, f.italic, bytes);
      } catch (e) {
        throw new FontError(ptr, e instanceof Error ? e.message : String(e));
      }
      f.family = family;
      loaded.push([file, family]);
    }
  }
  return book;
}

/**
 * Where the font file of item `i` (of its composite part `part`) is set: the part's or the
 * label's `font.file` when it names `file`, else `defaults.font.file`.
 */
function fontFilePtr(raw: unknown, i: number, part: number | null, file: string): string {
  const field = (v: unknown, k: string): unknown =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
  const names = (v: unknown): boolean => field(field(v, "font"), "file") === file;
  const label = field(raw, "label");
  if (part !== null) {
    const parts = field(label, "parts");
    if (Array.isArray(parts) && names(parts[part])) return `/items/${i}/label/parts/${part}/font/file`;
  }
  if (names(label)) return `/items/${i}/label/font/file`;
  return "/defaults/font/file";
}

function asciiEqIgnoreCase(a: string, b: string): boolean {
  const lower = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
  return a.length === b.length && lower(a) === lower(b);
}

/** Text measurement with the host callback first, then the font book. */
export class Measurer {
  /** The resolved font of each `FontSel` (fonts are resolved after `userFonts`). */
  private readonly resolved = new Map<FontSel, Font>();

  constructor(
    readonly fonts: FontBook,
    readonly env: Env,
    /** "auto" | "simple" | "full" (full shaping is not available in TypeScript). */
    readonly shaping: string,
  ) {}

  private fontOf(font: FontSel): Font {
    let f = this.resolved.get(font);
    if (f === undefined) {
      f = this.fonts.font(this.fonts.resolve(font.family, font.weight, font.italic));
      this.resolved.set(font, f);
    }
    return f;
  }

  width(font: FontSel, scale: number, text: string): number {
    const size = font.size * scale;
    if (this.env.measure) {
      const m = this.env.measure(text, font.spec(scale));
      if (m !== null && m !== undefined) return m.width;
    }
    return this.fontOf(font).width(text, size);
  }

  /**
   * The measure for wrapping and truncating a text: `width`, a callback over
   * {@link Measurer.width}, unless that measures every string they produce with simple
   * shaping, i.e. without a host measurement (TypeScript has no full shaping, so the shaping
   * mode and the text do not matter, unlike in Rust). Then the font itself, which measures
   * each candidate line in constant time with identical widths (ADR 0018).
   */
  wrapMeasure(font: FontSel, scale: number, width: Measure): Measure | FontMeasure {
    if (envHasMeasureCallback(this.env)) return width;
    return { font: this.fontOf(font), size: font.size * scale };
  }

  /**
   * The ink of `text` in px (spec §5.2): how far its glyphs reach above and below the
   * baseline (the bounds of their outlines, `LAvb`), when the text is measured with simple
   * shaping (as Rust measures it: not with shaping `full`, nor `auto` for a text with complex
   * scripts), its font has glyph bounds and a glyph of it has an outline; else null. For
   * boxes whose vertical metrics are the font's, not the host's.
   */
  ink(font: FontSel, scale: number, text: string): [number, number] | null {
    if (this.shaping === "full" || (this.shaping === "auto" && needsComplexShaping(text))) return null;
    const size = font.size * scale;
    const f = this.fontOf(font);
    const ink = f.inkUnits(text);
    if (ink === null) return null;
    const upm = f.unitsPerEm;
    return [(ink[1] * size) / upm, (-ink[0] * size) / upm];
  }

  /** `[ascent, descent]` in px, both positive, and whether the host measured them. */
  vmetrics(font: FontSel, scale: number): [number, number, boolean] {
    const size = font.size * scale;
    if (this.env.measure) {
      const m = this.env.measure("", font.spec(scale));
      if (m !== null && m !== undefined) return [m.ascent, m.descent, true];
    }
    const f = this.fontOf(font);
    const upm = f.unitsPerEm;
    return [(f.ascender * size) / upm, (-f.descender * size) / upm, false];
  }
}

/** Resolved text of a variant. */
export interface TextLayout {
  lines: string[];
  widths: number[];
  /** Baseline of each line relative to the box top. */
  baselines: number[];
  xOffset: number;
  fontSize: number;
  scale: number;
  /** "original", "alternative:N", "truncated", "group" */
  used: string;
  truncated: boolean;
}

/** Rust's derived `PartialEq` of `TextLayout`. */
export function textLayoutEq(a: TextLayout, b: TextLayout): boolean {
  return (
    arrEq(a.lines, b.lines) &&
    arrEq(a.widths, b.widths) &&
    arrEq(a.baselines, b.baselines) &&
    a.xOffset === b.xOffset &&
    a.fontSize === b.fontSize &&
    a.scale === b.scale &&
    a.used === b.used &&
    a.truncated === b.truncated
  );
}

function arrEq<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const PartKind = { Text: 0, Icon: 1, Box: 2 } as const;
export type PartKind = (typeof PartKind)[keyof typeof PartKind];

const PART_NAMES = ["text", "icon", "box"] as const;

/** `PartKind::name`. */
export function partKindName(k: PartKind): string {
  return PART_NAMES[k];
}

/** A part of a composite label, relative to the label box's top-left corner. */
export interface PartLayout {
  kind: PartKind;
  rect: Rect;
  text: TextLayout | null;
}

/** One concrete label shape (spec §5.4). */
export class Variant {
  constructor(
    /** Box size including padding. */
    public w: number,
    public h: number,
    /** Degradation level: 0 = normal, k = created by ladder step k-1. */
    public level: number,
    /** Shape penalty (multiplied by `weights.shape`). */
    public penalty: number,
    public text: TextLayout | null,
    public parts: PartLayout[],
    public shape: LabelShape,
    /** Degradation steps this variant embodies (for `degrade_steps`). */
    public steps: string[],
    public scale: number,
  ) {}

  lines(): number {
    return this.text !== null ? this.text.lines.length : 1;
  }
}

const RECT_SHAPE: LabelShape = { kind: "rect" };

/** Build a text variant from lines. */
function textVariant(
  m: Measurer,
  spec: TextSpec,
  pad: number,
  scale: number,
  lines: string[],
  used: string,
  truncated: boolean,
): Variant {
  const [asc, desc, host] = m.vmetrics(spec.font, scale);
  // the box fits the ink: from the top of the first line's glyphs to the bottom of the last
  // line's, where their bounds are known and the font gives the vertical metrics (spec §5.2)
  const ink = (l: string | undefined): [number, number] | null =>
    l === undefined || host ? null : m.ink(spec.font, scale, l);
  const first = ink(lines[0]);
  const last = ink(lines[lines.length - 1]);
  const top = first !== null ? first[0] : asc;
  const bottom = last !== null ? last[1] : desc;
  const size = spec.font.size * scale;
  const pitch = spec.font.lineHeight * size;
  const widths = lines.map((l) => m.width(spec.font, scale, l));
  let wmax = 0;
  for (const w of widths) wmax = maxf(wmax, w);
  const n = lines.length > 1 ? lines.length : 1;
  const contentH = top + bottom + (n - 1) * pitch;
  const p = pad * scale;
  const baselines: number[] = [];
  for (let i = 0; i < n; i++) baselines.push(p + top + i * pitch);
  return new Variant(
    wmax + 2 * p,
    contentH + 2 * p,
    0,
    0,
    { lines, widths, baselines, xOffset: p, fontSize: size, scale, used, truncated },
    [],
    RECT_SHAPE,
    [],
    scale,
  );
}

function toWrapOpts(spec: TextSpec, scale: number): WrapOptions | null {
  const w = spec.wrap;
  if (w === null) return null;
  return {
    maxWidth: w.maxWidth !== null ? w.maxWidth * scale : null,
    maxLines: w.maxLines,
    balance: w.balance,
    truncate: spec.truncate,
  };
}

/**
 * The lines of a text broken by line feeds (hard breaks, spec §5.3; a `\r` before a line
 * feed is dropped), or `null` when it has none.
 */
function hardLines(text: string): string[] | null {
  if (!text.includes("\n")) return null;
  return text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Normal-level variants of one text (original or alternative). */
function textVariants(m: Measurer, spec: TextSpec, text: string, pad: number, scale: number, used: string): Variant[] {
  if (spec.explicit !== null) {
    const [w, h, lines] = spec.explicit;
    const p = pad * scale;
    const nl = lines.length > 1 ? lines.length : 1;
    const lineH = (h * scale) / nl;
    const baselines: number[] = [];
    for (let i = 0; i < nl; i++) baselines.push(p + lineH * (i + 0.8));
    return [
      new Variant(
        w * scale + 2 * p,
        h * scale + 2 * p,
        0,
        0,
        {
          lines: lines.slice(),
          widths: new Array<number>(nl).fill(w * scale),
          baselines,
          xOffset: p,
          fontSize: spec.font.size * scale,
          scale,
          used,
          truncated: false,
        },
        [],
        RECT_SHAPE,
        [],
        scale,
      ),
    ];
  }
  const hard = hardLines(text);
  // the author's lines: never wrapped or truncated
  if (hard !== null) return [textVariant(m, spec, pad, scale, hard, used, false)];
  const measure = (s: string): number => m.width(spec.font, scale, s);
  const opts = toWrapOpts(spec, scale);
  if (opts === null) return [textVariant(m, spec, pad, scale, [text], used, false)];
  return wrapVariants(text, opts, m.wrapMeasure(spec.font, scale, measure)).map((tv) => {
    const u = tv.truncated ? "truncated" : used;
    const v = textVariant(m, spec, pad, scale, tv.lines, u, tv.truncated);
    v.penalty += 0.25 * (v.lines() - 1) + (tv.truncated ? 1 : 0);
    if (v.lines() > 1) v.steps.push("wrap");
    if (tv.truncated) v.steps.push("truncate");
    return v;
  });
}

function sameLines(v: Variant, lines: readonly string[]): boolean {
  return v.text !== null && arrEq(v.text.lines, lines);
}

/** Narrowest line of a `wrap` step variant, in em of the label's font (spec §5.3). */
const MIN_WRAP_LINE_EM = 1.5;

/** Variants for the `wrap` ladder step. */
function extraWrap(
  m: Measurer,
  spec: TextSpec,
  text: string,
  pad: number,
  scale: number,
  used: string,
  wrapMaxLines: number,
): Variant[] {
  if (spec.explicit !== null || text.includes("\n")) return [];
  const width = (s: string): number => m.width(spec.font, scale, s);
  const measure = m.wrapMeasure(spec.font, scale, width);
  let normalMax: number;
  const w = spec.wrap;
  if (w !== null) {
    // lines beyond the normal variants, up to max_lines
    const opts = toWrapOpts(spec, scale)!;
    const normal = wrapVariants(text, opts, measure);
    let have = 1;
    if (normal.length > 0) {
      have = 0;
      for (const v of normal) if (v.lines.length > have) have = v.lines.length;
    }
    const out: Variant[] = [];
    for (let n = have + 1; n <= w.maxLines; n++) {
      const lines = balancedWrap(text, n, opts.maxWidth, measure);
      if (lines.length > have && !out.some((v) => sameLines(v, lines))) {
        const v = textVariant(m, spec, pad, scale, lines, used, false);
        v.penalty += 0.25 * (v.lines() - 1);
        v.steps.push("wrap");
        out.push(v);
      }
    }
    return out;
  } else normalMax = wrapMaxLines;
  // no line narrower than MIN_WRAP_LINE_EM: `France / 3` strands the 3 (spec §5.3)
  const minLine = MIN_WRAP_LINE_EM * spec.font.size * scale;
  return extraWrapVariants(text, normalMax, measure)
    .filter((tv) => tv.widths.every((w) => w >= minLine))
    .map((tv) => {
      const v = textVariant(m, spec, pad, scale, tv.lines, used, tv.truncated);
      v.penalty += 0.25 * (v.lines() - 1);
      v.steps.push("wrap");
      return v;
    });
}

/** Truncated single-line variants for the `truncate` ladder step. */
function truncated(m: Measurer, spec: TextSpec, text: string, pad: number, scale: number): Variant[] {
  if (spec.explicit !== null || text.includes("\n")) return [];
  const measure = (s: string): number => m.width(spec.font, scale, s);
  const full = measure(text);
  const mw = spec.wrap !== null ? spec.wrap.maxWidth : null;
  const target = mw !== null ? mw * scale : full * 0.6;
  if (target >= full) return [];
  const wrapMeasure = m.wrapMeasure(spec.font, scale, measure);
  const out: Variant[] = [];
  const candidates = [[truncateEnd(text, target, wrapMeasure)], truncateMiddle(text, target, 1, wrapMeasure)];
  for (const lines of candidates) {
    if (!out.some((v) => sameLines(v, lines))) {
      const v = textVariant(m, spec, pad, scale, lines, "truncated", true);
      v.penalty += 1;
      v.steps.push("truncate");
      out.push(v);
    }
  }
  return out;
}

function fixedVariant(kind: FixedKind, w: number, h: number, shape: LabelShape, pad: number, scale: number): Variant {
  const p = pad * scale;
  let s: LabelShape;
  switch (shape.kind) {
    case "polygon":
      s = { kind: "polygon", pts: shape.pts.map((q) => q.mul(scale).add(new P(p, p))) };
      break;
    case "rounded":
      s = { kind: "rounded", r: shape.r * scale };
      break;
    default:
      s = shape;
  }
  // The collision shape is relative to the padded box: a circle icon becomes the
  // circle inscribed in the box, a rounded box keeps its radius grown by the padding.
  if (s.kind === "rounded") s = { kind: "rounded", r: s.r + p };
  return new Variant(
    w * scale + 2 * p,
    h * scale + 2 * p,
    0,
    0,
    null,
    [{ kind: kind === FixedKind.Icon ? PartKind.Icon : PartKind.Box, rect: new Rect(p, p, p + w * scale, p + h * scale), text: null }],
    s,
    [],
    scale,
  );
}

function compositeVariant(
  m: Measurer,
  row: boolean,
  gap: number,
  align: string,
  parts: readonly PartSpec[],
  pad: number,
  scale: number,
): Variant {
  // measure parts
  const sizes: [number, number, [TextSpec, number] | null][] = [];
  for (const part of parts) {
    if (part.kind === "text") {
      const t = part.spec;
      const [asc, desc] = m.vmetrics(t.font, scale);
      const w = m.width(t.font, scale, t.text);
      sizes.push([w, asc + desc, [t, asc]]);
    } else sizes.push([part.w * scale, part.h * scale, null]);
  }
  const g = gap * scale;
  const p = pad * scale;
  let main = 0;
  let cross = 0;
  for (let i = 0; i < sizes.length; i++) {
    const [w, h] = sizes[i]!;
    const a = row ? w : h;
    const b = row ? h : w;
    main += a + (i > 0 ? g : 0);
    cross = maxf(cross, b);
  }
  const outParts: PartLayout[] = [];
  let cursor = 0;
  for (let i = 0; i < sizes.length; i++) {
    const [w, h, t] = sizes[i]!;
    const spec = parts[i]!;
    if (i > 0) cursor += g;
    const a = row ? w : h;
    const b = row ? h : w;
    const off = align === "start" ? 0 : align === "end" ? cross - b : (cross - b) * 0.5;
    const x = row ? p + cursor : p + off;
    const y = row ? p + off : p + cursor;
    const rect = new Rect(x, y, x + w, y + h);
    const text: TextLayout | null =
      t !== null
        ? {
            lines: [t[0].text],
            widths: [w],
            baselines: [y + t[1]],
            xOffset: x,
            fontSize: t[0].font.size * scale,
            scale,
            used: "original",
            truncated: false,
          }
        : null;
    const kind = spec.kind === "text" ? PartKind.Text : spec.fixed === FixedKind.Icon ? PartKind.Icon : PartKind.Box;
    outParts.push({ kind, rect, text });
    cursor += a;
  }
  const w = row ? main : cross;
  const h = row ? cross : main;
  return new Variant(w + 2 * p, h + 2 * p, 0, 0, null, outParts, RECT_SHAPE, [], scale);
}

/** Normal (level-0) variants of an item. */
export function baseVariants(m: Measurer, item: Item): Variant[] {
  return variantsAtScale(m, item, 1, false);
}

function variantsAtScale(m: Measurer, item: Item, scale: number, withAlternatives: boolean): Variant[] {
  const pad = item.len.padding;
  const label = item.label;
  switch (label.kind) {
    case "text": {
      const spec = label.spec;
      const v = textVariants(m, spec, spec.text, pad, scale, "original");
      if (withAlternatives) {
        spec.alternatives.forEach((alt, k) => {
          for (const a of textVariants(m, spec, alt, pad, scale, `alternative:${k}`)) {
            a.penalty += 0.5 * (k + 1);
            a.steps.unshift("alternatives");
            v.push(a);
          }
        });
      }
      return v;
    }
    case "fixed":
      return [fixedVariant(label.fixed, label.w, label.h, label.shape, pad, scale)];
    case "composite":
      return [compositeVariant(m, label.row, label.gap.px(item.em()), label.align, label.parts, pad, scale)];
  }
}

/** Variants added by one ladder step, given the variants that exist so far. */
export function ladderVariants(
  m: Measurer,
  item: Item,
  step: Step,
  existing: readonly Variant[],
  minScale: number,
  wrapMaxLines: number,
): Variant[] {
  const pad = item.len.padding;
  const dedup = (out: Variant[]): Variant[] => {
    const res: Variant[] = [];
    const isDup = (e: Variant, v: Variant): boolean =>
      e.text !== null && v.text !== null && textLayoutEq(e.text, v.text) && e.w === v.w && e.h === v.h;
    for (const v of out) {
      if (!existing.some((e) => isDup(e, v)) && !res.some((e) => isDup(e, v))) res.push(v);
    }
    return res;
  };
  const label = item.label;
  switch (step.kind) {
    case "alternatives": {
      if (label.kind !== "text") return [];
      const spec = label.spec;
      const out: Variant[] = [];
      spec.alternatives.forEach((alt, k) => {
        for (const a of textVariants(m, spec, alt, pad, 1, `alternative:${k}`)) {
          a.penalty += 0.5 * (k + 1);
          a.steps.unshift("alternatives");
          out.push(a);
        }
      });
      return dedup(out);
    }
    case "wrap": {
      if (label.kind !== "text") return [];
      const spec = label.spec;
      const out = extraWrap(m, spec, spec.text, pad, 1, "original", wrapMaxLines);
      spec.alternatives.forEach((alt, k) => {
        const used = `alternative:${k}`;
        if (existing.some((e) => e.text !== null && e.text.used === used)) {
          for (const a of extraWrap(m, spec, alt, pad, 1, used, wrapMaxLines)) {
            a.penalty += 0.5 * (k + 1);
            a.steps.unshift("alternatives");
            out.push(a);
          }
        }
      });
      return dedup(out);
    }
    case "truncate": {
      if (label.kind !== "text") return [];
      return dedup(truncated(m, label.spec, label.spec.text, pad, 1));
    }
    case "shrink": {
      const f = step.f;
      // never below minScale of the size before a smaller font class (spec §9.4)
      const floor = minScale / minf(item.classScale, 1);
      const out: Variant[] = [];
      let s = f;
      let k = 0;
      while (s >= floor - 1e-12 && s < 1 && k < 8) {
        for (const e of existing) {
          if (e.scale !== 1) continue;
          const v = rescale(m, item, e, s);
          if (v !== null) {
            v.penalty = e.penalty + 2 * (1 - s);
            v.steps = e.steps.slice();
            v.steps.push(`shrink:${trimFloat(s)}`);
            out.push(v);
          }
        }
        s *= f;
        k += 1;
      }
      return dedup(out);
    }
    default:
      return [];
  }
}

const TRIMMED = new Map<number, string>();

/** `format!("{:.4}")` without trailing zeros and point (memoized: few distinct scales). */
function trimFloat(x: number): string {
  let s = TRIMMED.get(x);
  if (s === undefined) {
    s = fmtFixed(x, 4).replace(/0+$/, "").replace(/\.$/, "");
    if (TRIMMED.size < 4096) TRIMMED.set(x, s);
  }
  return s;
}

/** The same variant at another font scale. */
function rescale(m: Measurer, item: Item, v: Variant, s: number): Variant | null {
  const pad = item.len.padding;
  const label = item.label;
  switch (label.kind) {
    case "text": {
      const t = v.text;
      if (t === null) return null;
      const spec = label.spec;
      if (spec.explicit !== null) return textVariants(m, spec, spec.text, pad, s, t.used)[0] ?? null;
      return textVariant(m, spec, pad, s, t.lines.slice(), t.used, t.truncated);
    }
    case "fixed":
      return fixedVariant(label.fixed, label.w, label.h, label.shape, pad, s);
    case "composite":
      return compositeVariant(m, label.row, label.gap.px(item.em()), label.align, label.parts, pad, s);
  }
}

/** Label area in em² of the first variant (priority term `label_size`). */
export function labelSizeEm2(item: Item, variants: readonly Variant[]): number {
  const em = item.em();
  const v = variants[0];
  return v !== undefined ? (v.w * v.h) / (em * em) : 0;
}
