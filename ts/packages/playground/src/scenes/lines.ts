/**
 * A racing line chart: series whose ends are labeled while time runs. Crowded ends get a
 * column with fanning leaders (fan labels), or every label goes to a column in the right
 * margin (boundary labels); the lines are soft obstacles. Generated data.
 */
import type { Control } from "../controls.js";
import { gauss, nameGen, rng, type Obj } from "../util.js";
import type { Anchors, DrawState, Item, Scene, SceneHost } from "./scene.js";

interface Series {
  id: string;
  name: string;
  values: number[];
  drift: number;
  vol: number;
  color: string;
}

const COLORS = ["#3949ab", "#00897b", "#c2185b", "#ef6c00", "#6d4c41", "#7b1fa2", "#0277bd", "#558b2f", "#ad1457", "#455a64"];
const WINDOW = 90;

export class LinesScene implements Scene {
  readonly id = "lines";
  readonly title = "Line chart";
  readonly hint = "Time runs: the ends of the lines move, their labels follow; crowded ends fan out.";
  readonly about =
    "The end of each line is an item; the lines are soft obstacles. Ends that crowd get a column of labels with fanning leaders (fan labels), or every label goes to a column in the margin (boundary labels).";
  readonly credits = "Generated data (random walks).";
  readonly classes: readonly string[] = ["lines"];
  readonly animated = true;
  readonly cursor = "default" as const;
  readonly view = { budgetMoving: 12, maxRate: 24 };
  readonly controls: Control[] = [
    { key: "count", label: "Series", kind: "range", min: 4, max: 40, step: 1, format: (n) => String(n) },
    {
      key: "mode", label: "End labels", kind: "segmented",
      options: [
        { value: "ends", label: "at the ends", title: "Next to each end, fanning out where crowded" },
        { value: "column", label: "margin column", title: "Boundary labels in a column at the right edge" },
      ],
    },
    { key: "values", label: "Show values", kind: "toggle", hint: "Labels change text (and width) every step" },
  ];
  readonly params: Obj = { count: 18, mode: "ends", values: false };
  playing = false;

  #series: Series[] = [];
  #w = 800;
  #h = 600;
  #t = 0;
  #frac = 0;
  #host!: SceneHost;
  #rand = rng(17);

  async load(host: SceneHost): Promise<void> {
    this.#host = host;
  }

  resize(w: number, h: number): void {
    this.#w = w;
    this.#h = h;
    if (!this.#series.length) this.#build();
  }

  setParam(key: string, value: unknown): void {
    this.params[key] = value;
    if (key === "count") this.#build();
  }

  reset(): void {
    this.#build();
  }

  #build(): void {
    this.#rand = rng(17);
    const name = nameGen(rng(23));
    const n = Number(this.params.count);
    this.#series = Array.from({ length: n }, (_, i) => {
      const s: Series = { id: `s${i}`, name: name(), values: [100], drift: (this.#rand() - 0.45) * 0.006, vol: 0.012 + this.#rand() * 0.03, color: COLORS[i % COLORS.length]! };
      for (let k = 1; k < WINDOW; k++) s.values.push(this.#next(s));
      return s;
    });
    this.#t = WINDOW - 1;
    this.#frac = 0;
    this.#host?.invalidate();
  }

  #next(s: Series): number {
    const v = s.values[s.values.length - 1]!;
    return Math.max(5, v * Math.exp(s.drift + s.vol * gauss(this.#rand)));
  }

  get #plot() {
    const right = this.params.mode === "column" ? 150 : 110;
    return { x0: 56, y0: 24, x1: this.#w - right, y1: this.#h - 60 };
  }

  /** y range of the visible window, padded. */
  #range(): [number, number] {
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of this.#series) {
      for (const v of s.values.slice(-WINDOW - 1)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const pad = (hi - lo) * 0.08 || 1;
    return [lo - pad, hi + pad];
  }

  /** Canvas points of a series, its last point moving smoothly toward the next value. */
  #points(s: Series, range: [number, number]): [number, number][] {
    const { x0, y0, x1, y1 } = this.#plot;
    const vals = s.values.slice(-WINDOW - 1);
    const n = vals.length;
    const dx = (x1 - x0) / (WINDOW - 1);
    const y = (v: number) => y1 - ((v - range[0]) / (range[1] - range[0])) * (y1 - y0);
    const pts: [number, number][] = [];
    for (let i = 0; i < n - 1; i++) pts.push([x0 + (i - this.#frac) * dx, y(vals[i]!)]);
    // the last segment grows during the step
    const a = vals[n - 2]!;
    const b = vals[n - 1]!;
    pts.push([x0 + (n - 2 - this.#frac + this.#frac) * dx, y(a + (b - a) * this.#frac)]);
    return pts.filter((p) => p[0] >= x0 - 0.01);
  }

  #ends(): Map<string, [number, number]> {
    const range = this.#range();
    return new Map(this.#series.map((s) => {
      const pts = this.#points(s, range);
      const e = pts[pts.length - 1]!;
      return [s.id, [round(e[0]), round(e[1])]];
    }));
  }

  options() {
    const p = this.#plot;
    if (this.params.mode === "column") {
      return {
        preset: "auto" as const,
        canvas: { padding: 4 },
        placement: { models: ["boundary"] as "boundary"[], boundary: { sides: ["right"] as "right"[], align: "stack" as const }, fan: "off" as const },
        leaders: { style: "straight" as const },
        avoid: { label: { lines: 1 }, leader: { lines: 0.3 } },
      };
    }
    return {
      preset: "auto" as const,
      canvas: { region: [p.x0, p.y0, this.#w - p.x0 - 6, p.y1 - p.y0] as [number, number, number, number] },
      placement: { models: ["adjacent", "slider", "distant"] as ("adjacent" | "slider" | "distant")[], position_order: ["right", "top-right", "bottom-right"] as ("right" | "top-right" | "bottom-right")[], fan: "auto" as const },
      leaders: { style: "straight" as const, max_length: "10em" },
      avoid: { label: { lines: 1 }, leader: { lines: 0.3 } },
    };
  }

  items(): Item[] {
    const ends = this.#ends();
    const vals = this.params.values === true;
    return this.#series.map((s) => {
      const e = ends.get(s.id)!;
      const v = s.values[s.values.length - 2]! + (s.values[s.values.length - 1]! - s.values[s.values.length - 2]!) * this.#frac;
      return {
        id: s.id,
        anchor: { type: "point", x: e[0], y: e[1], mark: { shape: "circle", r: 2.5 } },
        label: { type: "text", text: vals ? `${s.name} ${v.toFixed(0)}` : s.name },
        priority: round(v),
      };
    });
  }

  obstacles() {
    const range = this.#range();
    return {
      vector: [{
        class: "lines",
        width: 1.5,
        polylines: this.#series.map((s) => simplify(this.#points(s, range)).map((p) => [round(p[0]), round(p[1])] as [number, number])) as never,
      }],
    };
  }

  anchors(): Anchors {
    return this.#ends();
  }

  step(dt: number): boolean {
    // three steps of the series per second
    this.#frac += dt / 330;
    while (this.#frac >= 1) {
      this.#frac -= 1;
      for (const s of this.#series) {
        s.values.push(this.#next(s));
        if (s.values.length > WINDOW + 2) s.values.shift();
      }
      this.#t++;
    }
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void {
    const { x0, y0, x1, y1 } = this.#plot;
    const range = this.#range();
    if (layer === "background") {
      ctx.save();
      ctx.strokeStyle = "#e6e9ee";
      ctx.fillStyle = "#5d6676";
      ctx.font = "11px system-ui, sans-serif";
      ctx.textAlign = "right";
      for (const v of niceTicks(range[0], range[1], 6)) {
        const y = y1 - ((v - range[0]) / (range[1] - range[0])) * (y1 - y0);
        ctx.beginPath();
        ctx.moveTo(x0, y);
        ctx.lineTo(x1, y);
        ctx.stroke();
        ctx.fillText(String(v), x0 - 8, y + 4);
      }
      ctx.textAlign = "center";
      ctx.fillText(`t = ${this.#t}`, x1, y1 + 18);
      ctx.strokeStyle = "#aab1bd";
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x0, y1);
      ctx.lineTo(x1, y1);
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.save();
    const focus = state.selected ?? state.hover;
    ctx.lineJoin = "round";
    for (const s of this.#series) {
      const pts = this.#points(s, range);
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = focus === null || focus === s.id ? 0.85 : 0.25;
      ctx.lineWidth = focus === s.id ? 2.5 : 1.5;
      ctx.stroke();
      const e = pts[pts.length - 1]!;
      ctx.beginPath();
      ctx.arc(e[0], e[1], 2.5, 0, Math.PI * 2);
      ctx.fillStyle = s.color;
      ctx.fill();
    }
    ctx.restore();
  }

  hit(x: number, y: number): string | null {
    for (const [id, e] of this.#ends()) if (Math.hypot(e[0] - x, e[1] - y) < 6) return id;
    return null;
  }
}

/** Every other point of a dense line (the obstacle needs no more detail than the drawing). */
function simplify(pts: [number, number][]): [number, number][] {
  if (pts.length <= 40) return pts;
  return pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const step0 = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= step0) ?? mag * 10;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const round = (v: number) => Math.round(v * 100) / 100;
