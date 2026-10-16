/**
 * Tokenizer for spec/expr.peg (port of rust/crates/la-expr/src/lexer.rs). Works on the
 * code points of the source, so offsets are code-point offsets as in Rust.
 *
 * @module
 */

import { EXPR_SYNTAX, ExprError } from "./error.js";

export type TokKind =
  | "num"
  | "str"
  | "ident"
  | "true"
  | "false"
  | "null"
  | "in"
  | "not"
  | "||"
  | "&&"
  | "!"
  | "=="
  | "!="
  | "<="
  | ">="
  | "<"
  | ">"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "."
  | "("
  | ")"
  | "["
  | "]"
  | ","
  | "eof"
  | "error";

export interface Token {
  kind: TokKind;
  offset: number;
  /** Number value (`num`). */
  num: number;
  /** String value (`str`) or name (`ident`). */
  text: string;
}

export interface Lexed {
  tokens: Token[];
  /** The lexical error at the final `error` token, if any. */
  error: ExprError | null;
}

export function describe(t: Token): string {
  switch (t.kind) {
    case "num":
      return "a number";
    case "str":
      return "a string";
    case "ident":
      return `identifier '${t.text}'`;
    case "eof":
      return "end of input";
    case "error":
      return "an invalid token";
    default:
      return `'${t.kind}'`;
  }
}

const KEYWORDS: { [k: string]: TokKind } = {
  true: "true",
  false: "false",
  null: "null",
  in: "in",
  not: "not",
};

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isIdentStart = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
const isIdentChar = (c: number) => isIdentStart(c) || isDigit(c);

/**
 * Length of the longest prefix at `i` matching the grammar's Number rule (0 if none);
 * `at(k)` is the ASCII code at position k (0 past the end or for non-ASCII).
 */
export function numberLen(at: (k: number) => number, i: number): number {
  const digit = (k: number) => isDigit(at(k));
  let k = i;
  while (digit(k)) k++;
  const intDigits = k - i;
  if (at(k) === 0x2e && digit(k + 1)) {
    k++;
    while (digit(k)) k++;
  } else if (intDigits === 0) {
    return 0;
  }
  if (at(k) === 0x65 || at(k) === 0x45) {
    let e = k + 1;
    if (at(e) === 0x2b || at(e) === 0x2d) e++;
    if (digit(e)) {
      while (digit(e)) e++;
      k = e;
    }
  }
  return k - i;
}

/** The code points of `s` (a lone surrogate counts as one code point). */
export function codePoints(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) out.push(ch.codePointAt(0) as number);
  return out;
}

/** String from code points (chunked: no argument-count limit). */
export function fromCodePoints(cps: number[], start = 0, end = cps.length): string {
  let s = "";
  for (let i = start; i < end; i += 4096) {
    s += String.fromCodePoint(...cps.slice(i, Math.min(i + 4096, end)));
  }
  return s;
}

function hex4(s: number[], at: number): number {
  if (at + 4 > s.length) return -1;
  let v = 0;
  for (let k = at; k < at + 4; k++) {
    const c = s[k] as number;
    let d: number;
    if (c >= 0x30 && c <= 0x39) d = c - 0x30;
    else if (c >= 0x61 && c <= 0x66) d = c - 0x61 + 10;
    else if (c >= 0x41 && c <= 0x46) d = c - 0x41 + 10;
    else return -1;
    v = v * 16 + d;
  }
  return v;
}

function syntax(offset: number, message: string): ExprError {
  return new ExprError(EXPR_SYNTAX, message, offset);
}

/** Lexes a string literal starting at the quote s[i]; returns [value, end]. */
function lexString(s: number[], start: number): [string, number] {
  const quote = s[start];
  let i = start + 1;
  const out: number[] = [];
  for (;;) {
    if (i >= s.length) throw syntax(start, "unterminated string");
    const c = s[i] as number;
    if (c === quote) return [fromCodePoints(out), i + 1];
    if (c !== 0x5c) {
      out.push(c);
      i++;
      continue;
    }
    if (i + 1 >= s.length) throw syntax(start, "unterminated string");
    const bs = i;
    const e = s[bs + 1] as number;
    if (e === 0x6e) {
      out.push(0x0a);
    } else if (e === 0x74) {
      out.push(0x09);
    } else if (e === 0x75) {
      const cp = hex4(s, bs + 2);
      if (cp < 0) throw syntax(bs, "invalid \\u escape: expected 4 hex digits");
      const unpaired = () => syntax(bs, "invalid \\u escape: unpaired surrogate");
      if (cp >= 0xd800 && cp < 0xdc00) {
        const lo = bs + 7 < s.length && s[bs + 6] === 0x5c && s[bs + 7] === 0x75 ? hex4(s, bs + 8) : -1;
        if (lo >= 0xdc00 && lo < 0xe000) {
          out.push(0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00));
          i = bs + 12;
          continue;
        }
        throw unpaired();
      }
      if (cp >= 0xdc00 && cp < 0xe000) throw unpaired();
      out.push(cp);
      i = bs + 6;
      continue;
    } else {
      out.push(e);
    }
    i = bs + 2;
  }
}

function unexpectedChar(c: number, at: number): ExprError {
  const hint = c === 0x3d ? " (use '==' to compare)" : c === 0x26 ? " (use '&&')" : c === 0x7c ? " (use '||')" : "";
  return syntax(at, `unexpected character '${String.fromCodePoint(c)}'${hint}`);
}

function tok(kind: TokKind, offset: number, num = 0, text = ""): Token {
  return { kind, offset, num, text };
}

const TWO_CHAR: { [k: string]: TokKind } = { "||": "||", "&&": "&&", "==": "==", "!=": "!=", "<=": "<=", ">=": ">=" };
const ONE_CHAR: { [k: string]: TokKind } = {
  "!": "!",
  "<": "<",
  ">": ">",
  "+": "+",
  "-": "-",
  "*": "*",
  "/": "/",
  "%": "%",
  ".": ".",
  "(": "(",
  ")": ")",
  "[": "[",
  "]": "]",
  ",": ",",
};

/** Tokenizes `s` (code points). A lexical error ends the token list with an `error` token. */
export function lex(s: number[]): Lexed {
  const tokens: Token[] = [];
  const n = s.length;
  const at = (k: number) => (k < n && (s[k] as number) < 0x80 ? (s[k] as number) : 0);
  let i = 0;
  for (;;) {
    while (i < n && (s[i] === 0x20 || s[i] === 0x09 || s[i] === 0x0d || s[i] === 0x0a)) i++;
    if (i >= n) {
      tokens.push(tok("eof", n));
      return { tokens, error: null };
    }
    const start = i;
    const c = s[i] as number;
    try {
      if ((isDigit(c) || c === 0x2e) && numberLen(at, i) > 0) {
        const len = numberLen(at, i);
        const v = Number(fromCodePoints(s, i, i + len));
        i += len;
        if (!Number.isFinite(v)) throw syntax(start, "number out of range");
        tokens.push(tok("num", start, v));
      } else if (c === 0x22 || c === 0x27) {
        const [value, end] = lexString(s, i);
        i = end;
        tokens.push(tok("str", start, 0, value));
      } else if (isIdentStart(c)) {
        while (i < n && isIdentChar(s[i] as number)) i++;
        const word = fromCodePoints(s, start, i);
        const kw = Object.prototype.hasOwnProperty.call(KEYWORDS, word) ? KEYWORDS[word] : undefined;
        tokens.push(kw ? tok(kw, start) : tok("ident", start, 0, word));
      } else {
        const two = i + 1 < n ? String.fromCodePoint(c, s[i + 1] as number) : "";
        const one = String.fromCodePoint(c);
        if (Object.prototype.hasOwnProperty.call(TWO_CHAR, two)) {
          tokens.push(tok(TWO_CHAR[two] as TokKind, start));
          i += 2;
        } else if (Object.prototype.hasOwnProperty.call(ONE_CHAR, one)) {
          tokens.push(tok(ONE_CHAR[one] as TokKind, start));
          i += 1;
        } else {
          throw unexpectedChar(c, start);
        }
      }
    } catch (e) {
      if (!(e instanceof ExprError)) throw e;
      tokens.push(tok("error", e.offset));
      return { tokens, error: e };
    }
  }
}
