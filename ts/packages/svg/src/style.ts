// Style properties, the cascade and computed values. Mirrors style.rs.
// Cascade: presentation attributes < <style> rules (specificity, order) < inline style <
// !important rules < inline !important. Invalid values are dropped at cascade time.

import { type PaintSpec, parseAlpha, parsePaint, trimAscii } from "./color.js";
import type { Decl } from "./css.js";
import { CM, IN, type Length, MM, PC, PT, asciiLower, parseLength, parseNumber, px } from "./num.js";

/** A specified value: "inherit", "initial" or a value. */
export type Spec<T> = { s: "inherit" } | { s: "initial" } | { s: "val"; v: T };

const INHERIT = { s: "inherit" } as const;
const INITIAL = { s: "initial" } as const;

export type FontSize = { k: "abs"; v: number } | { k: "rel"; v: number } | { k: "larger" } | { k: "smaller" };
export type FontWeight = { k: "abs"; v: number } | { k: "bolder" } | { k: "lighter" };
export type Anchor = "start" | "middle" | "end";
export type Baseline = "alphabetic" | "middle" | "hanging" | "bottom";

export interface Specified {
  fill?: Spec<number | null>;
  fill_opacity?: Spec<number>;
  even_odd?: Spec<boolean>;
  stroke?: Spec<number | null>;
  stroke_opacity?: Spec<number>;
  stroke_width?: Spec<Length>;
  opacity?: Spec<number>;
  display_none?: Spec<boolean>;
  visible?: Spec<boolean>;
  font_size?: Spec<FontSize>;
  font_family?: Spec<string>;
  font_weight?: Spec<FontWeight>;
  anchor?: Spec<Anchor>;
  baseline?: Spec<Baseline>;
  non_scaling?: Spec<boolean>;
}

export interface Computed {
  fill: number | null;
  fill_opacity: number;
  even_odd: boolean;
  stroke: number | null;
  stroke_opacity: number;
  stroke_width: Length;
  opacity: number;
  display_none: boolean;
  visible: boolean;
  font_size: number;
  font_family: string;
  font_weight: number;
  anchor: Anchor;
  baseline: Baseline;
  non_scaling: boolean;
  preserve_space: boolean;
}

export const DEFAULT_FONT_SIZE = 16;
export const DEFAULT_FONT_FAMILY = "sans-serif";

export function initialStyle(): Computed {
  return {
    fill: 1,
    fill_opacity: 1,
    even_odd: false,
    stroke: null,
    stroke_opacity: 1,
    stroke_width: px(1),
    opacity: 1,
    display_none: false,
    visible: true,
    font_size: DEFAULT_FONT_SIZE,
    font_family: DEFAULT_FONT_FAMILY,
    font_weight: 400,
    anchor: "start",
    baseline: "alphabetic",
    non_scaling: false,
    preserve_space: false,
  };
}

/** Fill paint ≠ none with alpha × fill-opacity > 0. */
export function isFilled(c: Computed): boolean {
  return c.fill !== null && c.fill * c.fill_opacity > 0;
}

/** Stroke paint ≠ none with alpha × stroke-opacity > 0 and stroke-width > 0. */
export function isStroked(c: Computed): boolean {
  return c.stroke !== null && c.stroke * c.stroke_opacity > 0 && c.stroke_width.v > 0;
}

function bolder(w: number): number {
  if (w < 350) return 400;
  if (w < 550) return 700;
  if (w < 900) return 900;
  return w;
}

function lighter(w: number): number {
  if (w < 100) return w;
  if (w < 550) return 100;
  if (w < 750) return 400;
  return 700;
}

function inh<T>(s: Spec<T> | undefined, parent: T, initial: T): T {
  if (s === undefined || s.s === "inherit") return parent;
  if (s.s === "initial") return initial;
  return s.v;
}

function nonInh<T>(s: Spec<T> | undefined, parent: T, initial: T): T {
  if (s === undefined || s.s === "initial") return initial;
  if (s.s === "inherit") return parent;
  return s.v;
}

/** Shared result of a cascade that applied nothing. */
export const EMPTY_SPECIFIED: Specified = Object.freeze({});

/** Computes an element's style from its specified values and its parent's style. */
export function compute(s: Specified, p: Computed, xmlSpace: boolean | null): Computed {
  // Nothing specified and the parent's non-inherited properties are initial: identical.
  if (s === EMPTY_SPECIFIED && xmlSpace === null && p.opacity === 1 && !p.display_none && !p.non_scaling) return p;
  let fontSize: number;
  const fs = s.font_size;
  if (fs === undefined || fs.s === "inherit") fontSize = p.font_size;
  else if (fs.s === "initial") fontSize = DEFAULT_FONT_SIZE;
  else {
    const v = fs.v;
    if (v.k === "abs") fontSize = v.v;
    else if (v.k === "rel") fontSize = v.v * p.font_size;
    else if (v.k === "larger") fontSize = p.font_size * 1.2;
    else fontSize = p.font_size / 1.2;
  }
  let fontWeight: number;
  const fw = s.font_weight;
  if (fw === undefined || fw.s === "inherit") fontWeight = p.font_weight;
  else if (fw.s === "initial") fontWeight = 400;
  else if (fw.v.k === "abs") fontWeight = fw.v.v;
  else if (fw.v.k === "bolder") fontWeight = bolder(p.font_weight);
  else fontWeight = lighter(p.font_weight);
  return {
    fill: inh(s.fill, p.fill, 1),
    fill_opacity: inh(s.fill_opacity, p.fill_opacity, 1),
    even_odd: inh(s.even_odd, p.even_odd, false),
    stroke: inh(s.stroke, p.stroke, null),
    stroke_opacity: inh(s.stroke_opacity, p.stroke_opacity, 1),
    stroke_width: inh(s.stroke_width, p.stroke_width, px(1)),
    opacity: nonInh(s.opacity, p.opacity, 1),
    display_none: nonInh(s.display_none, p.display_none, false),
    visible: inh(s.visible, p.visible, true),
    font_size: fontSize,
    font_family: inh(s.font_family, p.font_family, DEFAULT_FONT_FAMILY),
    font_weight: fontWeight,
    anchor: inh(s.anchor, p.anchor, "start"),
    baseline: inh(s.baseline, p.baseline, "alphabetic"),
    non_scaling: nonInh(s.non_scaling, p.non_scaling, false),
    preserve_space: xmlSpace === null ? p.preserve_space : xmlSpace,
  };
}

const PRESENTATION = new Set([
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-opacity",
  "stroke-width",
  "opacity",
  "display",
  "visibility",
  "font-size",
  "font-family",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "vector-effect",
]);

const SIZE_KEYWORDS: Record<string, number> = {
  "xx-small": 9,
  "x-small": 10,
  small: 13,
  medium: 16,
  large: 18,
  "x-large": 24,
  "xx-large": 32,
  "xxx-large": 48,
};

const hasOwn = Object.prototype.hasOwnProperty;

function parseFontSize(v: string): FontSize | null {
  const lower = asciiLower(v);
  if (lower === "larger") return { k: "larger" };
  if (lower === "smaller") return { k: "smaller" };
  if (hasOwn.call(SIZE_KEYWORDS, lower)) return { k: "abs", v: SIZE_KEYWORDS[lower]! };
  const l = parseLength(v);
  if (l === null || l.v < 0) return null;
  switch (l.unit) {
    case "":
    case "px":
      return { k: "abs", v: l.v };
    case "pt":
      return { k: "abs", v: l.v * PT };
    case "pc":
      return { k: "abs", v: l.v * PC };
    case "in":
      return { k: "abs", v: l.v * IN };
    case "cm":
      return { k: "abs", v: l.v * CM };
    case "mm":
      return { k: "abs", v: l.v * MM };
    case "rem":
      return { k: "abs", v: l.v * 16 };
    case "em":
      return { k: "rel", v: l.v };
    case "ex":
      return { k: "rel", v: l.v / 2 };
    case "%":
      return { k: "rel", v: l.v / 100 };
  }
}

function parseFontWeight(v: string): FontWeight | null {
  switch (asciiLower(v)) {
    case "normal":
      return { k: "abs", v: 400 };
    case "bold":
      return { k: "abs", v: 700 };
    case "bolder":
      return { k: "bolder" };
    case "lighter":
      return { k: "lighter" };
  }
  const n = parseNumber(v);
  if (n === null || n < 1 || n > 1000) return null;
  return { k: "abs", v: Math.floor(n + 0.5) };
}

const KEYWORD = /^[A-Za-z0-9-]+$/;
const ASCII_WS = /[ \t\n\r\f]/;

const FONT_SKIP = new Set([
  "normal",
  "italic",
  "oblique",
  "small-caps",
  "ultra-condensed",
  "extra-condensed",
  "condensed",
  "semi-condensed",
  "semi-expanded",
  "expanded",
  "extra-expanded",
  "ultra-expanded",
]);
const SYSTEM_FONTS = new Set(["caption", "icon", "menu", "message-box", "small-caption", "status-bar"]);

function firstWsIndex(s: string): number {
  const m = ASCII_WS.exec(s);
  return m === null ? s.length : m.index;
}

function trimStartAscii(s: string): string {
  return s.replace(/^[ \t\n\r\f]+/, "");
}

/** The CSS `font` shorthand. */
function parseFont(v: string): [FontSize, string, FontWeight] | null {
  let weight: FontWeight = { k: "abs", v: 400 };
  let rest = trimAscii(v);
  for (;;) {
    const end = firstWsIndex(rest);
    const tok = rest.slice(0, end);
    const lower = asciiLower(tok);
    let consumed = false;
    if (FONT_SKIP.has(lower)) consumed = true;
    else if (lower === "bold" || lower === "bolder" || lower === "lighter") {
      const w = parseFontWeight(lower);
      if (w === null) return null;
      weight = w;
      consumed = true;
    } else if (SYSTEM_FONTS.has(lower)) return null;
    else {
      const n = parseNumber(tok);
      if (n !== null && n >= 1 && n <= 1000 && !tok.includes("%")) {
        weight = { k: "abs", v: Math.floor(n + 0.5) };
        consumed = true;
      }
    }
    if (!consumed) break;
    rest = trimStartAscii(rest.slice(end));
    if (rest.length === 0) return null;
  }
  const end = firstWsIndex(rest);
  const tok = rest.slice(0, end);
  const sizeTok = tok.split("/")[0]!;
  const size = parseFontSize(sizeTok);
  if (size === null) return null;
  let after = trimStartAscii(rest.slice(end));
  if (!tok.includes("/") && after.startsWith("/")) {
    after = trimStartAscii(after.slice(1));
    const e = firstWsIndex(after);
    after = trimStartAscii(after.slice(e));
  }
  const family = trimAscii(after);
  if (family.length === 0) return null;
  return [size, family, weight];
}

function parseBaseline(x: string): Baseline | null {
  switch (asciiLower(x)) {
    case "auto":
    case "alphabetic":
    case "use-script":
    case "no-change":
    case "reset-size":
      return "alphabetic";
    case "middle":
    case "central":
    case "mathematical":
      return "middle";
    case "hanging":
    case "text-top":
    case "text-before-edge":
      return "hanging";
    case "ideographic":
    case "text-bottom":
    case "text-after-edge":
      return "bottom";
    default:
      return null;
  }
}

/** Assigns the parsed value (CSS-wide keywords handled), if valid. */
function set<T>(v: string, inherited: boolean, parse: (x: string) => T | null, assign: (spec: Spec<T>) => void): void {
  const lower = asciiLower(v);
  if (lower === "inherit") assign(INHERIT);
  else if (lower === "initial") assign(INITIAL);
  else if (lower === "unset") assign(inherited ? INHERIT : INITIAL);
  else {
    const x = parse(v);
    if (x !== null) assign({ s: "val", v: x });
  }
}

function resolvePaint(p: PaintSpec, urlExists: (id: string) => boolean): number | null {
  if (p.k === "none") return null;
  if (p.k === "color") return p.alpha;
  if (p.id !== null && urlExists(p.id)) return 1;
  return p.fallback === null ? null : resolvePaint(p.fallback, urlExists);
}

const PAINT_INVALID = -1;

/** Per-document cascade state: id lookup for `url(#…)` paints and a paint cache. */
export interface CascadeContext {
  urlExists: (id: string) => boolean;
  /** Resolved paint specs by source text: alpha, null (no paint) or PAINT_INVALID. */
  paints: Map<string, Spec<number | null> | number>;
}

function paintSpec(v: string, ctx: CascadeContext): Spec<number | null> | null {
  const hit = ctx.paints.get(v);
  if (hit !== undefined) return hit === PAINT_INVALID ? null : (hit as Spec<number | null>);
  const p = parsePaint(v);
  if (p === null) {
    ctx.paints.set(v, PAINT_INVALID);
    return null;
  }
  const spec: Spec<number | null> = { s: "val", v: resolvePaint(p, ctx.urlExists) };
  ctx.paints.set(v, spec);
  return spec;
}

/** Applies one declaration (`allowShorthand`: CSS only, not presentation attributes). */
export function applyDecl(s: Specified, name: string, value: string, allowShorthand: boolean, ctx: CascadeContext): void {
  const v = trimAscii(value);
  if (v.length === 0) return;
  switch (name) {
    case "fill":
    case "stroke": {
      const lower = asciiLower(v);
      if (lower === "inherit" || lower === "unset") s[name] = INHERIT;
      else if (lower === "initial") s[name] = INITIAL;
      else {
        const spec = paintSpec(v, ctx);
        if (spec !== null) s[name] = spec;
      }
      return;
    }
    case "fill-opacity":
      return set(v, true, parseAlpha, (x) => (s.fill_opacity = x));
    case "stroke-opacity":
      return set(v, true, parseAlpha, (x) => (s.stroke_opacity = x));
    case "opacity":
      return set(v, false, parseAlpha, (x) => (s.opacity = x));
    case "fill-rule":
      return set(
        v,
        true,
        (x) => {
          const l = asciiLower(x);
          return l === "nonzero" ? false : l === "evenodd" ? true : null;
        },
        (x) => (s.even_odd = x),
      );
    case "stroke-width":
      return set(
        v,
        true,
        (x) => {
          const l = parseLength(x);
          return l !== null && l.v >= 0 ? l : null;
        },
        (x) => (s.stroke_width = x),
      );
    case "display":
      return set(
        v,
        false,
        (x) => {
          const l = asciiLower(x);
          return l === "none" ? true : KEYWORD.test(l) ? false : null;
        },
        (x) => (s.display_none = x),
      );
    case "visibility":
      return set(
        v,
        true,
        (x) => {
          const l = asciiLower(x);
          return l === "visible" ? true : l === "hidden" || l === "collapse" ? false : null;
        },
        (x) => (s.visible = x),
      );
    case "font-size":
      return set(v, true, parseFontSize, (x) => (s.font_size = x));
    case "font-family":
      return set(v, true, (x) => x, (x) => (s.font_family = x));
    case "font-weight":
      return set(v, true, parseFontWeight, (x) => (s.font_weight = x));
    case "text-anchor":
      return set(
        v,
        true,
        (x): Anchor | null => {
          const l = asciiLower(x);
          return l === "start" || l === "middle" || l === "end" ? l : null;
        },
        (x) => (s.anchor = x),
      );
    case "dominant-baseline":
      return set(v, true, parseBaseline, (x) => (s.baseline = x));
    case "vector-effect":
      return set(
        v,
        false,
        (x) => {
          const l = asciiLower(x);
          return l === "non-scaling-stroke" ? true : KEYWORD.test(l) ? false : null;
        },
        (x) => (s.non_scaling = x),
      );
    case "font": {
      if (!allowShorthand) return;
      const lower = asciiLower(v);
      if (lower === "inherit" || lower === "unset") {
        s.font_size = INHERIT;
        s.font_family = INHERIT;
        s.font_weight = INHERIT;
      } else if (lower === "initial") {
        s.font_size = INITIAL;
        s.font_family = INITIAL;
        s.font_weight = INITIAL;
      } else {
        const f = parseFont(v);
        if (f !== null) {
          s.font_size = { s: "val", v: f[0] };
          s.font_family = { s: "val", v: f[1] };
          s.font_weight = { s: "val", v: f[2] };
        }
      }
      return;
    }
  }
}

/** The cascade for one element. */
/**
 * The cascade for one element. `attrs` = `[qname0, value0, …]`; presentation attributes are
 * the unprefixed ones (prefixed names contain ':' and never match).
 */
export function cascade(
  attrs: readonly string[],
  css: readonly (readonly Decl[])[],
  inline: readonly Decl[],
  ctx: CascadeContext,
): Specified {
  const s: Specified = {};
  let any = false;
  for (let k = 0; k < attrs.length; k += 2) {
    const q = attrs[k]!;
    if (PRESENTATION.has(q)) {
      applyDecl(s, q, attrs[k + 1]!, false, ctx);
      any = true;
    }
  }
  if (!any && css.length === 0 && inline.length === 0) return EMPTY_SPECIFIED;
  for (const decls of css) for (const d of decls) if (!d.important) applyDecl(s, d.name, d.value, true, ctx);
  for (const d of inline) if (!d.important) applyDecl(s, d.name, d.value, true, ctx);
  for (const decls of css) for (const d of decls) if (d.important) applyDecl(s, d.name, d.value, true, ctx);
  for (const d of inline) if (d.important) applyDecl(s, d.name, d.value, true, ctx);
  for (const _ in s) return s;
  return EMPTY_SPECIFIED;
}

/** The first family of a `font-family` list, unquoted. */
export function firstFamily(list: string): string {
  const t = trimAscii(list);
  let first: string;
  const q = t.charAt(0);
  if (q === '"' || q === "'") {
    const k = t.indexOf(q, 1);
    first = k < 0 ? t.slice(1) : t.slice(1, k);
  } else {
    const k = t.indexOf(",");
    first = k < 0 ? t : t.slice(0, k);
  }
  const f = trimAscii(first);
  return f.length === 0 ? DEFAULT_FONT_FAMILY : f;
}
