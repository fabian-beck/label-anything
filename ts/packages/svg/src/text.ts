// Text layout: <text> (with <tspan>, <a>, <textPath> content) → one box per text chunk.
// Mirrors text.rs (see there for the rules).

import { type Affine, type BBox, apply, bboxOfPoints, bboxUnion } from "./geom.js";
import { parseFirstLength, resolveLength } from "./num.js";
import { type Ctx, MAX_RENDER_DEPTH, type Renderer, docAttr, docTag } from "./render.js";
import { type Anchor, type Computed, firstFamily, isFilled, isStroked } from "./style.js";
import type { Point } from "./types.js";

type Op =
  | { k: "x"; v: number }
  | { k: "y"; v: number }
  | { k: "dx"; v: number }
  | { k: "dy"; v: number }
  | { k: "run"; text: string; style: Computed };

function collapse(t: string, preserve: boolean, state: { lastSpace: boolean }): string {
  if (preserve) {
    const out = t.replace(/[\t\n\r]/g, " ");
    if (out.length > 0) state.lastSpace = out.charCodeAt(out.length - 1) === 0x20;
    return out;
  }
  let out = "";
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) {
      if (!state.lastSpace) {
        out += " ";
        state.lastSpace = true;
      }
    } else {
      out += t.charAt(i);
      state.lastSpace = false;
    }
  }
  return out;
}

function collect(r: Renderer, i: number, style: Computed, ctx: Ctx, ops: Op[], state: { lastSpace: boolean }, depth: number): void {
  const doc = r.doc;
  const fs = style.font_size;
  const first = (name: string) => {
    const v = docAttr(doc, i, name);
    return v === undefined ? null : parseFirstLength(v);
  };
  const x = first("x");
  if (x !== null) ops.push({ k: "x", v: resolveLength(x, fs, ctx.vw) });
  const y = first("y");
  if (y !== null) ops.push({ k: "y", v: resolveLength(y, fs, ctx.vh) });
  const dx = first("dx");
  if (dx !== null) ops.push({ k: "dx", v: resolveLength(dx, fs, ctx.vw) });
  const dy = first("dy");
  if (dy !== null) ops.push({ k: "dy", v: resolveLength(dy, fs, ctx.vh) });
  for (const child of doc.xml.elements[i]!.children) {
    if (typeof child === "string") {
      const s = collapse(child, style.preserve_space, state);
      if (s.length > 0) ops.push({ k: "run", text: s, style });
      continue;
    }
    if (!doc.isSvg[child] || depth >= MAX_RENDER_DEPTH) continue;
    const tag = docTag(doc, child);
    if (tag !== "tspan" && tag !== "a" && tag !== "textPath") continue;
    const cs = r.styleOf(child, ctx, style);
    if (cs.display_none) continue;
    collect(r, child, cs, ctx, ops, state, depth + 1);
  }
}

interface RunBox {
  x: number;
  w: number;
  top: number;
  bottom: number;
  inked: boolean;
}

interface Chunk {
  start: number;
  end: number;
  anchor: Anchor;
  runs: RunBox[];
}

/** The canvas boxes of one text chunk: all runs, and the visible painted runs (or null). */
export interface ChunkBox {
  all: BBox;
  inked: BBox | null;
}

function toCanvas(ctm: Affine, b: BBox): BBox | null {
  const corners: Point[] = [apply(ctm, b.x0, b.y0), apply(ctm, b.x1, b.y0), apply(ctm, b.x1, b.y1), apply(ctm, b.x0, b.y1)];
  for (const p of corners) if (!(Number.isFinite(p[0]) && Number.isFinite(p[1]))) return null;
  return bboxOfPoints(corners);
}

/** Lays out text element `i` (whose CTM is `ctm`); returns its chunks. */
export function layoutText(r: Renderer, i: number, ctx: Ctx, ctm: Affine, style: Computed): ChunkBox[] {
  const ops: Op[] = [];
  collect(r, i, style, ctx, ops, { lastSpace: true }, ctx.depth);
  for (let k = ops.length - 1; k >= 0; k--) {
    const o = ops[k]!;
    if (o.k !== "run") continue;
    if (!o.style.preserve_space && o.text.endsWith(" ")) {
      o.text = o.text.slice(0, -1);
      if (o.text.length === 0) ops.splice(k, 1);
    }
    break;
  }

  const chunks: Chunk[] = [];
  let x = 0;
  let y = 0;
  let newChunk = true;
  for (const op of ops) {
    switch (op.k) {
      case "x":
        x = op.v;
        newChunk = true;
        break;
      case "y":
        y = op.v;
        newChunk = true;
        break;
      case "dx":
        x += op.v;
        break;
      case "dy":
        y += op.v;
        break;
      case "run": {
        const st = op.style;
        if (newChunk || chunks.length === 0) {
          chunks.push({ start: x, end: x, anchor: st.anchor, runs: [] });
          newChunk = false;
        }
        let w = r.measure(op.text, st.font_size, firstFamily(st.font_family), st.font_weight);
        if (!(w >= 0 && Number.isFinite(w))) w = 0;
        const a = r.ascent * st.font_size;
        const d = r.descent * st.font_size;
        let top: number;
        let bottom: number;
        switch (st.baseline) {
          case "alphabetic":
            top = y - a;
            bottom = y + d;
            break;
          case "middle":
            top = y - (a + d) / 2;
            bottom = y + (a + d) / 2;
            break;
          case "hanging":
            top = y;
            bottom = y + (a + d);
            break;
          case "bottom":
            top = y - (a + d);
            bottom = y;
            break;
        }
        const inked = st.visible && (isFilled(st) || isStroked(st));
        const chunk = chunks[chunks.length - 1]!;
        chunk.runs.push({ x, w, top, bottom, inked });
        x += w;
        chunk.end = x;
        break;
      }
    }
  }

  const out: ChunkBox[] = [];
  for (const ch of chunks) {
    const advance = ch.end - ch.start;
    const shift = ch.anchor === "start" ? 0 : ch.anchor === "middle" ? -advance / 2 : -advance;
    let inked: BBox | null = null;
    let all: BBox | null = null;
    for (const run of ch.runs) {
      const b: BBox = { x0: run.x + shift, y0: run.top, x1: run.x + run.w + shift, y1: run.bottom };
      all = bboxUnion(all, b);
      if (run.inked) inked = bboxUnion(inked, { ...b });
    }
    const allC = all === null ? null : toCanvas(ctm, all);
    if (allC === null) continue;
    out.push({ all: allC, inked: inked === null ? null : toCanvas(ctm, inked) });
  }
  return out;
}
