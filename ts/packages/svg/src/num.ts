// Numbers, lengths and number lists (SVG micro-syntax). Mirrors num.rs.

/** SVG whitespace (space, tab, CR, LF, FF). */
export function isWsp(b: number): boolean {
  return b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c;
}

export function skipWsp(s: string, i: number): number {
  while (i < s.length && isWsp(s.charCodeAt(i))) i++;
  return i;
}

/** Skips `wsp* ,? wsp*`. */
export function skipCommaWsp(s: string, i: number): number {
  i = skipWsp(s, i);
  if (i < s.length && s.charCodeAt(i) === 0x2c) i = skipWsp(s, i + 1);
  return i;
}

function isDigit(b: number): boolean {
  return b >= 0x30 && b <= 0x39;
}

/**
 * Scans a number at `i`: `[+-]? (digits ('.' digits?)? | '.' digits) ([eE][+-]?digits)?`.
 * Returns [value, end] or null. Non-finite values are rejected.
 */
export function scanNumber(s: string, i: number): [number, number] | null {
  const n = s.length;
  const start = i;
  let c = s.charCodeAt(i);
  if (i < n && (c === 0x2b || c === 0x2d)) i++;
  const intStart = i;
  while (i < n && isDigit(s.charCodeAt(i))) i++;
  let digits = i > intStart;
  if (i < n && s.charCodeAt(i) === 0x2e) {
    const f = i + 1;
    let j = f;
    while (j < n && isDigit(s.charCodeAt(j))) j++;
    if (j > f) {
      digits = true;
      i = j;
    } else if (digits) i = f;
  }
  if (!digits) return null;
  c = s.charCodeAt(i);
  if (i < n && (c === 0x65 || c === 0x45)) {
    let j = i + 1;
    const d = s.charCodeAt(j);
    if (j < n && (d === 0x2b || d === 0x2d)) j++;
    const ds = j;
    while (j < n && isDigit(s.charCodeAt(j))) j++;
    if (j > ds) i = j;
  }
  const v = Number(s.slice(start, i));
  return Number.isFinite(v) ? [v, i] : null;
}

/** Parses a complete number (surrounding whitespace allowed). */
export function parseNumber(s: string): number | null {
  const i = skipWsp(s, 0);
  const r = scanNumber(s, i);
  if (r === null) return null;
  return skipWsp(s, r[1]) === s.length ? r[0] : null;
}

/** Numbers separated by comma-wsp; stops at the first error. Returns [values, complete]. */
export function parseNumberList(s: string): [number[], boolean] {
  const out: number[] = [];
  let i = skipWsp(s, 0);
  while (i < s.length) {
    const r = scanNumber(s, i);
    if (r === null) return [out, false];
    out.push(r[0]);
    i = skipCommaWsp(s, r[1]);
  }
  return [out, true];
}

export type Unit = "" | "px" | "pt" | "pc" | "in" | "cm" | "mm" | "em" | "ex" | "rem" | "%";

export const PT = 4 / 3;
export const PC = 16;
export const IN = 96;
export const CM = 96 / 2.54;
export const MM = 96 / 25.4;

export interface Length {
  v: number;
  unit: Unit;
}

export function px(v: number): Length {
  return { v, unit: "" };
}

/** Resolves to user units; `em` uses `fontSize`, `%` uses `percentRef`. */
export function resolveLength(l: Length, fontSize: number, percentRef: number): number {
  const v = l.v;
  switch (l.unit) {
    case "":
    case "px":
      return v;
    case "pt":
      return v * PT;
    case "pc":
      return v * PC;
    case "in":
      return v * IN;
    case "cm":
      return v * CM;
    case "mm":
      return v * MM;
    case "em":
      return v * fontSize;
    case "ex":
      return (v * fontSize) / 2;
    case "rem":
      return v * 16;
    case "%":
      return (v * percentRef) / 100;
  }
}

const UNITS = new Set<string>(["", "px", "pt", "pc", "in", "cm", "mm", "em", "ex", "rem", "%"]);

function asciiLower(s: string): string {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x41 && c <= 0x5a) return s.replace(/[A-Z]/g, (m) => String.fromCharCode(m.charCodeAt(0) + 32));
  }
  return s;
}

export function parseUnit(s: string): Unit | null {
  const u = asciiLower(s);
  return UNITS.has(u) ? (u as Unit) : null;
}

function trimEndWsp(s: string): string {
  let e = s.length;
  while (e > 0 && isWsp(s.charCodeAt(e - 1))) e--;
  return s.slice(0, e);
}

/** Parses a single length (`10`, `10px`, `2.5em`, `50%`). */
export function parseLength(s: string): Length | null {
  const i = skipWsp(s, 0);
  const r = scanNumber(s, i);
  if (r === null) return null;
  const unit = parseUnit(trimEndWsp(s.slice(r[1])));
  return unit === null ? null : { v: r[0], unit };
}

/** The first length of a whitespace/comma separated list (`x="10 20 30"`). */
export function parseFirstLength(s: string): Length | null {
  const i = skipWsp(s, 0);
  let j = i;
  while (j < s.length && !isWsp(s.charCodeAt(j)) && s.charCodeAt(j) !== 0x2c) j++;
  return parseLength(s.slice(i, j));
}

export { asciiLower };
