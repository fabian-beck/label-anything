/** Small helpers of the home page's live examples: SVG and HTML elements, numbers, geometry. */

export type Pt = [number, number];
export type Ring = Pt[];

export const SVG_NS = "http://www.w3.org/2000/svg";

/** The family the labels are measured (by the engine) and drawn with: the bundled Noto Sans. */
export const LABEL_FAMILY = '"LA Noto Sans", "Noto Sans", sans-serif';

type Attrs = Record<string, string | number | undefined>;

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag) as SVGElementTagNameMap[K];
  set(e, attrs);
  parent?.appendChild(e);
  return e;
}

export function set(e: Element, attrs: Attrs): void {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) e.removeAttribute(k);
    else e.setAttribute(k, String(v));
  }
}

export function html<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

/** A coordinate without trailing zeros (two decimals), as the showcase's scripts write them. */
export function f2(v: number): string {
  const s = v.toFixed(2);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** Rounded to `digits` decimals as Python's `round` does (from the number's exact value). */
export const round = (v: number, digits: number): number => Number(v.toFixed(digits));

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export const easeInOut = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** A count or an amount in words: 1,234 · 83.1 million · 3.86 trillion. */
export function compact(v: number): string {
  const a = Math.abs(v);
  for (const [unit, name] of [[1e12, "trillion"], [1e9, "billion"], [1e6, "million"]] as const) {
    if (a >= unit) return `${sig3(v / unit)} ${name}`;
  }
  return a >= 1000 ? Math.round(Number(v.toPrecision(3))).toLocaleString("en-US") : sig3(v);
}

const sig3 = (v: number): string => String(Number(v.toPrecision(3)));

/** A tick of a log axis: 200 · 5k · 10M · 1B · 2T. */
export function tick(v: number): string {
  for (const [unit, suffix] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]] as const) {
    if (v >= unit) return `${Number((v / unit).toPrecision(3))}${suffix}`;
  }
  return String(Number(v.toPrecision(3)));
}

/** The area of a ring (unsigned). */
export function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]!;
    const q = ring[(i + 1) % ring.length]!;
    s += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(s) / 2;
}

/** A ring cut to a rectangle (Sutherland–Hodgman). */
export function clipRing(ring: Ring, x0: number, y0: number, x1: number, y1: number): Ring {
  const cut = (pts: Ring, inside: (p: Pt) => boolean, cross: (p: Pt, q: Pt) => Pt): Ring => {
    const out: Ring = [];
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i]!;
      const p = pts[(i + pts.length - 1) % pts.length]!;
      if (inside(q)) {
        if (!inside(p)) out.push(cross(p, q));
        out.push(q);
      } else if (inside(p)) out.push(cross(p, q));
    }
    return out;
  };
  const atX = (x: number) => (p: Pt, q: Pt): Pt => [x, p[1] + ((q[1] - p[1]) * (x - p[0])) / (q[0] - p[0])];
  const atY = (y: number) => (p: Pt, q: Pt): Pt => [p[0] + ((q[0] - p[0]) * (y - p[1])) / (q[1] - p[1]), y];
  let pts = ring;
  if (pts.length) pts = cut(pts, (p) => p[0] >= x0, atX(x0));
  if (pts.length) pts = cut(pts, (p) => p[0] <= x1, atX(x1));
  if (pts.length) pts = cut(pts, (p) => p[1] >= y0, atY(y0));
  if (pts.length) pts = cut(pts, (p) => p[1] <= y1, atY(y1));
  return pts;
}

/** Whether a point is inside a ring (even–odd). */
export function inRing(ring: Ring, x: number, y: number): boolean {
  let c = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x1, y1] = ring[i]!;
    const [x2, y2] = ring[j]!;
    if (y1 > y !== y2 > y && x < x1 + ((y - y1) * (x2 - x1)) / (y2 - y1)) c = !c;
  }
  return c;
}

/** SVG path data of rings (closed). */
export function ringsPath(rings: Ring[]): string {
  let d = "";
  for (const r of rings) {
    if (r.length < 3) continue;
    d += "M" + r.map(([x, y]) => `${f2(x)} ${f2(y)}`).join("L") + "Z";
  }
  return d;
}

export async function fetchJson<T>(url: URL): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url.pathname}: ${r.status}`);
  return (await r.json()) as T;
}

/** A labeled `<select>` of a toolbar. */
export function select<T extends string>(parent: Element, label: string, options: readonly (readonly [T, string])[], value: T, change: (v: T) => void): HTMLSelectElement {
  const wrap = html("label", "la-example__field", undefined, parent);
  html("span", undefined, label, wrap);
  const s = html("select", undefined, undefined, wrap);
  for (const [v, text] of options) {
    const o = html("option", undefined, text, s);
    o.value = v;
  }
  s.value = value;
  s.addEventListener("change", () => change(s.value as T));
  return s;
}

/** A group of buttons of which one is pressed. */
export function segmented<T extends string>(parent: Element, label: string, options: readonly (readonly [T, string])[], value: T, change: (v: T) => void): { set(v: T): void } {
  const wrap = html("span", "la-example__field", undefined, parent);
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", label);
  html("span", undefined, label, wrap);
  const group = html("span", "la-example__segments", undefined, wrap);
  const buttons = new Map<T, HTMLButtonElement>();
  const show = (v: T) => {
    for (const [k, b] of buttons) b.setAttribute("aria-pressed", String(k === v));
  };
  for (const [v, text] of options) {
    const b = html("button", undefined, text, group);
    b.type = "button";
    b.addEventListener("click", () => {
      show(v);
      change(v);
    });
    buttons.set(v, b);
  }
  show(value);
  return { set: show };
}

/** A plain button of a toolbar. */
export function button(parent: Element, text: string, click: () => void, cls = "la-example__button"): HTMLButtonElement {
  const b = html("button", cls, text, parent);
  b.type = "button";
  b.addEventListener("click", click);
  return b;
}
