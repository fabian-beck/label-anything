/**
 * Drawing a step of a trace: the scene's background, the marks (colored by priority band),
 * the labels placed after the step, and an overlay of the candidates the step is about —
 * free ones shaded by cost, ruled-out ones crossed, the chosen one bold, a move's arrow.
 */
import type { LabelResult, TraceCandidate } from "@label-anything/core";
import { drawLabels, roundRect, type Placement } from "../render.js";
import type { Explained, Move } from "./model.js";

export interface View {
  scale: number;
  ox: number;
  oy: number;
}

/** How a candidate of the overlay is drawn. */
export type CandStyle =
  /** free: shaded by cost (`t` 0 = the cheapest shown) */
  | "free"
  | "chosen"
  /** ruled out by a placed label */
  | "dead"
  /** breaks a hard rule by itself */
  | "infeasible"
  /** dropped when generated (pruned, beyond k_distant, blocked) */
  | "dropped"
  /** not evaluated yet (lazy ladder candidates) */
  | "lazy"
  /** a move's old position */
  | "from"
  /** a move's target, accepted */
  | "to"
  /** a move's target, not taken */
  | "refused";

export interface OverlayCand {
  cand: number;
  style: CandStyle;
  t?: number;
  /** A rank badge (scores). */
  rank?: number;
}

export interface Overlay {
  /** The item the step is about (or the pinned one). */
  focus: number | null;
  cands: OverlayCand[];
  arrows: { from: number; to: number; ok: boolean }[];
  /** Rings around marks: `warn` (deferred, no label), `band` (members of a band). */
  rings: { item: number; kind: "focus" | "warn" | "band" }[];
  /** Items whose labels changed in the step. */
  changed: number[];
}

const ACCENT = [57, 73, 171] as const;
const rgba = (c: readonly number[], a: number): string => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;
const RED = "#d32f2f";
const AMBER = "#f59e0b";

export const BAND_COLORS = ["#1a237e", "#3f51b5", "#7986cb", "#9fa8da", "#b8bfe6"];
const ONE_BAND = "#37474f";

export function bandColor(ex: Explained, i: number): string {
  if (ex.bands <= 1) return ONE_BAND;
  const b = ex.bandOf[i]!;
  return BAND_COLORS[Math.min(BAND_COLORS.length - 1, Math.round((b * (BAND_COLORS.length - 1)) / Math.max(1, ex.bands - 1)))]!;
}

/** The view that fits a `w` × `h` problem into a `cw` × `ch` drawing. */
export function fitView(w: number, h: number, cw: number, ch: number, pad = 12): View {
  const scale = Math.max(0.1, Math.min((cw - 2 * pad) / w, (ch - 2 * pad) / h));
  return { scale, ox: (cw - w * scale) / 2, oy: (ch - h * scale) / 2 };
}

function costShade(ex: Explained, ids: readonly number[], total?: (c: number) => number): Map<number, number> {
  const val = (c: number) => (total ? total(c) : ex.trace.candidates[c]!.cost ?? Infinity);
  let lo = Infinity;
  let hi = -Infinity;
  for (const c of ids) {
    const v = val(c);
    if (!Number.isFinite(v)) continue;
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const out = new Map<number, number>();
  for (const c of ids) {
    const v = val(c);
    out.set(c, Number.isFinite(v) && hi > lo ? (v - lo) / (hi - lo) : 0);
  }
  return out;
}

function staticStyle(c: TraceCandidate): CandStyle {
  if (c.fate !== "kept") return "dropped";
  if (c.feasible === null) return "lazy";
  return c.feasible ? "free" : "infeasible";
}

/** The candidates of item `i` as they stand before event `k` of the greedy pass (free, ruled out, unusable). */
function itemCands(ex: Explained, i: number, k: number, inGreedy: boolean): OverlayCand[] {
  const ids = ex.generatedBy(i, k);
  const out: OverlayCand[] = [];
  const free: number[] = [];
  for (const c of ids) {
    const t = ex.trace.candidates[c]!;
    let style = staticStyle(t);
    if (style === "free" && inGreedy && !ex.aliveAt(c, k)) style = "dead";
    if (style === "free") free.push(c);
    out.push({ cand: c, style });
  }
  const shade = costShade(ex, free);
  for (const o of out) if (o.style === "free") o.t = shade.get(o.cand);
  return out;
}

/** What to show over the drawing at event `k`; `pinned`: an item the reader selected. */
export function buildOverlay(ex: Explained, k: number, pinned: number | null): Overlay {
  const e = ex.event(k);
  const tr = ex.trace;
  const ov: Overlay = { focus: null, cands: [], arrows: [], rings: [], changed: e.changes.map(([i]) => i) };
  const group = ex.groupAt(k).id;
  const inGreedy = group === "greedy";
  switch (e.type) {
    case "generate": {
      ov.focus = e.item;
      const free = e.cands.filter((c) => staticStyle(tr.candidates[c]!) === "free");
      const shade = costShade(ex, free);
      for (const c of e.cands) {
        const style = staticStyle(tr.candidates[c]!);
        ov.cands.push({ cand: c, style, t: style === "free" ? shade.get(c) : undefined });
      }
      break;
    }
    case "band":
      for (const i of e.items) ov.rings.push({ item: i, kind: "band" });
      break;
    case "pick":
    case "defer":
    case "omit":
      ov.focus = e.item;
      ov.cands = itemCands(ex, e.item, k, inGreedy).filter((o) => o.style !== "dropped");
      if (e.type !== "pick") ov.rings.push({ item: e.item, kind: "warn" });
      break;
    case "score": {
      ov.focus = e.item;
      // with lookahead, only the eight cheapest compete (they have a lookahead value)
      const la = e.options.some((o) => o.lookahead !== null);
      const contenders = e.options.filter((o) => !la || o.lookahead !== null);
      const totals = new Map(contenders.map((o) => [o.cand, o.cost + o.dynamic + (o.lookahead ?? 0)]));
      const ids = contenders.map((o) => o.cand);
      const shade = costShade(ex, ids, (c) => totals.get(c)!);
      const ranked = ids.slice().sort((a, b) => totals.get(a)! - totals.get(b)!);
      // the item's other candidates, ruled out
      for (const o of itemCands(ex, e.item, k, inGreedy)) if (o.style === "dead") ov.cands.push(o);
      for (const o of e.options) {
        const r = ranked.indexOf(o.cand);
        if (r < 0) ov.cands.push({ cand: o.cand, style: "free", t: 1 });
        else ov.cands.push({ cand: o.cand, style: o.cand === e.chosen ? "chosen" : "free", t: shade.get(o.cand), rank: r < 3 ? r + 1 : undefined });
      }
      break;
    }
    case "place":
      ov.focus = e.item;
      for (const c of e.killed) ov.cands.push({ cand: c, style: "dead" });
      break;
    case "ladder": {
      ov.focus = e.item;
      for (const c of e.cands) {
        const st = c === e.chosen ? "chosen" : staticStyle(tr.candidates[c]!);
        ov.cands.push({ cand: c, style: st === "free" ? "free" : st, t: 0.5 });
      }
      if (e.chosen !== null && !e.cands.includes(e.chosen)) ov.cands.push({ cand: e.chosen, style: "chosen" });
      break;
    }
    case "evict": {
      ov.focus = e.item;
      const before = ex.placementAt(k - 1).slice();
      for (const j of e.evicted) if (before[j]! >= 0) ov.cands.push({ cand: before[j]!, style: "from" });
      break;
    }
    case "move":
      moveOverlay(ex, k, e, ov);
      break;
    case "pass":
      for (const i of e.items) ov.rings.push({ item: i, kind: "focus" });
      break;
    default:
      break;
  }
  if (group === "search" || group === "repairs" || group === "verify") {
    const placed = ex.placementAt(k);
    for (let i = 0; i < placed.length; i++) if (placed[i]! < 0) ov.rings.push({ item: i, kind: "warn" });
  }
  if (pinned !== null && pinned !== ov.focus) {
    // the pinned item's candidates as they stand
    const extra = itemCands(ex, pinned, k, inGreedy).filter((o) => o.style !== "dropped");
    const shown = new Set(ov.cands.map((o) => o.cand));
    for (const o of extra) if (!shown.has(o.cand)) ov.cands.push(o);
    ov.rings.push({ item: pinned, kind: "focus" });
  } else if (ov.focus !== null) ov.rings.push({ item: ov.focus, kind: "focus" });
  return ov;
}

function moveOverlay(ex: Explained, k: number, e: Move, ov: Overlay): void {
  if (e.item < 0) return;
  ov.focus = e.item;
  const ok = e.outcome === "improved" || e.outcome === "accepted";
  if (e.outcome === "inserted") {
    const before = ex.placementAt(k - 1).slice();
    const after = ex.placementAt(k);
    for (const [i] of e.changes) {
      if (i === e.item || before[i]! < 0 || after[i]! < 0) continue;
      ov.cands.push({ cand: before[i]!, style: "from" });
      ov.arrows.push({ from: before[i]!, to: after[i]!, ok: true });
    }
    return;
  }
  if (e.from < 0 || e.to < 0) return;
  ov.cands.push({ cand: e.from, style: "from" });
  ov.cands.push({ cand: e.to, style: ok ? "to" : "refused" });
  ov.arrows.push({ from: e.from, to: e.to, ok });
  if (e.kind === "swap" && e.other >= 0) {
    const before = ex.placementAt(k - 1)[e.other]!;
    if (before >= 0 && e.otherTo >= 0) {
      ov.cands.push({ cand: before, style: "from" });
      ov.cands.push({ cand: e.otherTo, style: ok ? "to" : "refused" });
      ov.arrows.push({ from: before, to: e.otherTo, ok });
    }
  }
}

/** The labels placed after event `k`, as placements for `drawLabels`. */
export function placementsAt(ex: Explained, k: number): Placement[] {
  const tr = ex.trace;
  const placed = ex.placementAt(k);
  const out: Placement[] = [];
  for (let i = 0; i < placed.length; i++) {
    const c = placed[i]!;
    if (c < 0) continue;
    const t = tr.candidates[c]!;
    const v = tr.items[i]!.variants[t.variant];
    out.push({
      id: tr.items[i]!.id,
      placed: true,
      box: { x: t.box[0], y: t.box[1], w: t.box[2], h: t.box[3] },
      text: (v?.text ?? undefined) as Placement["text"],
      leader: (t.leaders[0] ?? null) as unknown as Placement["leader"],
      leaders: (t.leaders.length > 1 ? t.leaders : undefined) as Placement["leaders"],
    } as Placement);
  }
  return out;
}

type Shape = { shape: string; x: number; y: number; r?: number; rx?: number; ry?: number; w?: number; h?: number; rotation?: number; rings?: number[][][] };

function shapePath(ctx: CanvasRenderingContext2D, s: Shape): void {
  ctx.beginPath();
  switch (s.shape) {
    case "circle":
      ctx.arc(s.x, s.y, Math.max(s.r ?? 2, 1.5), 0, Math.PI * 2);
      break;
    case "ellipse":
      ctx.ellipse(s.x, s.y, s.rx ?? 2, s.ry ?? 2, ((s.rotation ?? 0) * Math.PI) / 180, 0, Math.PI * 2);
      break;
    case "rect":
      ctx.save();
      ctx.translate(s.x, s.y);
      ctx.rotate(((s.rotation ?? 0) * Math.PI) / 180);
      ctx.rect(-(s.w ?? 4) / 2, -(s.h ?? 4) / 2, s.w ?? 4, s.h ?? 4);
      ctx.restore();
      break;
    case "polygon":
      for (const ring of s.rings ?? []) ring.forEach((p, i) => (i ? ctx.lineTo(p[0]!, p[1]!) : ctx.moveTo(p[0]!, p[1]!)));
      ctx.closePath();
      break;
    default:
      ctx.arc(s.x, s.y, 2.5, 0, Math.PI * 2);
  }
}

function center(c: TraceCandidate): [number, number] {
  return [c.box[0] + c.box[2] / 2, c.box[1] + c.box[3] / 2];
}

export interface Hover {
  cand: number | null;
  item: number | null;
}

/** Draw event `k` of `ex` (the context is in CSS px; `view` maps problem px onto it). */
export function drawStage(
  ctx: CanvasRenderingContext2D,
  view: View,
  ex: Explained,
  k: number,
  ov: Overlay,
  hover: Hover,
  background: (ctx: CanvasRenderingContext2D) => void,
  canvas: { width: number; height: number },
): void {
  const tr = ex.trace;
  const px = 1 / view.scale;
  ctx.save();
  ctx.translate(view.ox, view.oy);
  ctx.scale(view.scale, view.scale);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, canvas.width, canvas.height);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  background(ctx);
  ctx.restore();
  ctx.strokeStyle = "#d5dae1";
  ctx.lineWidth = px;
  ctx.strokeRect(0, 0, canvas.width, canvas.height);

  // areas, then marks
  ctx.save();
  tr.items.forEach((it) => {
    if (!it.area) return;
    shapePath(ctx, it.area as Shape);
    ctx.fillStyle = "rgba(129, 178, 120, 0.28)";
    ctx.fill("evenodd");
    ctx.strokeStyle = "rgba(85, 139, 47, 0.7)";
    ctx.lineWidth = px;
    ctx.stroke();
  });
  tr.items.forEach((it, i) => {
    if (it.area) return;
    shapePath(ctx, it.shape as Shape);
    ctx.fillStyle = bandColor(ex, i);
    ctx.fill();
  });
  ctx.restore();

  // labels after the step
  const focusId = ov.focus !== null ? tr.items[ov.focus]!.id : null;
  const placements = placementsAt(ex, k);
  drawLabels(ctx, { placements } as unknown as LabelResult, "box", undefined, undefined, focusId === null ? undefined : (id) => (id === focusId ? 1 : 0.72));

  // labels that changed in the step
  ctx.save();
  ctx.strokeStyle = AMBER;
  ctx.lineWidth = 2 * px;
  const placed = ex.placementAt(k);
  for (const i of ov.changed) {
    const c = placed[i]!;
    if (c < 0) continue;
    const b = tr.candidates[c]!.box;
    roundRect(ctx, b[0] - px, b[1] - px, b[2] + 2 * px, b[3] + 2 * px, 2);
    ctx.stroke();
  }
  ctx.restore();

  // rings
  ctx.save();
  for (const r of ov.rings) {
    const a = tr.items[r.item]!.anchor;
    ctx.beginPath();
    ctx.arc(a[0], a[1], (r.kind === "band" ? 6 : 7.5) * Math.max(px, 0.6), 0, Math.PI * 2);
    ctx.strokeStyle = r.kind === "warn" ? RED : r.kind === "band" ? rgba(ACCENT, 0.55) : rgba(ACCENT, 1);
    ctx.lineWidth = (r.kind === "focus" ? 2 : 1.5) * px;
    ctx.stroke();
  }
  ctx.restore();

  // the overlay's candidates (dropped, infeasible and ruled-out ones first)
  const order: CandStyle[] = ["dropped", "infeasible", "lazy", "dead", "from", "free", "refused", "to", "chosen"];
  const sorted = ov.cands.slice().sort((a, b) => order.indexOf(a.style) - order.indexOf(b.style) || (b.t ?? 0) - (a.t ?? 0));
  // many overlapping candidates (sliders) would add up to a blot: fainter the more there are
  const fade = Math.min(1, Math.sqrt(14 / Math.max(1, ov.cands.length)));
  for (const o of sorted) drawCand(ctx, tr.candidates[o.cand]!, o, px, hover.cand === o.cand, fade);
  for (const a of ov.arrows) drawArrow(ctx, center(tr.candidates[a.from]!), center(tr.candidates[a.to]!), a.ok ? "#1e7b3c" : RED, px);
  for (const o of sorted) if (o.rank !== undefined) drawBadge(ctx, tr.candidates[o.cand]!, String(o.rank), o.style === "chosen", px);

  // the hovered candidate or item
  if (hover.cand !== null && !ov.cands.some((o) => o.cand === hover.cand)) drawCand(ctx, tr.candidates[hover.cand]!, { cand: hover.cand, style: "free", t: 0 }, px, true);
  if (hover.item !== null) {
    const a = tr.items[hover.item]!.anchor;
    ctx.beginPath();
    ctx.arc(a[0], a[1], 7 * Math.max(px, 0.6), 0, Math.PI * 2);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 2 * px;
    ctx.stroke();
    const c = placed[hover.item]!;
    if (c >= 0) {
      const b = tr.candidates[c]!.box;
      ctx.strokeStyle = AMBER;
      roundRect(ctx, b[0] - px, b[1] - px, b[2] + 2 * px, b[3] + 2 * px, 2);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function leaderPath(ctx: CanvasRenderingContext2D, c: TraceCandidate): void {
  for (const l of c.leaders) {
    const pts = (l as { points?: (number | null)[][] }).points ?? [];
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0] ?? 0, p[1] ?? 0) : ctx.moveTo(p[0] ?? 0, p[1] ?? 0)));
    ctx.stroke();
  }
}

function drawCand(ctx: CanvasRenderingContext2D, c: TraceCandidate, o: OverlayCand, px: number, hot: boolean, fade = 1): void {
  const [x, y, w, h] = c.box;
  ctx.save();
  let stroke = rgba(ACCENT, 0.9);
  let fill: string | null = null;
  let lw = 1;
  let dash: number[] = [];
  let cross = false;
  switch (o.style) {
    case "free": {
      const t = o.t ?? 0;
      stroke = rgba(ACCENT, (0.2 + 0.75 * (1 - t)) * (t < 0.05 ? 1 : fade));
      fill = t < 0.05 ? rgba(ACCENT, 0.16) : rgba(ACCENT, 0.1 * (1 - t) * fade);
      break;
    }
    case "chosen":
      stroke = rgba(ACCENT, 1);
      fill = rgba(ACCENT, 0.2);
      lw = 2.5;
      break;
    case "dead":
      stroke = `rgba(211, 47, 47, ${0.25 + 0.4 * fade})`;
      dash = [3, 2];
      cross = true;
      break;
    case "infeasible":
      stroke = `rgba(110, 118, 132, ${0.25 + 0.35 * fade})`;
      dash = [2, 3];
      break;
    case "dropped":
      stroke = "rgba(150, 158, 172, 0.45)";
      dash = [1, 3];
      break;
    case "lazy":
      stroke = rgba(ACCENT, 0.55);
      dash = [4, 3];
      break;
    case "from":
      stroke = "rgba(93, 102, 118, 0.85)";
      dash = [3, 3];
      break;
    case "to":
      stroke = "#1e7b3c";
      fill = "rgba(30, 123, 60, 0.14)";
      lw = 2;
      break;
    case "refused":
      stroke = RED;
      fill = "rgba(211, 47, 47, 0.08)";
      lw = 1.5;
      dash = [4, 2];
      break;
  }
  if (hot) {
    lw += 1.5;
    stroke = o.style === "dead" || o.style === "refused" ? RED : rgba(ACCENT, 1);
  }
  ctx.lineWidth = lw * px;
  ctx.setLineDash(dash.map((d) => d * px));
  ctx.strokeStyle = stroke;
  if (c.leaders.length && o.style !== "dropped") {
    ctx.globalAlpha = hot ? 1 : 0.7;
    leaderPath(ctx, c);
    ctx.globalAlpha = 1;
  }
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fillRect(x, y, w, h);
  }
  ctx.strokeRect(x, y, w, h);
  if (cross) {
    ctx.setLineDash([]);
    ctx.lineWidth = 0.7 * px;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y);
    ctx.lineTo(x, y + h);
    ctx.stroke();
  }
  ctx.restore();
}

function drawArrow(ctx: CanvasRenderingContext2D, a: [number, number], b: [number, number], color: string, px: number): void {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 2) return;
  const ux = dx / len;
  const uy = dy / len;
  const head = 7 * px;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6 * px;
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0] - ux * head, b[1] - uy * head);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(b[0], b[1]);
  ctx.lineTo(b[0] - ux * head - uy * head * 0.55, b[1] - uy * head + ux * head * 0.55);
  ctx.lineTo(b[0] - ux * head + uy * head * 0.55, b[1] - uy * head - ux * head * 0.55);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawBadge(ctx: CanvasRenderingContext2D, c: TraceCandidate, text: string, strong: boolean, px: number): void {
  const r = 6.5 * px;
  const x = c.box[0];
  const y = c.box[1];
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = strong ? rgba(ACCENT, 1) : "#ffffff";
  ctx.strokeStyle = rgba(ACCENT, 1);
  ctx.lineWidth = px;
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = strong ? "#ffffff" : rgba(ACCENT, 1);
  ctx.font = `700 ${9 * px}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, x, y + 0.5 * px);
  ctx.restore();
}

/** What is under the point (problem px): an overlay candidate (topmost, smallest first), else a label or mark. */
export function hitTest(ex: Explained, k: number, ov: Overlay, x: number, y: number, tol: number): Hover {
  const tr = ex.trace;
  let best: number | null = null;
  let bestArea = Infinity;
  for (const o of ov.cands) {
    const [bx, by, bw, bh] = tr.candidates[o.cand]!.box;
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh && bw * bh < bestArea) {
      best = o.cand;
      bestArea = bw * bh;
    }
  }
  if (best !== null) return { cand: best, item: null };
  let item: number | null = null;
  let d = tol;
  tr.items.forEach((it, i) => {
    const dd = Math.hypot(it.anchor[0] - x, it.anchor[1] - y);
    if (dd < d) {
      d = dd;
      item = i;
    }
  });
  if (item !== null) return { cand: null, item };
  const placed = ex.placementAt(k);
  for (let i = placed.length - 1; i >= 0; i--) {
    const c = placed[i]!;
    if (c < 0) continue;
    const [bx, by, bw, bh] = tr.candidates[c]!.box;
    if (x >= bx && x <= bx + bw && y >= by && y <= by + bh) return { cand: null, item: i };
  }
  return { cand: null, item: null };
}
