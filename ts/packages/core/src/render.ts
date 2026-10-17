/**
 * Debug SVG overlay (brief §2.8, spec §11): placed labels, leaders, candidates, a cost
 * heatmap per class, item shapes and unplaced labels with their reasons; port of
 * `rust/crates/la-render/src/lib.rs` (the same bytes for the same inputs).
 *
 * Layers are SVG groups with ids (`background`, `obstacles`, `heatmap-<class>`,
 * `candidates`, `items`, `leaders`, `labels`, `unplaced`) so they can be toggled.
 *
 * @module
 */

import { P, Rect } from "./geom/index.js";
import type { Shape } from "./geom/shape.js";
import type { GridSpec } from "./grid/index.js";
import { fmtF64, fmtFixed, get, items as itemsOf } from "./json.js";
import { maxf, roundHalfAway } from "./math.js";
import type { Model } from "./model/index.js";

/** Grid data for debug rendering (only built when `output.debug_svg` is set). */
export interface DebugData {
  grid: GridSpec;
  /** (class name, coverage 0..255 per cell) */
  classes: [string, Uint8Array][];
  /** (item id, label box, feasible) of all candidates */
  candidates: [string, Rect, boolean][];
}

/** Escape text for XML. */
export function esc(s: string): string {
  let o = "";
  for (const c of s) {
    switch (c) {
      case "&":
        o += "&amp;";
        break;
      case "<":
        o += "&lt;";
        break;
      case ">":
        o += "&gt;";
        break;
      case '"':
        o += "&quot;";
        break;
      case "'":
        o += "&#39;";
        break;
      default:
        o += c;
    }
  }
  return o;
}

const I64_MAX = BigInt("9223372036854775807");
const I64_MIN = BigInt("-9223372036854775808");

/** A coordinate rounded to 2 decimals, as the Rust writer prints it. */
function f(v: number): string {
  const r = roundHalfAway(v * 100) / 100;
  if (r === Math.trunc(r)) {
    // `r as i64` (saturating; ±inf saturate, NaN never gets here)
    if (r >= 9223372036854775807) return I64_MAX.toString();
    if (r <= -9223372036854775808) return I64_MIN.toString();
    return BigInt(r).toString();
  }
  return fmtF64(r);
}

function pathOf(points: readonly P[], close: boolean): string {
  let d = "";
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    d += `${i === 0 ? "M" : "L"}${f(p.x)} ${f(p.y)}`;
  }
  if (close) d += "Z";
  return d;
}

function shapeSvg(s: Shape, style: string): string {
  if (s.kind === "circle") return `<circle cx="${f(s.c.x)}" cy="${f(s.c.y)}" r="${f(maxf(s.r, 0.75))}" ${style}/>`;
  if (s.kind === "polygon") {
    const d = s.poly.rings.map((r) => pathOf(r, true)).join("");
    return `<path d="${d}" fill-rule="${s.poly.evenOdd ? "evenodd" : "nonzero"}" ${style}/>`;
  }
  return `<path d="${pathOf(s.outline(), true)}" ${style}/>`;
}

/** Palette for class heatmaps (colour-blind friendly; cycles). */
const PALETTE: readonly [number, number, number][] = [
  [230, 85, 13],
  [49, 130, 189],
  [117, 107, 177],
  [49, 163, 84],
  [214, 39, 40],
  [140, 86, 75],
  [227, 119, 194],
  [188, 189, 34],
];

const num = (v: unknown, d: number): number => (typeof v === "number" ? v : d);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** serde_json's `Display` of a JSON value (`null` for absent values). */
function jsonDisplay(v: unknown): string {
  if (v === undefined || v === null) return "null";
  if (typeof v === "number" && !Number.isFinite(v)) return "null";
  return JSON.stringify(v);
}

function pointsOf(v: unknown): P[] {
  const out: P[] = [];
  for (const q of itemsOf(v)) {
    if (!Array.isArray(q)) continue;
    const x = q[0];
    const y = q[1];
    if (typeof x === "number" && typeof y === "number") out.push(new P(x, y));
  }
  return out;
}

/**
 * Render the overlay. `model` (from `model.build`) provides true item shapes and
 * obstacle geometry; `debug` adds heatmaps and candidates.
 */
export function debugSvg(model: Model | null, result: unknown, debug: DebugData | null): string {
  const placements = itemsOf(get(result, "placements"));
  let canvas: Rect | null = model !== null ? model.canvas : null;
  if (canvas === null) {
    // derive from the placements
    let r = Rect.EMPTY;
    for (const p of placements) {
      const b = get(p, "box");
      if (b !== undefined) {
        r = r.union(Rect.xywh(num(get(b, "x"), 0), num(get(b, "y"), 0), num(get(b, "w"), 0), num(get(b, "h"), 0)));
      }
    }
    if (model !== null) for (const it of model.items) r = r.union(it.shape.bbox());
    canvas = r.isEmpty() ? null : r.inflate(20);
  }
  const vb = canvas ?? new Rect(0, 0, 100, 100);
  let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${f(vb.x0)} ${f(vb.y0)} ${f(vb.w())} ${f(vb.h())}" width="${f(vb.w())}" height="${f(vb.h())}" font-family="Noto Sans, Arial, sans-serif">`;
  s += `<rect id="background" x="${f(vb.x0)}" y="${f(vb.y0)}" width="${f(vb.w())}" height="${f(vb.h())}" fill="#ffffff"/>`;
  if (model !== null && model.labelArea !== null) {
    const la = model.labelArea;
    s += `<rect id="label-area" x="${f(la.x0)}" y="${f(la.y0)}" width="${f(la.w())}" height="${f(la.h())}" fill="none" stroke="#cccccc" stroke-dasharray="4 3"/>`;
  }
  // heatmaps
  if (debug !== null) {
    debug.classes.forEach(([name, cov], k) => {
      if (cov.every((c) => c === 0)) return;
      const [r, g, b] = PALETTE[k % PALETTE.length]!;
      const png = pngRgba(debug.grid.cols, debug.grid.rows, (i, out, o) => {
        out[o] = r;
        out[o + 1] = g;
        out[o + 2] = b;
        out[o + 3] = cov[i]!;
      });
      s += `<g id="heatmap-${esc(name)}" opacity="0.45"><title>cost grid: ${esc(name)}</title><image x="${f(debug.grid.ox)}" y="${f(debug.grid.oy)}" width="${f(debug.grid.cols * debug.grid.cell)}" height="${f(debug.grid.rows * debug.grid.cell)}" preserveAspectRatio="none" style="image-rendering:pixelated" href="data:image/png;base64,${base64(png)}"/></g>`;
    });
  }
  // obstacles
  if (model !== null) {
    const parts: string[] = ['<g id="obstacles" opacity="0.6">'];
    const n = model.vector.length < 200000 ? model.vector.length : 200000;
    for (let k = 0; k < n; k++) {
      const [cls, p] = model.vector[k]!;
      const t = `<title>${esc(cls)}</title>`;
      switch (p.kind) {
        case "disc":
          parts.push(`<circle cx="${f(p.c.x)}" cy="${f(p.c.y)}" r="${f(maxf(p.r, 0.5))}" fill="#9e9e9e">${t}</circle>`);
          break;
        case "rect":
          parts.push(`<rect x="${f(p.rect.x0)}" y="${f(p.rect.y0)}" width="${f(p.rect.w())}" height="${f(p.rect.h())}" fill="#bdbdbd">${t}</rect>`);
          break;
        case "polygon": {
          const d = p.rings.map((r) => pathOf(r, true)).join("");
          parts.push(`<path d="${d}" fill="#e0e0e0" stroke="#9e9e9e" stroke-width="0.5">${t}</path>`);
          break;
        }
        case "polyline":
          parts.push(`<path d="${pathOf(p.points, p.closed)}" fill="none" stroke="#9e9e9e" stroke-width="${f(maxf(p.hw * 2, 0.5))}">${t}</path>`);
          break;
        case "shape":
          parts.push(shapeSvg(p.shape, 'fill="#bdbdbd"'));
          break;
      }
    }
    parts.push("</g>");
    s += parts.join("");
  }
  // candidates
  if (debug !== null) {
    const parts: string[] = ['<g id="candidates" opacity="0.25" fill="none" stroke-width="0.5">'];
    const n = debug.candidates.length < 50000 ? debug.candidates.length : 50000;
    for (let k = 0; k < n; k++) {
      const [, r, ok] = debug.candidates[k]!;
      parts.push(`<rect x="${f(r.x0)}" y="${f(r.y0)}" width="${f(r.w())}" height="${f(r.h())}" stroke="${ok ? "#2e7d32" : "#c62828"}"/>`);
    }
    parts.push("</g>");
    s += parts.join("");
  }
  // items
  if (model !== null) {
    s += '<g id="items">';
    for (const it of model.items) {
      if (it.area !== null) {
        s += shapeSvg(it.area.shape, 'fill="#bbdefb" fill-opacity="0.5" stroke="#1565c0" stroke-width="0.75"');
      }
      s += shapeSvg(it.shape, 'fill="#1565c0" fill-opacity="0.35" stroke="#0d47a1" stroke-width="0.75"');
    }
    s += "</g>";
  }
  // leaders and labels
  let leaders = "";
  let labels = "";
  let unplaced = "";
  const drawText = (t: unknown, ox: number, oy: number): string => {
    const size = num(get(t, "font_size"), 12);
    const fw = get(t, "font_weight");
    const weight = typeof fw === "number" && Number.isInteger(fw) ? fw : 400;
    const xo = num(get(t, "x_offset"), 0);
    const lines = itemsOf(get(t, "lines"));
    const bases = itemsOf(get(t, "baseline_offsets"));
    let out = "";
    for (let k = 0; k < lines.length && k < bases.length; k++) {
      out += `<text x="${f(ox + xo)}" y="${f(oy + num(bases[k], 0))}" font-size="${f(size)}" font-weight="${weight}" fill="#000000">${esc(str(lines[k]))}</text>`;
    }
    return out;
  };
  placements.forEach((p, k) => {
    const id = str(get(p, "id"));
    if (get(p, "placed") === true) {
      const b = get(p, "box");
      const x = num(get(b, "x"), 0);
      const y = num(get(b, "y"), 0);
      const w = num(get(b, "w"), 0);
      const h = num(get(b, "h"), 0);
      let ls: unknown[] = Array.isArray(get(p, "leaders")) ? (get(p, "leaders") as unknown[]).slice() : [];
      if (ls.length === 0) {
        const l = get(p, "leader");
        if (typeof l === "object" && l !== null && !Array.isArray(l)) ls = [l];
      }
      for (const l of ls) {
        const pts = pointsOf(get(l, "points"));
        leaders += `<path d="${pathOf(pts, false)}" fill="none" stroke="#424242" stroke-width="1"/>`;
        const u = get(l, "underline");
        if (Array.isArray(u)) {
          leaders += `<path d="${pathOf(pointsOf(u), false)}" fill="none" stroke="#424242" stroke-width="1"/>`;
        }
        if (pts.length > 0) leaders += `<circle cx="${f(pts[0]!.x)}" cy="${f(pts[0]!.y)}" r="1.2" fill="#424242"/>`;
      }
      const cost = num(get(p, "cost"), 0);
      const title = `${id} · ${str(get(p, "anchor_side"))} · cost ${fmtFixed(cost, 3)} · rank ${jsonDisplay(get(get(p, "priority"), "rank"))}`;
      labels += `<g class="label" data-id="${esc(id)}"><title>${esc(title)}</title><rect x="${f(x)}" y="${f(y)}" width="${f(w)}" height="${f(h)}" fill="#ffffff" fill-opacity="0.75"/>`;
      const t = get(p, "text");
      if (t !== undefined) labels += drawText(t, x, y);
      for (const part of itemsOf(get(p, "parts"))) {
        const pb = get(part, "box");
        const px = num(get(pb, "x"), 0);
        const py = num(get(pb, "y"), 0);
        const pw = num(get(pb, "w"), 0);
        const ph = num(get(pb, "h"), 0);
        if (get(part, "type") === "text") {
          const pt = get(part, "text");
          if (pt !== undefined) labels += drawText(pt, px, py);
        } else {
          labels += `<rect x="${f(px)}" y="${f(py)}" width="${f(pw)}" height="${f(ph)}" fill="#000000" fill-opacity="0.5"/>`;
        }
      }
      labels += "</g>";
    } else if (model !== null) {
      const it = model.items[k];
      if (it !== undefined) {
        const c = it.anchor;
        const join = (v: unknown): string => {
          if (!Array.isArray(v)) return "";
          return v.filter((x): x is string => typeof x === "string").join(", ");
        };
        const title = `${id} unplaced: ${str(get(p, "reason"))} (blocking: ${join(get(p, "blocking"))}; blocked by: ${join(get(p, "blocked_by"))})`;
        unplaced += `<g class="unplaced" data-id="${esc(id)}"><title>${esc(title)}</title><path d="M${f(c.x - 3)} ${f(c.y - 3)}L${f(c.x + 3)} ${f(c.y + 3)}M${f(c.x - 3)} ${f(c.y + 3)}L${f(c.x + 3)} ${f(c.y - 3)}" stroke="#d32f2f" stroke-width="1.5"/></g>`;
      }
    }
  });
  s += `<g id="leaders">${leaders}</g><g id="labels">${labels}</g><g id="unplaced">${unplaced}</g>`;
  const st = get(result, "stats");
  s += `<g id="stats"><text x="${f(vb.x0 + 4)}" y="${f(vb.y1 - 4)}" font-size="9" fill="#757575">placed ${jsonDisplay(get(st, "placed"))}/${jsonDisplay(get(st, "total"))} · hard violations ${jsonDisplay(get(st, "hard_violations"))} · crossings ${jsonDisplay(get(st, "leader_crossings"))} · inversions ${jsonDisplay(get(st, "priority_inversions"))} · ${fmtFixed(num(get(st, "runtime_ms"), 0), 1)} ms</text></g>`;
  s += "</svg>";
  return s;
}

// --------------------------------------------------------------------------------------
// Minimal PNG encoder (stored deflate blocks) and base64
// --------------------------------------------------------------------------------------

let CRC_TABLE: Uint32Array | null = null;

function crc32(data: Uint8Array, start: number, end: number): number {
  if (CRC_TABLE === null) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1;
      table[n] = c;
    }
    CRC_TABLE = table;
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = (CRC_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Encode an RGBA image (uncompressed deflate; small debug images only). */
export function pngRgba(w: number, h: number, px: (i: number, out: Uint8Array, o: number) => void): Uint8Array {
  const raw = new Uint8Array((w * 4 + 1) * h);
  let o = 0;
  for (let y = 0; y < h; y++) {
    raw[o++] = 0;
    for (let x = 0; x < w; x++) {
      px(y * w + x, raw, o);
      o += 4;
    }
  }
  const nChunks = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + (nChunks === 0 ? 5 : nChunks * 5 + raw.length) + 4);
  let zo = 0;
  z[zo++] = 0x78;
  z[zo++] = 0x01;
  if (nChunks === 0) {
    z.set([1, 0, 0, 0xff, 0xff], zo);
    zo += 5;
  }
  for (let k = 0; k < nChunks; k++) {
    const start = k * 65535;
    const end = Math.min(start + 65535, raw.length);
    const len = end - start;
    z[zo++] = k === nChunks - 1 ? 1 : 0;
    z[zo++] = len & 0xff;
    z[zo++] = len >>> 8;
    const nlen = ~len & 0xffff;
    z[zo++] = nlen & 0xff;
    z[zo++] = nlen >>> 8;
    z.set(raw.subarray(start, end), zo);
    zo += len;
  }
  const ad = adler32(raw);
  z[zo++] = ad >>> 24;
  z[zo++] = (ad >>> 16) & 0xff;
  z[zo++] = (ad >>> 8) & 0xff;
  z[zo++] = ad & 0xff;
  const chunks: [string, Uint8Array][] = [
    ["IHDR", new Uint8Array([w >>> 24, (w >>> 16) & 0xff, (w >>> 8) & 0xff, w & 0xff, h >>> 24, (h >>> 16) & 0xff, (h >>> 8) & 0xff, h & 0xff, 8, 6, 0, 0, 0])],
    ["IDAT", z],
    ["IEND", new Uint8Array(0)],
  ];
  let total = 8;
  for (const [, d] of chunks) total += 12 + d.length;
  const out = new Uint8Array(total);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  let p = 8;
  for (const [ty, d] of chunks) {
    const n = d.length;
    out[p++] = n >>> 24;
    out[p++] = (n >>> 16) & 0xff;
    out[p++] = (n >>> 8) & 0xff;
    out[p++] = n & 0xff;
    const typeStart = p;
    for (let k = 0; k < 4; k++) out[p++] = ty.charCodeAt(k);
    out.set(d, p);
    p += n;
    const crc = crc32(out, typeStart, p);
    out[p++] = crc >>> 24;
    out[p++] = (crc >>> 16) & 0xff;
    out[p++] = (crc >>> 8) & 0xff;
    out[p++] = crc & 0xff;
  }
  return out;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Standard base64. */
export function base64(data: Uint8Array): string {
  const parts: string[] = [];
  let s = "";
  for (let i = 0; i < data.length; i += 3) {
    const n0 = data[i]!;
    const n1 = i + 1 < data.length ? data[i + 1]! : 0;
    const n2 = i + 2 < data.length ? data[i + 2]! : 0;
    const n = (n0 << 16) | (n1 << 8) | n2;
    s += B64[(n >>> 18) & 63]!;
    s += B64[(n >>> 12) & 63]!;
    s += i + 1 < data.length ? B64[(n >>> 6) & 63]! : "=";
    s += i + 2 < data.length ? B64[n & 63]! : "=";
    if (s.length >= 8192) {
      parts.push(s);
      s = "";
    }
  }
  parts.push(s);
  return parts.join("");
}
