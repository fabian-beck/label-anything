// A small, iterative XML 1.0 parser with namespaces and internal DTD entities.
// Line-by-line mirror of rust/crates/la-svg/src/xml.rs (acceptance rules follow roxmltree,
// which the Rust tests use as an oracle). Works on any JS string; no DOMParser needed.

import { SvgFailure, fail } from "./error.js";

export const NS_SVG = "http://www.w3.org/2000/svg";
export const NS_XLINK = "http://www.w3.org/1999/xlink";
export const NS_XML = "http://www.w3.org/XML/1998/namespace";
const NS_XMLNS = "http://www.w3.org/2000/xmlns/";

/** Maximum element nesting depth (the root element has depth 1). */
export const MAX_DEPTH = 1024;
/** Maximum number of elements in a document. */
export const MAX_ELEMENTS = 1_000_000;
const MAX_ENTITY_DEPTH = 10;
const MAX_ENTITY_REFS = 255;

/** A child: an element index or character data. */
export type XmlNode = number | string;

/**
 * An element. Attributes (namespace declarations excluded) are stored compactly as
 * `attrs = [qname0, value0, qname1, value1, …]` (qualified names as written, values
 * normalized) and `attrNs[k]` = namespace index of attribute k, or `attrNs = null` when no
 * attribute has a namespace. Namespaced attributes always have a prefix, so an unprefixed
 * name can be looked up by comparing qualified names.
 */
export interface XmlElement {
  qname: string;
  local: number;
  ns: number | null;
  attrs: string[];
  attrNs: (number | null)[] | null;
  parent: number | null;
  children: XmlNode[];
}

/** Local name of a qualified name. */
export function localOf(qname: string): string {
  const k = qname.indexOf(":");
  return k < 0 ? qname : qname.slice(k + 1);
}

/** An unprefixed attribute's value. */
export function plainAttr(e: XmlElement, name: string): string | undefined {
  const a = e.attrs;
  for (let k = 0; k < a.length; k += 2) if (a[k] === name) return a[k + 1];
  return undefined;
}

export interface XmlDoc {
  elements: XmlElement[];
  /** Interned namespace URIs; index 0 is the XML namespace. */
  namespaces: string[];
}

export function localName(e: { qname: string; local: number }): string {
  return e.local === 0 ? e.qname : e.qname.slice(e.local);
}

// ---------------------------------------------------------------------------------------
// Characters

function isWs(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
}

function isXmlChar(u: number): boolean {
  if (u < 0x20) return u === 0x9 || u === 0xa || u === 0xd;
  return u <= 0xd7ff || (u >= 0xe000 && u <= 0xfffd) || (u >= 0x10000 && u <= 0x10ffff);
}

function isAsciiNameStart(b: number): boolean {
  return (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b === 0x3a || b === 0x5f;
}

function isAsciiNameChar(b: number): boolean {
  return isAsciiNameStart(b) || (b >= 0x30 && b <= 0x39) || b === 0x2d || b === 0x2e;
}

function isNameStart(u: number): boolean {
  if (u < 128) return isAsciiNameStart(u);
  return (
    (u >= 0xc0 && u <= 0xd6) || (u >= 0xd8 && u <= 0xf6) || (u >= 0xf8 && u <= 0x2ff) ||
    (u >= 0x370 && u <= 0x37d) || (u >= 0x37f && u <= 0x1fff) || (u >= 0x200c && u <= 0x200d) ||
    (u >= 0x2070 && u <= 0x218f) || (u >= 0x2c00 && u <= 0x2fef) || (u >= 0x3001 && u <= 0xd7ff) ||
    (u >= 0xf900 && u <= 0xfdcf) || (u >= 0xfdf0 && u <= 0xfffd) || (u >= 0x10000 && u <= 0xeffff)
  );
}

function isNameChar(u: number): boolean {
  if (u < 128) return isAsciiNameChar(u);
  return (
    u === 0xb7 || (u >= 0xc0 && u <= 0xd6) || (u >= 0xd8 && u <= 0xf6) || (u >= 0xf8 && u <= 0x2ff) ||
    (u >= 0x300 && u <= 0x36f) || (u >= 0x370 && u <= 0x37d) || (u >= 0x37f && u <= 0x1fff) ||
    (u >= 0x200c && u <= 0x200d) || (u >= 0x203f && u <= 0x2040) || (u >= 0x2070 && u <= 0x218f) ||
    (u >= 0x2c00 && u <= 0x2fef) || (u >= 0x3001 && u <= 0xd7ff) || (u >= 0xf900 && u <= 0xfdcf) ||
    (u >= 0xfdf0 && u <= 0xfffd) || (u >= 0x10000 && u <= 0xeffff)
  );
}

/** 1-based line and column (in code points) of offset `pos`. */
function lineCol(s: string, pos: number): [number, number] {
  const p = Math.min(pos, s.length);
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < p; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      line++;
      lineStart = i + 1;
    }
  }
  let col = 1;
  for (let i = lineStart; i < p; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < p) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    col++;
  }
  return [line, col];
}

function errAt(s: string, pos: number, msg: string): SvgFailure {
  const [line, col] = lineCol(s, pos);
  return new SvgFailure("parse", `XML: ${msg} at line ${line}, column ${col}`);
}

/** Checks that `s[start..end]` contains only XML characters. */
function checkChars(s: string, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c < 0xd800) continue;
    if (c < 0x20) {
      if (!isWs(c)) throw errAt(s, i, "a non-XML character");
      continue;
    }
    if (c <= 0xdbff) {
      const d = i + 1 < end ? s.charCodeAt(i + 1) : 0;
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      throw errAt(s, i, "a non-XML character");
    }
    if (c <= 0xdfff || c > 0xfffd) throw errAt(s, i, "a non-XML character");
  }
}

// ---------------------------------------------------------------------------------------
// Cursor and builder

class Cursor {
  /** Local-part offset of the last qualified name read. */
  qlocal = 0;
  constructor(
    readonly s: string,
    public pos: number,
  ) {}
  atEnd(): boolean {
    return this.pos >= this.s.length;
  }
  /** The code unit at the cursor, or -1 at the end. */
  peek(): number {
    return this.pos < this.s.length ? this.s.charCodeAt(this.pos) : -1;
  }
  peekAt(k: number): number {
    const p = this.pos + k;
    return p < this.s.length ? this.s.charCodeAt(p) : -1;
  }
  startsWith(p: string): boolean {
    return this.s.startsWith(p, this.pos);
  }
  skipWs(): boolean {
    const start = this.pos;
    const s = this.s;
    while (this.pos < s.length && isWs(s.charCodeAt(this.pos))) this.pos++;
    return this.pos > start;
  }
  consumeWs(): void {
    if (this.atEnd()) throw this.err("unexpected end of input");
    if (!this.skipWs()) throw this.err("expected whitespace");
  }
  expect(b: number, what: string): void {
    if (this.peek() === b) {
      this.pos++;
      return;
    }
    if (this.atEnd()) throw this.err("unexpected end of input");
    throw this.err(`expected ${what}`);
  }
  err(msg: string): SvgFailure {
    return errAt(this.s, this.pos, msg);
  }
  errFrom(pos: number, msg: string): SvgFailure {
    return errAt(this.s, pos, msg);
  }
  /** The code point at the cursor, or -1. */
  nextChar(): number {
    const u = this.s.codePointAt(this.pos);
    return u === undefined ? -1 : u;
  }
}

class Builder {
  elements: XmlElement[] = [];
  namespaces: string[] = [NS_XML];
  /** Namespace bindings in scope: [prefix (null = default namespace), namespace]. */
  scopes: [string | null, number][] = [];
  /** Open elements, and `scopes.length` before each one's declarations. */
  stack: number[] = [];
  stackScopes: number[] = [];
  /** Scratch: raw attribute names and [local, value start, value end, start] per attribute. */
  rawQ: string[] = [];
  rawN: number[] = [];
  entities: [string, string][] = [];
  textOpen = false;
  refDepth = 0;
  refCount = 0;

  intern(uri: string): number {
    const i = this.namespaces.indexOf(uri);
    if (i >= 0) return i;
    this.namespaces.push(uri);
    return this.namespaces.length - 1;
  }

  /** undefined = unbound prefix; null = no namespace. */
  resolve(prefix: string | null): number | null | undefined {
    if (prefix === "xml") return 0;
    for (let k = this.scopes.length - 1; k >= 0; k--) {
      if (this.scopes[k]![0] === prefix) return this.scopes[k]![1];
    }
    return prefix === null ? null : undefined;
  }

  entity(name: string): string | undefined {
    for (const [n, v] of this.entities) if (n === name) return v;
    return undefined;
  }

  enterEntity(c: Cursor, pos: number): void {
    if (this.refDepth > 0) {
      if (this.refCount === MAX_ENTITY_REFS) throw c.errFrom(pos, "entity reference loop");
      this.refCount++;
    }
    if (this.refDepth < MAX_ENTITY_DEPTH) this.refDepth++;
    else throw c.errFrom(pos, "entity reference loop");
  }

  leaveEntity(): void {
    if (this.refDepth > 0) this.refDepth--;
    if (this.refDepth === 0) this.refCount = 0;
  }

  appendText(text: string): void {
    if (text.length === 0) return;
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) return;
    const el = this.elements[top]!;
    const children = el.children;
    if (this.textOpen && children.length > 0) {
      const last = children[children.length - 1];
      if (typeof last === "string") {
        children[children.length - 1] = last + text;
        return;
      }
    }
    pushChild(el, text);
    this.textOpen = true;
  }
}

// ---------------------------------------------------------------------------------------
// Prolog

/** Parses `input` into an `XmlDoc` (throws `SvgFailure`). */
export function parseXml(input: string): XmlDoc {
  const c = new Cursor(input, 0);
  if (input.charCodeAt(0) === 0xfeff) c.pos = 1;
  const b = new Builder();
  parseDeclaration(c);
  parseMisc(c);
  c.skipWs();
  if (c.startsWith("<!DOCTYPE")) {
    parseDoctype(c, b);
    parseMisc(c);
  }
  c.skipWs();
  if (c.atEnd()) fail("parse", "XML: the document has no root element");
  const n1 = c.peekAt(1);
  if (c.peek() !== 0x3c || n1 === 0x21 || n1 === 0x3f || n1 === 0x2f) {
    throw c.err("unexpected content before the root element");
  }
  parseStartTag(c, b);
  if (b.stack.length > 0) parseContent(c, b, 0, false);
  parseMisc(c);
  if (!c.atEnd()) throw c.err("unexpected content after the root element");
  return { elements: b.elements, namespaces: b.namespaces };
}

function parseDeclaration(c: Cursor): void {
  if (!c.startsWith("<?xml ")) return;
  c.pos += 5;
  declWs(c);
  if (!c.startsWith("version")) throw c.err("expected 'version'");
  parsePseudoAttr(c);
  declWs(c);
  if (c.startsWith("encoding")) {
    parsePseudoAttr(c);
    declWs(c);
  }
  if (c.startsWith("standalone")) parsePseudoAttr(c);
  c.skipWs();
  if (!c.startsWith("?>")) throw c.err("expected '?>'");
  c.pos += 2;
}

function declWs(c: Cursor): void {
  if (!c.skipWs() && !c.startsWith("?>") && !c.atEnd()) throw c.err("expected whitespace");
}

function parsePseudoAttr(c: Cursor): void {
  consumeQname(c);
  // (the name itself is not checked further, as in roxmltree)
  c.skipWs();
  c.expect(0x3d, "'='");
  c.skipWs();
  const q = c.peek();
  if (q === -1) throw c.err("unexpected end of input");
  if (q !== 0x22 && q !== 0x27) throw c.err("expected a quote");
  c.pos++;
  for (;;) {
    const x = c.peek();
    if (x === -1) throw c.err("unexpected end of input");
    if (x === q) break;
    if (x === 0x3c) throw c.err("expected a quote");
    c.pos++;
  }
  c.pos++;
}

function parseMisc(c: Cursor): void {
  for (;;) {
    c.skipWs();
    if (c.startsWith("<!--")) parseComment(c);
    else if (c.startsWith("<?")) parsePi(c);
    else return;
  }
}

function parseComment(c: Cursor): void {
  const start = c.pos;
  c.pos += 4;
  const k = c.s.indexOf("-->", c.pos);
  if (k < 0) {
    c.pos = c.s.length;
    throw c.err("unexpected end of input inside a comment");
  }
  checkChars(c.s, c.pos, k);
  const text = c.s.slice(c.pos, k);
  if (text.includes("--") || text.endsWith("-")) throw c.errFrom(start, "a comment contains '--'");
  c.pos = k + 3;
}

function parsePi(c: Cursor): void {
  if (c.startsWith("<?xml ")) throw c.err("unexpected XML declaration");
  c.pos += 2;
  consumeName(c);
  c.skipWs();
  const k = c.s.indexOf("?>", c.pos);
  if (k < 0) {
    c.pos = c.s.length;
    throw c.err("unexpected end of input inside a processing instruction");
  }
  checkChars(c.s, c.pos, k);
  c.pos = k + 2;
}

function parseDoctype(c: Cursor, b: Builder): void {
  c.pos += 9;
  c.consumeWs();
  consumeName(c);
  c.skipWs();
  parseExternalId(c);
  c.skipWs();
  const x = c.peek();
  if (x === 0x3e) {
    c.pos++;
    return;
  }
  if (x === 0x5b) c.pos++;
  else if (x === -1) throw c.err("unexpected end of input");
  else throw c.err("expected '[' or '>'");
  for (;;) {
    c.skipWs();
    if (c.startsWith("<!ENTITY")) parseEntityDecl(c, b);
    else if (c.startsWith("<!--")) parseComment(c);
    else if (c.startsWith("<?")) parsePi(c);
    else if (c.startsWith("]")) {
      c.pos++;
      c.skipWs();
      c.expect(0x3e, "'>'");
      return;
    } else if (c.startsWith("<!ELEMENT") || c.startsWith("<!ATTLIST") || c.startsWith("<!NOTATION")) {
      const start = c.pos;
      const k = c.s.indexOf(">", c.pos);
      if (k < 0) throw c.errFrom(start, "unknown token in the DTD");
      c.pos = k + 1;
    } else if (c.atEnd()) throw c.err("unexpected end of input");
    else throw c.err("unknown token in the DTD");
  }
}

function parseExternalId(c: Cursor): boolean {
  const pub = c.startsWith("PUBLIC");
  if (!pub && !c.startsWith("SYSTEM")) return false;
  c.pos += 6;
  c.consumeWs();
  skipLiteral(c);
  if (pub) {
    c.consumeWs();
    skipLiteral(c);
  }
  return true;
}

function skipLiteral(c: Cursor): [number, number] {
  const q = c.peek();
  if (q === -1) throw c.err("unexpected end of input");
  if (q !== 0x22 && q !== 0x27) throw c.err("expected a quote");
  c.pos++;
  const start = c.pos;
  const k = c.s.indexOf(q === 0x22 ? '"' : "'", c.pos);
  if (k < 0) {
    c.pos = c.s.length;
    throw c.err("unexpected end of input");
  }
  c.pos = k + 1;
  return [start, k];
}

function parseEntityDecl(c: Cursor, b: Builder): void {
  c.pos += 8;
  c.consumeWs();
  let general = true;
  if (c.peek() === 0x25) {
    c.pos++;
    c.consumeWs();
    general = false;
  }
  const name = consumeName(c);
  c.consumeWs();
  const x = c.peek();
  if (x === 0x22 || x === 0x27) {
    const [vs, ve] = skipLiteral(c);
    const value = c.s.slice(vs, ve);
    if (!b.entities.some(([n]) => n === name)) b.entities.push([name, value]);
  } else if (x === 0x53 || x === 0x50) {
    if (!parseExternalId(c)) throw c.err("invalid external id");
    if (general) {
      c.skipWs();
      if (c.startsWith("NDATA")) {
        c.pos += 5;
        c.consumeWs();
        consumeName(c);
      }
    }
  } else if (x === -1) throw c.err("unexpected end of input");
  else throw c.err("expected a quote, SYSTEM or PUBLIC");
  c.skipWs();
  c.expect(0x3e, "'>'");
}

// ---------------------------------------------------------------------------------------
// Names

function consumeName(c: Cursor): string {
  const start = c.pos;
  const first = c.nextChar();
  if (first === -1) throw c.err("unexpected end of input");
  if (!isNameStart(first)) throw c.err("invalid name");
  c.pos += first > 0xffff ? 2 : 1;
  for (;;) {
    const u = c.nextChar();
    if (u === -1 || !isNameChar(u)) break;
    c.pos += u > 0xffff ? 2 : 1;
  }
  return c.s.slice(start, c.pos);
}

/** A qualified name; returns it and stores the offset of its local part in `c.qlocal`. */
function consumeQname(c: Cursor): string {
  const start = c.pos;
  const s = c.s;
  let colon = -1;
  while (c.pos < s.length) {
    const b = s.charCodeAt(c.pos);
    if (b < 128) {
      if (b === 0x3a) {
        if (colon >= 0) throw c.errFrom(start, "invalid name");
        colon = c.pos;
        c.pos++;
      } else if (isAsciiNameChar(b)) c.pos++;
      else break;
    } else {
      const u = c.nextChar();
      if (u !== -1 && isNameChar(u)) c.pos += u > 0xffff ? 2 : 1;
      else break;
    }
  }
  const local = colon >= 0 ? colon - start + 1 : 0;
  // A non-empty prefix and the local part must start with a NameStartChar.
  if (local > 1 && !isNameStart(s.codePointAt(start)!)) throw c.errFrom(start, "invalid name");
  const ls = start + local;
  if (ls >= c.pos || !isNameStart(s.codePointAt(ls)!)) {
    throw c.errFrom(start, c.atEnd() ? "unexpected end of input" : "invalid name");
  }
  c.qlocal = local;
  return s.slice(start, c.pos);
}

function prefixOf(qname: string, local: number): string | null {
  if (local === 0) return null;
  const p = qname.slice(0, local - 1);
  return p === "" ? null : p;
}

// ---------------------------------------------------------------------------------------
// Elements and content

/** Shared empty child list (replaced by a fresh array on the first child). */
const NO_CHILDREN: XmlNode[] = [];

function pushChild(e: XmlElement, node: XmlNode): void {
  if (e.children === NO_CHILDREN) e.children = [node];
  else e.children.push(node);
}

function parseStartTag(c: Cursor, b: Builder): void {
  const tagStart = c.pos;
  c.pos++;
  const qname = consumeQname(c);
  const local = c.qlocal;
  // Raw attributes in reusable scratch arrays: qualified name, local offset, value range, start.
  const rq = b.rawQ;
  const rn = b.rawN;
  let n = 0;
  let selfClosing: boolean;
  const s = c.s;
  for (;;) {
    const hadWs = c.skipWs();
    const x = c.peek();
    if (x === -1) throw c.err("unexpected end of input");
    if (x === 0x2f) {
      c.pos++;
      c.expect(0x3e, "'>'");
      selfClosing = true;
      break;
    }
    if (x === 0x3e) {
      c.pos++;
      selfClosing = false;
      break;
    }
    if (!hadWs) throw c.err("expected whitespace");
    const astart = c.pos;
    const aq = consumeQname(c);
    const al = c.qlocal;
    c.skipWs();
    c.expect(0x3d, "'='");
    c.skipWs();
    const q = c.peek();
    if (q === -1) throw c.err("unexpected end of input");
    if (q !== 0x22 && q !== 0x27) throw c.err("expected a quote");
    c.pos++;
    const vs = c.pos;
    for (;;) {
      if (c.pos >= s.length) throw c.err("unexpected end of input");
      const y = s.charCodeAt(c.pos);
      if (y === q) break;
      if (y === 0x3c) throw c.err("'<' is not allowed in attribute values");
      c.pos++;
    }
    const ve = c.pos;
    checkChars(s, vs, ve);
    c.pos++;
    for (let k = 0; k < n; k++) if (rq[k] === aq) throw c.errFrom(astart, `duplicated attribute '${aq}'`);
    rq[n] = aq;
    rn[4 * n] = al;
    rn[4 * n + 1] = vs;
    rn[4 * n + 2] = ve;
    rn[4 * n + 3] = astart;
    n++;
  }

  // Namespace declarations.
  const scopesBefore = b.scopes.length;
  for (let k = 0; k < n; k++) {
    const aq = rq[k]!;
    const al = rn[4 * k]!;
    const isDefault = aq === "xmlns";
    if (!isDefault && !(al === 6 && aq.startsWith("xmlns:"))) continue;
    const astart = rn[4 * k + 3]!;
    const value = normalizeAttr(c, b, rn[4 * k + 1]!, rn[4 * k + 2]!);
    if (isDefault) {
      if (value === NS_XML || value === NS_XMLNS) throw c.errFrom(astart, "invalid default namespace");
      b.scopes.push([null, b.intern(value)]);
      continue;
    }
    const name = aq.slice(al);
    if (name === "xml") {
      if (value !== NS_XML) throw c.errFrom(astart, "the 'xml' prefix must be bound to the XML namespace");
      continue;
    }
    if (name === "xmlns") throw c.errFrom(astart, "the 'xmlns' prefix must not be declared");
    if (value === NS_XML || value === NS_XMLNS) {
      throw c.errFrom(astart, "a reserved namespace is bound to another prefix");
    }
    for (let j = scopesBefore; j < b.scopes.length; j++) {
      if (b.scopes[j]![0] === name) throw c.errFrom(astart, `namespace prefix '${name}' is declared twice`);
    }
    b.scopes.push([name, b.intern(value)]);
  }

  // The element's namespace.
  const eprefix = prefixOf(qname, local);
  if (eprefix === "xmlns") throw c.errFrom(tagStart, "'xmlns' cannot be used as an element prefix");
  const ens = b.resolve(eprefix);
  if (ens === undefined) throw c.errFrom(tagStart, `unknown namespace prefix '${eprefix ?? ""}'`);

  // Attributes.
  const attrs: string[] = [];
  let attrNs: (number | null)[] | null = null;
  for (let k = 0; k < n; k++) {
    const aq = rq[k]!;
    const al = rn[4 * k]!;
    const astart = rn[4 * k + 3]!;
    let ns: number | null = null;
    if (al > 0) {
      const prefix = prefixOf(aq, al);
      if (aq === "xmlns" || prefix === "xmlns") continue;
      if (prefix !== null) {
        const res = b.resolve(prefix);
        if (res === undefined) throw c.errFrom(astart, `unknown namespace prefix '${prefix}'`);
        ns = res;
      }
    } else if (aq === "xmlns") continue;
    if (ns !== null) {
      const ln = aq.slice(al);
      if (attrNs !== null) {
        for (let j = 0; j < attrNs.length; j++) {
          if (attrNs[j] === ns && localOf(attrs[2 * j]!) === ln) throw c.errFrom(astart, `duplicated attribute '${aq}'`);
        }
      } else attrNs = new Array<number | null>(attrs.length / 2).fill(null);
    }
    const value = normalizeAttr(c, b, rn[4 * k + 1]!, rn[4 * k + 2]!);
    attrs.push(aq, value);
    if (attrNs !== null) attrNs.push(ns);
  }

  const idx = b.elements.length;
  if (idx >= MAX_ELEMENTS) fail("limit", `XML: more than ${MAX_ELEMENTS} elements`);
  const depth = b.stack.length;
  if (depth + 1 > MAX_DEPTH) fail("limit", `XML: elements nested deeper than ${MAX_DEPTH} levels`);
  const parent = depth === 0 ? null : b.stack[depth - 1]!;
  if (parent !== null) pushChild(b.elements[parent]!, idx);
  b.elements.push({ qname, local, ns: ens, attrs, attrNs, parent, children: NO_CHILDREN });
  b.textOpen = false;
  if (selfClosing) b.scopes.length = scopesBefore;
  else {
    b.stack.push(idx);
    b.stackScopes.push(scopesBefore);
  }
}

function parseEndTag(c: Cursor, b: Builder, base: number): void {
  const start = c.pos;
  c.pos += 2;
  const qname = consumeQname(c);
  c.skipWs();
  c.expect(0x3e, "'>'");
  const depth = b.stack.length;
  if (depth <= base) throw c.errFrom(start, `unexpected closing tag '</${qname}>'`);
  const open = b.elements[b.stack[depth - 1]!]!.qname;
  if (open !== qname) throw c.errFrom(start, `expected '</${open}>', found '</${qname}>'`);
  b.stack.pop();
  b.scopes.length = b.stackScopes.pop()!;
  b.textOpen = false;
}

function parseContent(c: Cursor, b: Builder, base: number, inEntity: boolean): void {
  for (;;) {
    const ch = c.peek();
    if (ch === -1) {
      if (inEntity) {
        if (b.stack.length > base) throw c.err("an element is not closed inside the entity");
        return;
      }
      throw c.err("unexpected end of input (unclosed element)");
    }
    if (ch !== 0x3c) {
      parseText(c, b);
      continue;
    }
    const n = c.peekAt(1);
    if (n === 0x21) {
      if (c.startsWith("<!--")) {
        parseComment(c);
        b.textOpen = false;
      } else if (c.startsWith("<![CDATA[")) {
        b.appendText(parseCdata(c));
      } else throw c.err("unknown markup");
    } else if (n === 0x3f) {
      parsePi(c);
      b.textOpen = false;
    } else if (n === 0x2f) {
      parseEndTag(c, b, base);
      if (!inEntity && b.stack.length === 0) return;
    } else if (n === -1) {
      throw c.err("unexpected end of input");
    } else parseStartTag(c, b);
  }
}

function parseCdata(c: Cursor): string {
  c.pos += 9;
  const k = c.s.indexOf("]]>", c.pos);
  if (k < 0) {
    c.pos = c.s.length;
    throw c.err("unexpected end of input inside CDATA");
  }
  const ts = c.pos;
  checkChars(c.s, ts, k);
  c.pos = k + 3;
  return normalizeNewlines(c.s.slice(ts, k));
}

function normalizeNewlines(s: string): string {
  return s.includes("\r") ? s.replace(/\r\n?/g, "\n") : s;
}

/** [0, char] | [1, entity name], and the position after the `;`; null if malformed. */
function parseReference(s: string, i: number): [0 | 1, string, number] | null {
  let j = i + 1;
  if (s.charCodeAt(j) === 0x23) {
    j++;
    const hex = s.charCodeAt(j) === 0x78;
    if (hex) j++;
    const ds = j;
    let n = 0;
    for (; j < s.length; j++) {
      const d = s.charCodeAt(j);
      let v: number;
      if (d >= 0x30 && d <= 0x39) v = d - 0x30;
      else if (hex && d >= 0x61 && d <= 0x66) v = d - 0x61 + 10;
      else if (hex && d >= 0x41 && d <= 0x46) v = d - 0x41 + 10;
      else break;
      n = n * (hex ? 16 : 10) + v;
      if (n > 0xffffffff) return null;
    }
    if (j === ds) return null;
    let cp = n;
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    if (!isXmlChar(cp) || s.charCodeAt(j) !== 0x3b) return null;
    return [0, String.fromCodePoint(cp), j + 1];
  }
  const ns = j;
  const first = s.codePointAt(j);
  if (first === undefined || !isNameStart(first)) return null;
  j += first > 0xffff ? 2 : 1;
  for (;;) {
    const u = s.codePointAt(j);
    if (u === undefined || !isNameChar(u)) break;
    j += u > 0xffff ? 2 : 1;
  }
  if (s.charCodeAt(j) !== 0x3b) return null;
  const name = s.slice(ns, j);
  switch (name) {
    case "quot":
      return [0, '"', j + 1];
    case "amp":
      return [0, "&", j + 1];
    case "apos":
      return [0, "'", j + 1];
    case "lt":
      return [0, "<", j + 1];
    case "gt":
      return [0, ">", j + 1];
    default:
      return [1, name, j + 1];
  }
}

function parseText(c: Cursor, b: Builder): void {
  const s = c.s;
  const start = c.pos;
  let end = s.indexOf("<", start);
  if (end < 0) end = s.length;
  let special = false;
  for (let i = start; i < end; i++) {
    const x = s.charCodeAt(i);
    if (x === 0x26 || x === 0x0d) special = true;
    else if (x === 0x5d && s.startsWith("]]>", i)) throw c.errFrom(i, "']]>' is not allowed in character data");
  }
  checkChars(s, start, end);
  if (!special) {
    b.appendText(s.slice(start, end));
    c.pos = end;
    return;
  }
  let buf = "";
  let i = start;
  while (i < end) {
    const x = s.charCodeAt(i);
    if (x === 0x26) {
      const r = parseReference(s, i);
      if (r === null) throw c.errFrom(i, "malformed entity reference");
      if (r[0] === 0) {
        buf += b.refDepth > 0 && r[1] === "\r" ? "\n" : r[1];
      } else {
        const name = r[1];
        const value = b.entity(name);
        if (value === undefined) throw c.errFrom(i, `unknown entity reference '&${name};'`);
        b.appendText(buf);
        buf = "";
        b.enterEntity(c, i);
        const ec = new Cursor(value, 0);
        try {
          parseContent(ec, b, b.stack.length, true);
        } catch (e) {
          if (e instanceof SvgFailure) {
            throw new SvgFailure(e.error.code, `in entity '&${name};': ${e.error.message}`);
          }
          throw e;
        }
        b.leaveEntity();
      }
      i = r[2];
    } else if (x === 0x0d) {
      buf += "\n";
      i++;
      if (i < end && s.charCodeAt(i) === 0x0a) i++;
    } else {
      let k2 = i;
      while (k2 < end) {
        const y = s.charCodeAt(k2);
        if (y === 0x26 || y === 0x0d) break;
        k2++;
      }
      buf += s.slice(i, k2);
      i = k2;
    }
  }
  b.appendText(buf);
  c.pos = end;
}

/** Attribute-value normalization of `c.s[vs..ve]` (XML 1.0 §3.3.3, as roxmltree). */
function normalizeAttr(c: Cursor, b: Builder, vs: number, ve: number): string {
  const s = c.s;
  let plain = true;
  for (let i = vs; i < ve; i++) {
    const x = s.charCodeAt(i);
    if (x === 0x26 || x === 0x09 || x === 0x0a || x === 0x0d) {
      plain = false;
      break;
    }
  }
  if (plain) return s.slice(vs, ve);
  return normalizeInto(c, s.slice(vs, ve), vs, b);
}

function normalizeInto(c: Cursor, s: string, base: number, b: Builder): string {
  let out = "";
  const top = b.refDepth === 0;
  const posOf = (i: number): number => (top ? base + i : base);
  let i = 0;
  while (i < s.length) {
    const x = s.charCodeAt(i);
    if (x === 0x26) {
      const r = parseReference(s, i);
      if (r === null) throw c.errFrom(posOf(i), "malformed entity reference");
      if (r[0] === 0) {
        const ch = r[1];
        if (b.refDepth > 0) {
          if (ch === "<") throw c.errFrom(posOf(i), "'<' is not allowed in attribute values");
          out += ch === "\t" || ch === "\n" || ch === "\r" ? " " : ch;
        } else out += ch;
      } else {
        const name = r[1];
        const value = b.entity(name);
        if (value === undefined) throw c.errFrom(posOf(i), `unknown entity reference '&${name};'`);
        const p = posOf(i);
        b.enterEntity(c, p);
        out += normalizeInto(c, value, p, b);
        b.leaveEntity();
      }
      i = r[2];
    } else if (x === 0x0d) {
      if (s.charCodeAt(i + 1) !== 0x0a) out += " ";
      i++;
    } else if (x === 0x09 || x === 0x0a) {
      out += " ";
      i++;
    } else {
      let k = i;
      while (k < s.length) {
        const y = s.charCodeAt(k);
        if (y === 0x26 || y === 0x09 || y === 0x0a || y === 0x0d) break;
        k++;
      }
      out += s.slice(i, k);
      i = k;
    }
  }
  return out;
}
