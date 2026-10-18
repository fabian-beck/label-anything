/**
 * The phase timeline under the drawing: one segment per phase of the solve, each step a
 * position in its segment (the greedy pass's placements as ticks, the local search's cost
 * as a curve), and a playhead to drag.
 */
import type { Explained, GroupId } from "./model.js";

const WEIGHTS: Record<GroupId, number> = { prepare: 0.55, candidates: 1.5, greedy: 3, search: 3.2, repairs: 1, verify: 0.55 };
const MIN_W = 54;

interface Seg {
  id: GroupId;
  title: string;
  start: number;
  end: number;
  x0: number;
  x1: number;
}

export class Timeline {
  #canvas: HTMLCanvasElement;
  #ex: Explained | null = null;
  #step = 0;
  #segs: Seg[] = [];
  #width = 0;
  #height = 0;
  #dragging = false;
  #hoverX: number | null = null;
  #series: { cost: Float64Array; best: Float64Array } | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    private readonly onSeek: (k: number) => void,
  ) {
    this.#canvas = canvas;
    canvas.addEventListener("pointerdown", (e) => {
      this.#dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.#seek(e.offsetX);
    });
    canvas.addEventListener("pointermove", (e) => {
      this.#hoverX = e.offsetX;
      if (this.#dragging) this.#seek(e.offsetX);
      else this.draw();
    });
    canvas.addEventListener("pointerup", () => (this.#dragging = false));
    canvas.addEventListener("pointercancel", () => (this.#dragging = false));
    canvas.addEventListener("pointerleave", () => {
      this.#hoverX = null;
      this.draw();
    });
    new ResizeObserver(() => this.#layout()).observe(canvas);
  }

  setData(ex: Explained): void {
    this.#ex = ex;
    const s = ex.searchSeries();
    this.#series = { cost: s.cost, best: s.best };
    this.#layout();
  }

  setStep(k: number): void {
    this.#step = k;
    this.draw();
  }

  /** The step under x (CSS px). */
  stepAt(x: number): number {
    const seg = this.#segs.find((s) => x < s.x1) ?? this.#segs[this.#segs.length - 1];
    if (!seg) return 0;
    const f = Math.min(0.999999, Math.max(0, (x - seg.x0) / (seg.x1 - seg.x0)));
    return seg.start + Math.floor(f * (seg.end - seg.start));
  }

  #xOf(k: number): number {
    const seg = this.#segs.find((s) => k >= s.start && k < s.end) ?? this.#segs[this.#segs.length - 1];
    if (!seg) return 0;
    return seg.x0 + ((k - seg.start + 0.5) / (seg.end - seg.start)) * (seg.x1 - seg.x0);
  }

  #seek(x: number): void {
    const k = this.stepAt(x);
    if (k !== this.#step) this.onSeek(k);
  }

  #layout(): void {
    const c = this.#canvas;
    const dpr = window.devicePixelRatio || 1;
    this.#width = c.clientWidth;
    this.#height = c.clientHeight;
    c.width = Math.round(this.#width * dpr);
    c.height = Math.round(this.#height * dpr);
    this.#segs = [];
    const ex = this.#ex;
    if (ex && this.#width > 0) {
      const gs = ex.groups;
      const total = gs.reduce((a, g) => a + WEIGHTS[g.id], 0);
      const gap = 3;
      const avail = this.#width - gap * (gs.length - 1);
      let widths = gs.map((g) => Math.max(MIN_W, (WEIGHTS[g.id] / total) * avail));
      const scale = avail / widths.reduce((a, b) => a + b, 0);
      widths = widths.map((w) => w * scale);
      let x = 0;
      gs.forEach((g, i) => {
        this.#segs.push({ id: g.id, title: g.title, start: g.start, end: g.end, x0: x, x1: x + widths[i]! });
        x += widths[i]! + gap;
      });
    }
    this.draw();
  }

  draw(): void {
    const c = this.#canvas;
    const ctx = c.getContext("2d");
    const ex = this.#ex;
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.#width, this.#height);
    if (!ex) return;
    const css = getComputedStyle(c);
    const fg = css.getPropertyValue("--fg").trim() || "#1b2130";
    const muted = css.getPropertyValue("--muted").trim() || "#5d6676";
    const accent = css.getPropertyValue("--accent").trim() || "#3949ab";
    const track = css.getPropertyValue("--panel-2").trim() || "#f6f7f9";
    const rule = css.getPropertyValue("--rule-strong").trim() || "#c7ccd5";
    const H = this.#height;
    const top = 17;
    const bh = H - top - 3;
    const cur = ex.groupAt(this.#step).id;
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textBaseline = "alphabetic";
    for (const s of this.#segs) {
      const active = s.id === cur;
      ctx.fillStyle = track;
      roundRect(ctx, s.x0, top, s.x1 - s.x0, bh, 4);
      ctx.fill();
      ctx.strokeStyle = active ? accent : rule;
      ctx.lineWidth = 1;
      roundRect(ctx, s.x0 + 0.5, top + 0.5, s.x1 - s.x0 - 1, bh - 1, 4);
      ctx.stroke();
      ctx.fillStyle = active ? accent : muted;
      const label = fit(ctx, s.title, s.x1 - s.x0 - 4);
      ctx.fillText(label, s.x0 + 2, 12);
      this.#ticks(ctx, s, top, bh, accent, muted);
    }
    // done part
    const x = this.#xOf(this.#step);
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.fillStyle = accent;
    for (const s of this.#segs) {
      const x1 = Math.min(s.x1, x);
      if (x1 > s.x0) ctx.fillRect(s.x0, top, x1 - s.x0, bh);
    }
    ctx.restore();
    if (this.#hoverX !== null && !this.#dragging) {
      ctx.strokeStyle = muted;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(this.#hoverX + 0.5, top);
      ctx.lineTo(this.#hoverX + 0.5, top + bh);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = fg;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x, top - 2);
    ctx.lineTo(x, top + bh + 1);
    ctx.stroke();
    ctx.fillStyle = fg;
    ctx.beginPath();
    ctx.moveTo(x - 5, top - 6);
    ctx.lineTo(x + 5, top - 6);
    ctx.lineTo(x, top);
    ctx.closePath();
    ctx.fill();
  }

  #ticks(ctx: CanvasRenderingContext2D, s: Seg, top: number, bh: number, accent: string, muted: string): void {
    const ex = this.#ex!;
    const n = s.end - s.start;
    const xOf = (k: number) => s.x0 + ((k - s.start + 0.5) / n) * (s.x1 - s.x0);
    if (s.id === "search" && this.#series && this.#series.cost.length > 1) {
      const { cost, best } = this.#series;
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of cost) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
      const span = hi - lo || 1;
      const y = (v: number) => top + 3 + (1 - (v - lo) / span) * (bh - 6);
      const m = cost.length;
      const first = ex.moves[0]!;
      const step = Math.max(1, Math.floor(m / Math.max(1, s.x1 - s.x0)));
      for (const [arr, color, w] of [[cost, muted, 1], [best, accent, 1.5]] as const) {
        ctx.beginPath();
        for (let j = 0; j < m; j += step) {
          const xx = xOf(first + j);
          if (j === 0) ctx.moveTo(xx, y(arr[j]!));
          else ctx.lineTo(xx, y(arr[j]!));
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = w;
        ctx.stroke();
      }
      return;
    }
    ctx.save();
    for (let k = s.start; k < s.end; k++) {
      const e = ex.event(k);
      let color: string | null = null;
      if (e.type === "place" || (e.type === "pass" && e.kept)) color = accent;
      else if (e.type === "omit") color = "#d32f2f";
      else if (e.type === "generate" || e.type === "defer" || e.type === "ladder") color = muted;
      if (!color) continue;
      ctx.strokeStyle = color;
      ctx.globalAlpha = e.type === "generate" || e.type === "ladder" ? 0.45 : 0.85;
      const xx = Math.round(xOf(k)) + 0.5;
      const h = e.type === "place" || e.type === "omit" ? bh - 8 : bh - 14;
      ctx.beginPath();
      ctx.moveTo(xx, top + (bh - h) / 2);
      ctx.lineTo(xx, top + (bh + h) / 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

function fit(ctx: CanvasRenderingContext2D, s: string, w: number): string {
  if (ctx.measureText(s).width <= w) return s;
  let t = s;
  while (t.length > 1 && ctx.measureText(`${t}…`).width > w) t = t.slice(0, -1);
  return `${t}…`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}
