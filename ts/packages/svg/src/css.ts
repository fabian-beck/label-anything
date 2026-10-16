// A small CSS parser for `<style>` elements and `style="…"` attributes. Mirrors css.rs.

import { type Complex, parseSelectorList } from "./selector.js";
import { SvgFailure } from "./error.js";
import { asciiLower } from "./num.js";

export interface Decl {
  /** Lowercased property name. */
  name: string;
  value: string;
  important: boolean;
}

export interface CssRule {
  selectors: Complex[];
  decls: Decl[];
}

function stripComments(s: string): string {
  let out = "";
  let i = 0;
  let run = 0;
  const n = s.length;
  while (i < n) {
    const x = s.charCodeAt(i);
    if (x === 0x22 || x === 0x27) {
      i++;
      while (i < n && s.charCodeAt(i) !== x) {
        if (s.charCodeAt(i) === 0x5c) i++;
        i++;
      }
      i = Math.min(i + 1, n);
    } else if (x === 0x2f && s.charCodeAt(i + 1) === 0x2a) {
      out += s.slice(run, i) + " ";
      const k = s.indexOf("*/", i + 2);
      i = k < 0 ? n : k + 2;
      run = i;
    } else i++;
  }
  return out + s.slice(run);
}

/** Index of the first target at nesting level 0 (outside strings, (), [] and {}), or s.length. */
function findTop(s: string, i: number, targets: string): number {
  let depth = 0;
  const n = s.length;
  while (i < n) {
    const x = s.charCodeAt(i);
    if (depth === 0 && targets.includes(s.charAt(i))) return i;
    if (x === 0x22 || x === 0x27) {
      i++;
      while (i < n && s.charCodeAt(i) !== x) {
        if (s.charCodeAt(i) === 0x5c) i++;
        i++;
      }
    } else if (x === 0x28 || x === 0x5b || x === 0x7b) depth++;
    else if (x === 0x29 || x === 0x5d || x === 0x7d) depth = depth > 0 ? depth - 1 : 0;
    i++;
  }
  return n;
}

/** Given `s[open] === '{'`, the index of the matching `}` (or s.length). */
function blockEnd(s: string, open: number): number {
  let depth = 0;
  let i = open;
  const n = s.length;
  while (i < n) {
    const x = s.charCodeAt(i);
    if (x === 0x22 || x === 0x27) {
      i++;
      while (i < n && s.charCodeAt(i) !== x) {
        if (s.charCodeAt(i) === 0x5c) i++;
        i++;
      }
    } else if (x === 0x7b) depth++;
    else if (x === 0x7d) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return n;
}

function isCssWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;
}

function trimCss(s: string): string {
  let a = 0;
  let e = s.length;
  while (a < e && isCssWs(s.charCodeAt(a))) a++;
  while (e > a && isCssWs(s.charCodeAt(e - 1))) e--;
  return s.slice(a, e);
}

/** Parses a style sheet; rules with invalid selectors are dropped. */
export function parseStylesheet(text: string): CssRule[] {
  const s = stripComments(text);
  const n = s.length;
  const rules: CssRule[] = [];
  let i = 0;
  for (;;) {
    while (i < n && isCssWs(s.charCodeAt(i))) i++;
    if (i >= n) break;
    if (s.startsWith("<!--", i)) {
      i += 4;
      continue;
    }
    if (s.startsWith("-->", i)) {
      i += 3;
      continue;
    }
    if (s.charCodeAt(i) === 0x40) {
      const k = findTop(s, i, ";{");
      if (k >= n) break;
      i = s.charCodeAt(k) === 0x3b ? k + 1 : blockEnd(s, k) + 1;
      continue;
    }
    const k = findTop(s, i, "{");
    if (k >= n) break;
    const end = blockEnd(s, k);
    const prelude = s.slice(i, k);
    const body = s.slice(k + 1, Math.min(end, n));
    try {
      const list = parseSelectorList(prelude, "css");
      const decls = parseDeclarations(body);
      if (decls.length > 0) rules.push({ selectors: list, decls });
    } catch (e) {
      if (!(e instanceof SvgFailure)) throw e;
    }
    i = end + 1;
  }
  return rules;
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** Parses a declaration list (`fill: red; stroke: blue !important`). */
export function parseDeclarations(text: string): Decl[] {
  if (text.includes("/*")) text = stripComments(text);
  const out: Decl[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const end = findTop(text, i, ";");
    const part = text.slice(i, end);
    i = end + 1;
    const colon = findTop(part, 0, ":");
    if (colon >= part.length) continue;
    const name = trimCss(part.slice(0, colon));
    if (name.length === 0 || !NAME.test(name)) continue;
    let value = trimCss(part.slice(colon + 1));
    let important = false;
    const bang = value.lastIndexOf("!");
    if (bang >= 0) {
      const tail = trimCss(value.slice(bang + 1));
      if (asciiLower(tail) === "important") {
        important = true;
        value = trimCss(value.slice(0, bang));
      }
    }
    if (value.length === 0) continue;
    out.push({ name: asciiLower(name), value, important });
  }
  return out;
}
