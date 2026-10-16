// The selector engine shared by class rules, `from_svg` marks and `<style>` sheets.
// Mirrors selector.rs.
//
//   list     = complex ("," complex)*
//   complex  = compound (combinator compound)*        combinator = ws+ | ws* ">" ws*
//   compound = (type | "*")? (".class" | "#id" | "[attr]" | "[attr=value]" | ":pseudo")*
//   pseudo   = small | background | filled | unfilled  (class rules and marks only)
//
// Matching is a dynamic program over the ancestor chain (linear in compounds × depth).

import { SvgFailure } from "./error.js";
import { asciiLower } from "./num.js";
import type { Element } from "./types.js";

/** `:small` threshold (bbox ≤ 16 px in both dimensions). */
export const SMALL_PX = 16;
/** `:background` threshold (bbox ≥ 90 % of the canvas in both dimensions). */
export const BACKGROUND_FRACTION = 0.9;
const MAX_COMPOUNDS = 64;

export type SelectorMode = "css" | "rules";
export type Pseudo = "small" | "background" | "filled" | "unfilled";

/**
 * Attribute value test: `=` exact, `^=` prefix, `$=` suffix, `*=` substring (as in CSS,
 * an empty value never matches with the last three). Mirrors `AttrOp`.
 */
export type AttrOp = "=" | "^=" | "$=" | "*=";

export interface AttrSel {
  name: string;
  /** `null` for `[attr]` (presence). */
  op: AttrOp | null;
  value: string | null;
}

export interface Compound {
  tag: string | null;
  ids: string[];
  classes: string[];
  attrs: AttrSel[];
  pseudos: Pseudo[];
}

export interface Complex {
  compounds: Compound[];
  /** `combinators[k]` joins compounds k and k + 1. */
  combinators: ("descendant" | "child")[];
  /** [ids, classes + attributes + pseudo-classes, types]. */
  specificity: [number, number, number];
}

/** A parsed selector list (opaque). */
export class Selector {
  /** @internal */
  constructor(readonly selectors: Complex[]) {}
}

function isWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;
}

function isIdentChar(b: number): boolean {
  return (
    (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x2d || b === 0x5f || b >= 0x80
  );
}

function isHex(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66);
}

function codePointLength(s: string, end: number): number {
  let n = 0;
  for (let i = 0; i < end && i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

class P {
  i = 0;
  constructor(
    readonly s: string,
    readonly mode: SelectorMode,
  ) {}

  err(msg: string): SvgFailure {
    const pos = codePointLength(this.s, this.i);
    return new SvgFailure("pattern", `invalid selector '${this.s}': ${msg} at position ${pos}`);
  }
  peek(): number {
    return this.i < this.s.length ? this.s.charCodeAt(this.i) : -1;
  }
  skipWs(): boolean {
    const start = this.i;
    while (this.i < this.s.length && isWs(this.s.charCodeAt(this.i))) this.i++;
    return this.i > start;
  }
  /** The code point at the cursor as a string, advancing past it. */
  takeChar(): string {
    const u = this.s.codePointAt(this.i)!;
    const ch = String.fromCodePoint(u);
    this.i += ch.length;
    return ch;
  }

  escape(): string {
    this.i++;
    if (this.i >= this.s.length) throw this.err("incomplete escape");
    const x = this.s.charCodeAt(this.i);
    if (isHex(x)) {
      const start = this.i;
      while (this.i < this.s.length && this.i - start < 6 && isHex(this.s.charCodeAt(this.i))) this.i++;
      let n = parseInt(this.s.slice(start, this.i), 16);
      if (n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) n = 0xfffd;
      if (this.i < this.s.length && isWs(this.s.charCodeAt(this.i))) this.i++;
      return String.fromCodePoint(n);
    }
    if (x === 0x0a || x === 0x0d || x === 0x0c) throw this.err("invalid escape");
    return this.takeChar();
  }

  word(extra: string): string {
    let out = "";
    for (;;) {
      const x = this.peek();
      if (x === -1) break;
      if (x === 0x5c) out += this.escape();
      else if (isIdentChar(x) || (x < 0x80 && extra.includes(String.fromCharCode(x)))) out += this.takeChar();
      else break;
    }
    return out;
  }

  list(): Complex[] {
    const out: Complex[] = [];
    for (;;) {
      this.skipWs();
      out.push(this.complex());
      this.skipWs();
      const x = this.peek();
      if (x === -1) return out;
      if (x === 0x2c) this.i++;
      else throw this.err("unexpected character");
    }
  }

  complex(): Complex {
    const compounds = [this.compound()];
    const combinators: ("descendant" | "child")[] = [];
    for (;;) {
      const hadWs = this.skipWs();
      const x = this.peek();
      if (x === -1 || x === 0x2c) break;
      if (x === 0x3e) {
        this.i++;
        this.skipWs();
        combinators.push("child");
      } else if (x === 0x2b || x === 0x7e) throw this.err("sibling combinators are not supported");
      else if (hadWs) combinators.push("descendant");
      else throw this.err("unexpected character");
      compounds.push(this.compound());
      if (compounds.length > MAX_COMPOUNDS) throw this.err("selector too long");
    }
    const spec: [number, number, number] = [0, 0, 0];
    for (const c of compounds) {
      spec[0] += c.ids.length;
      spec[1] += c.classes.length + c.attrs.length + c.pseudos.length;
      spec[2] += c.tag !== null ? 1 : 0;
    }
    return { compounds, combinators, specificity: spec };
  }

  compound(): Compound {
    const c: Compound = { tag: null, ids: [], classes: [], attrs: [], pseudos: [] };
    let any = false;
    const x0 = this.peek();
    if (x0 === 0x2a) {
      this.i++;
      any = true;
    } else if ((x0 >= 0x41 && x0 <= 0x5a) || (x0 >= 0x61 && x0 <= 0x7a) || x0 === 0x5f || x0 >= 0x80 || x0 === 0x5c) {
      c.tag = this.word("");
      any = true;
    }
    for (;;) {
      const x = this.peek();
      if (x === 0x2e) {
        this.i++;
        const w = this.word("");
        if (w.length === 0) throw this.err("expected a class name");
        c.classes.push(w);
      } else if (x === 0x23) {
        this.i++;
        const w = this.word("");
        if (w.length === 0) throw this.err("expected an id");
        c.ids.push(w);
      } else if (x === 0x5b) {
        this.i++;
        c.attrs.push(this.attr());
      } else if (x === 0x3a) {
        this.i++;
        c.pseudos.push(this.pseudo());
      } else break;
      any = true;
    }
    if (!any) throw this.err(this.peek() === -1 ? "expected a selector" : "unexpected character");
    return c;
  }

  attr(): AttrSel {
    this.skipWs();
    let name = "";
    for (;;) {
      name += this.word(":.");
      if (this.peek() === 0x7c && this.s.charCodeAt(this.i + 1) !== 0x3d && name.length > 0) {
        this.i++;
        name += ":";
        continue;
      }
      break;
    }
    if (name.length === 0) throw this.err("expected an attribute name");
    this.skipWs();
    const x = this.peek();
    if (x === 0x5d) {
      this.i++;
      return { name, op: null, value: null };
    }
    if (x === 0x3d || x === 0x5e || x === 0x24 || x === 0x2a) {
      const op: AttrOp = x === 0x3d ? "=" : x === 0x5e ? "^=" : x === 0x24 ? "$=" : "*=";
      this.i++;
      if (op !== "=") {
        if (this.peek() !== 0x3d) throw this.err("expected '=' after the attribute operator");
        this.i++;
      }
      this.skipWs();
      let value = "";
      const q = this.peek();
      if (q === 0x22 || q === 0x27) {
        this.i++;
        for (;;) {
          const y = this.peek();
          if (y === -1) throw this.err("unterminated string");
          if (y === q) {
            this.i++;
            break;
          }
          if (y === 0x5c) value += this.escape();
          else value += this.takeChar();
        }
      } else {
        for (;;) {
          const y = this.peek();
          if (y === -1 || isWs(y) || y === 0x5d || y === 0x22 || y === 0x27) break;
          if (y === 0x5c) value += this.escape();
          else value += this.takeChar();
        }
        if (value.length === 0) throw this.err("expected an attribute value");
      }
      this.skipWs();
      const z = this.peek();
      if (z === 0x5d) {
        this.i++;
        return { name, op, value };
      }
      if (z === -1) throw this.err("expected ']'");
      throw this.err("expected ']' (attribute flags are not supported)");
    }
    if (x === 0x7e || x === 0x7c) {
      throw this.err("only the '=', '^=', '$=' and '*=' attribute operators are supported");
    }
    if (x === -1) throw this.err("expected ']'");
    throw this.err("unexpected character in attribute selector");
  }

  pseudo(): Pseudo {
    if (this.peek() === 0x3a) throw this.err("pseudo-elements are not supported");
    const name = asciiLower(this.word(""));
    if (this.peek() === 0x28) throw this.err(`pseudo-class ':${name}()' is not supported`);
    let p: Pseudo;
    if (name === "small" || name === "background" || name === "filled" || name === "unfilled") p = name;
    else if (name === "") throw this.err("expected a pseudo-class name");
    else throw this.err(`unknown pseudo-class ':${name}'`);
    if (this.mode === "css") throw this.err(`':${name}' is not allowed in style sheets`);
    return p;
  }
}

/** Parses a selector list (throws SvgFailure with code `pattern`). */
export function parseSelectorList(s: string, mode: SelectorMode): Complex[] {
  const p = new P(s, mode);
  let blank = true;
  for (let i = 0; i < s.length; i++) {
    if (!isWs(s.charCodeAt(i))) {
      blank = false;
      break;
    }
  }
  if (blank) throw p.err("empty selector");
  return p.list();
}

export interface MatchContext {
  canvasWidth: number;
  canvasHeight: number;
}

const hasOwn = Object.prototype.hasOwnProperty;

export function attrOf(el: Element, name: string): string | undefined {
  return hasOwn.call(el.attributes, name) ? el.attributes[name] : undefined;
}

function compoundMatches(c: Compound, els: readonly Element[], i: number, ctx: MatchContext): boolean {
  const el = els[i]!;
  if (c.tag !== null && el.tag !== c.tag) return false;
  for (const id of c.ids) if (el.id !== id) return false;
  for (const cl of c.classes) if (!el.classes.includes(cl)) return false;
  for (const a of c.attrs) {
    const v = attrOf(el, a.name);
    if (v === undefined) return false;
    if (a.value !== null && !attrMatches(a.op, v, a.value)) return false;
  }
  for (const p of c.pseudos) {
    const b = el.bbox;
    let ok: boolean;
    switch (p) {
      case "small":
        ok = b !== null && b.w <= SMALL_PX && b.h <= SMALL_PX;
        break;
      case "background":
        ok = b !== null && b.w >= BACKGROUND_FRACTION * ctx.canvasWidth && b.h >= BACKGROUND_FRACTION * ctx.canvasHeight;
        break;
      case "filled":
        ok = el.filled;
        break;
      case "unfilled":
        ok = !el.filled;
        break;
    }
    if (!ok) return false;
  }
  return true;
}

export function complexMatches(sel: Complex, els: readonly Element[], i: number, ctx: MatchContext): boolean {
  const m = sel.compounds.length;
  if (!compoundMatches(sel.compounds[m - 1]!, els, i, ctx)) return false;
  if (m === 1) return true;
  const chain = [i];
  let p = els[i]!.parent;
  while (p !== null) {
    chain.push(p);
    p = els[p]!.parent;
  }
  const l = chain.length;
  let reach: boolean[] = new Array<boolean>(l).fill(false);
  reach[0] = true;
  let next: boolean[] = new Array<boolean>(l).fill(false);
  for (let k = m - 2; k >= 0; k--) {
    const comb = sel.combinators[k];
    let anyBefore = reach[0]!;
    let found = false;
    next[0] = false;
    for (let d = 1; d < l; d++) {
      const ok = comb === "child" ? reach[d - 1]! : anyBefore;
      next[d] = ok && compoundMatches(sel.compounds[k]!, els, chain[d]!, ctx);
      if (next[d]) found = true;
      anyBefore = anyBefore || reach[d]!;
    }
    if (!found) return false;
    const t = reach;
    reach = next;
    next = t;
  }
  return true;
}

export function selectorMatches(sel: Selector, els: readonly Element[], i: number, ctx: MatchContext): boolean {
  for (const c of sel.selectors) if (complexMatches(c, els, i, ctx)) return true;
  return false;
}

/** Whether attribute value `v` passes the test `op want` (see {@link AttrOp}). */
function attrMatches(op: AttrOp | null, v: string, want: string): boolean {
  switch (op) {
    case "^=":
      return want.length > 0 && v.startsWith(want);
    case "$=":
      return want.length > 0 && v.endsWith(want);
    case "*=":
      return want.length > 0 && v.includes(want);
    default:
      return v === want;
  }
}
