// Paint values: whether something is painted and with which alpha. Mirrors color.rs.

import { asciiLower, parseNumber } from "./num.js";

export type PaintSpec =
  | { k: "none" }
  /** A colour (incl. currentColor, context-fill, context-stroke) with its alpha. */
  | { k: "color"; alpha: number }
  /** `url(#id) [fallback]`; id null for references outside the document. */
  | { k: "url"; id: string | null; fallback: PaintSpec | null };

const NAMED = new Set<string>(
  (
    "aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet " +
    "brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue " +
    "darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange " +
    "darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise " +
    "darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia " +
    "gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo " +
    "ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue " +
    "lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon " +
    "mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin " +
    "navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen " +
    "paleturquoise palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red " +
    "rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue " +
    "slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white " +
    "whitesmoke yellow yellowgreen"
  ).split(" "),
);

const FUNCTIONS = new Set(["rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color"]);

function hexVal(c: number): number {
  if (c >= 0x30 && c <= 0x39) return c - 0x30;
  if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;
  if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;
  return -1;
}

function isAsciiWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d || c === 0x0c;
}

/** Trims ASCII whitespace (space, tab, LF, CR, FF) like Rust's `trim_matches(is_ascii_whitespace)`. */
export function trimAscii(s: string): string {
  let a = 0;
  let e = s.length;
  while (a < e && isAsciiWs(s.charCodeAt(a))) a++;
  while (e > a && isAsciiWs(s.charCodeAt(e - 1))) e--;
  return a === 0 && e === s.length ? s : s.slice(a, e);
}

/** Alpha of a number or percentage, clamped to [0, 1]. */
export function parseAlpha(s: string): number | null {
  const t = trimAscii(s);
  const pct = t.endsWith("%");
  const v = parseNumber(pct ? t.slice(0, -1) : t);
  if (v === null) return null;
  const a = pct ? v / 100 : v;
  return a < 0 ? 0 : a > 1 ? 1 : a;
}

/** The alpha of a CSS colour, null if it is not a colour. */
export function parseColorAlpha(s: string): number | null {
  const t = trimAscii(s);
  const lower = asciiLower(t);
  if (lower === "transparent") return 0;
  if (lower === "currentcolor" || lower === "context-fill" || lower === "context-stroke") return 1;
  if (t.startsWith("#")) {
    const digits: number[] = [];
    for (let i = 1; i < t.length; i++) {
      const v = hexVal(t.charCodeAt(i));
      if (v < 0) return null;
      digits.push(v);
    }
    switch (digits.length) {
      case 3:
      case 6:
        return 1;
      case 4:
        return digits[3]! / 15;
      case 8:
        return (digits[6]! * 16 + digits[7]!) / 255;
      default:
        return null;
    }
  }
  const open = lower.indexOf("(");
  if (open >= 0) {
    const name = lower.slice(0, open);
    if (!lower.endsWith(")")) return null;
    if (!FUNCTIONS.has(name)) return null;
    const args = lower.slice(open + 1, lower.length - 1);
    const slash = args.indexOf("/");
    if (slash >= 0) return parseAlpha(args.slice(slash + 1));
    const parts = args.split(",");
    if (parts.length === 4) return parseAlpha(parts[3]!);
    return 1;
  }
  return NAMED.has(lower) ? 1 : null;
}

/** Parses a `fill`/`stroke` value. */
export function parsePaint(s: string): PaintSpec | null {
  const t = trimAscii(s);
  if (asciiLower(t) === "none") return { k: "none" };
  if (asciiLower(t.slice(0, 4)) === "url(") {
    const close = t.indexOf(")");
    if (close < 0) return null;
    let inner = trimAscii(t.slice(4, close));
    if (
      inner.length >= 2 &&
      ((inner.startsWith('"') && inner.endsWith('"')) || (inner.startsWith("'") && inner.endsWith("'")))
    ) {
      inner = inner.slice(1, -1);
    }
    const id = inner.startsWith("#") ? inner.slice(1) : null;
    const rest = trimAscii(t.slice(close + 1));
    let fallback: PaintSpec | null = null;
    if (rest.length > 0) {
      const f = parsePaint(rest);
      if (f === null || f.k === "url") return null;
      fallback = f;
    }
    return { k: "url", id, fallback };
  }
  const a = parseColorAlpha(t);
  return a === null ? null : { k: "color", alpha: a };
}
