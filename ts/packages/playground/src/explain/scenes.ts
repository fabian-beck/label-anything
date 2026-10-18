/**
 * The explainer's scenes: small problems that show the algorithm's parts — a crowded map
 * (priority bands, the ladder), a scatterplot (most constrained first, local search), line
 * ends (fan labels) and areas with obstacles (internal candidates, costs, hard rules). Each
 * builds an ordinary problem; marks of point items can be dragged.
 */
import type { LabelProblem } from "@label-anything/core";
import { gauss, nameGen, rng } from "../util.js";

export type Item = LabelProblem["items"][number];

export interface SceneControl {
  key: string;
  label: string;
  kind: "range" | "toggle";
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
}

export interface ExplainScene {
  readonly id: string;
  readonly title: string;
  /** What the scene shows of the algorithm (HTML). */
  readonly about: string;
  readonly credits: string;
  readonly controls: SceneControl[];
  readonly params: Record<string, number | boolean>;
  load(base: URL): Promise<void>;
  /** The problem (without the user's options). */
  problem(): LabelProblem;
  /** Drawing under the marks (axes, coastlines, lines, obstacles). */
  background(ctx: CanvasRenderingContext2D): void;
  /** Move the mark of a point item (a drag). */
  move(id: string, x: number, y: number): void;
  draggable(id: string): boolean;
  /** Back to the initial positions. */
  reset(): void;
}

const r1 = (v: number): number => Math.round(v * 10) / 10;

// --- Europe ---------------------------------------------------------------------------

interface Country {
  id: string;
  name: string;
  abbrev: string | null;
  continent: string;
  pop: number;
  label: [number, number];
  parts: [number, number][][][];
}

const LON0 = -25;
const LON1 = 46;
const LAT0 = 34;
const LAT1 = 71.5;
const KX = Math.cos((52 * Math.PI) / 180);
const EU_W = 700;
const EU_S = EU_W / ((LON1 - LON0) * KX);
const EU_H = Math.round((LAT1 - LAT0) * EU_S);

function projEu(p: readonly [number, number]): [number, number] {
  return [(p[0] - LON0) * KX * EU_S, (LAT1 - p[1]) * EU_S];
}

export class EuropeScene implements ExplainScene {
  readonly id = "europe";
  readonly title = "Europe";
  readonly about =
    "The countries of Europe at their label points, in three priority bands by population (more than 30 M, more than 5 M, the rest). Small states crowd the middle: watch them run the ladder — abbreviations, leaders, a smaller font.";
  readonly credits = 'Countries <a href="https://www.naturalearthdata.com/">made with Natural Earth</a> (public domain).';
  readonly controls: SceneControl[] = [
    { key: "bands", label: "Priority bands by population", kind: "toggle", hint: "Off: every country has the same priority (one band)" },
    { key: "abbrev", label: "Abbreviations as alternatives", kind: "toggle", hint: "The ladder's first step tries Natural Earth's abbreviations" },
  ];
  readonly params: Record<string, number | boolean> = { bands: true, abbrev: true };
  #countries: Country[] = [];
  #land: [number, number][][] = [];
  #pos = new Map<string, [number, number]>();

  async load(base: URL): Promise<void> {
    if (this.#countries.length) return;
    const res = await fetch(new URL("data/world.json", base));
    const data = (await res.json()) as { countries: Country[] };
    this.#countries = data.countries.filter((c) => c.continent === "Europe");
    // coastlines of every country in view (decoration only)
    for (const c of data.countries) {
      for (const poly of c.parts) {
        const ring = poly[0]!;
        if (!ring.some(([lon, lat]) => lon > LON0 - 5 && lon < LON1 + 5 && lat > LAT0 - 5 && lat < LAT1 + 5)) continue;
        this.#land.push(ring.map((p) => projEu(p)));
      }
    }
    this.reset();
  }

  reset(): void {
    this.#pos = new Map(this.#countries.map((c) => [c.id, projEu(c.label)]));
  }

  problem(): LabelProblem {
    const items: Item[] = this.#countries.map((c) => {
      const [x, y] = this.#pos.get(c.id)!;
      const label: Item["label"] = { type: "text", text: c.name };
      if (this.params.abbrev && c.abbrev) (label as { alternatives?: string[] }).alternatives = [c.abbrev];
      const it: Item = { id: c.id, anchor: { type: "point", x: r1(x), y: r1(y), mark: { shape: "circle", r: 2.5 } }, label };
      if (this.params.bands) it.tier = c.pop >= 30e6 ? 2 : c.pop >= 5e6 ? 1 : 0;
      return it;
    });
    return { canvas: { width: EU_W, height: EU_H }, items };
  }

  background(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = "#eef3f8";
    ctx.fillRect(0, 0, EU_W, EU_H);
    ctx.fillStyle = "#fbfaf6";
    ctx.strokeStyle = "#cfd6df";
    ctx.lineWidth = 0.6;
    for (const ring of this.#land) {
      ctx.beginPath();
      ring.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  move(id: string, x: number, y: number): void {
    if (this.#pos.has(id)) this.#pos.set(id, [x, y]);
  }

  draggable(id: string): boolean {
    return this.#pos.has(id);
  }
}

// --- Scatterplot ----------------------------------------------------------------------

const SC_W = 640;
const SC_H = 440;
const SC_PLOT = { x0: 40, y0: 16, x1: SC_W - 16, y1: SC_H - 32 };

export class ScatterScene implements ExplainScene {
  readonly id = "scatter";
  readonly title = "Scatterplot";
  readonly about =
    "Points in two clusters and a scattering of outliers, all of the same priority: one band, so the greedy pass is free to place the most constrained point first. Add points or tighten the clusters and watch the local search fix what the greedy pass got wrong.";
  readonly credits = "Generated data and names.";
  readonly controls: SceneControl[] = [
    { key: "count", label: "Points", kind: "range", min: 6, max: 60, step: 1 },
    { key: "spread", label: "Cluster spread", kind: "range", min: 10, max: 80, step: 1 },
    { key: "seed", label: "Data seed", kind: "range", min: 1, max: 30, step: 1 },
  ];
  readonly params: Record<string, number | boolean> = { count: 26, spread: 34, seed: 3 };
  #pts: { id: string; name: string; x: number; y: number }[] = [];

  async load(): Promise<void> {
    if (!this.#pts.length) this.reset();
  }

  reset(): void {
    const r = rng(Number(this.params.seed) * 7919);
    const name = nameGen(rng(Number(this.params.seed) * 104729));
    const n = Number(this.params.count);
    const s = Number(this.params.spread);
    const centers: [number, number][] = [
      [SC_PLOT.x0 + 0.33 * (SC_PLOT.x1 - SC_PLOT.x0), SC_PLOT.y0 + 0.4 * (SC_PLOT.y1 - SC_PLOT.y0)],
      [SC_PLOT.x0 + 0.68 * (SC_PLOT.x1 - SC_PLOT.x0), SC_PLOT.y0 + 0.62 * (SC_PLOT.y1 - SC_PLOT.y0)],
    ];
    this.#pts = [];
    for (let k = 0; k < n; k++) {
      let x: number;
      let y: number;
      if (k % 5 === 4) {
        x = SC_PLOT.x0 + 12 + r() * (SC_PLOT.x1 - SC_PLOT.x0 - 24);
        y = SC_PLOT.y0 + 12 + r() * (SC_PLOT.y1 - SC_PLOT.y0 - 24);
      } else {
        const c = centers[k % 2]!;
        x = c[0] + gauss(r) * s * 1.3;
        y = c[1] + gauss(r) * s;
      }
      x = Math.min(SC_PLOT.x1 - 4, Math.max(SC_PLOT.x0 + 4, x));
      y = Math.min(SC_PLOT.y1 - 4, Math.max(SC_PLOT.y0 + 4, y));
      this.#pts.push({ id: `p${k}`, name: name(), x, y });
    }
  }

  problem(): LabelProblem {
    return {
      canvas: { width: SC_W, height: SC_H, region: [SC_PLOT.x0, SC_PLOT.y0, SC_PLOT.x1 - SC_PLOT.x0, SC_PLOT.y1 - SC_PLOT.y0] },
      items: this.#pts.map((p) => ({
        id: p.id,
        anchor: { type: "point", x: r1(p.x), y: r1(p.y), mark: { shape: "circle", r: 3 } },
        label: { type: "text", text: p.name },
      })),
    };
  }

  background(ctx: CanvasRenderingContext2D): void {
    const { x0, y0, x1, y1 } = SC_PLOT;
    ctx.save();
    ctx.strokeStyle = "#eceff3";
    ctx.lineWidth = 1;
    for (let k = 1; k < 8; k++) {
      const x = x0 + ((x1 - x0) * k) / 8;
      const y = y0 + ((y1 - y0) * k) / 8;
      ctx.beginPath();
      ctx.moveTo(x, y0);
      ctx.lineTo(x, y1);
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#aab1bd";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
  }

  move(id: string, x: number, y: number): void {
    const p = this.#pts.find((q) => q.id === id);
    if (!p) return;
    p.x = Math.min(SC_PLOT.x1, Math.max(SC_PLOT.x0, x));
    p.y = Math.min(SC_PLOT.y1, Math.max(SC_PLOT.y0, y));
  }

  draggable(): boolean {
    return true;
  }
}

// --- Line ends ------------------------------------------------------------------------

const LN_W = 640;
const LN_H = 420;
const LN_PLOT = { x0: 40, y0: 16, x1: 470, y1: LN_H - 30 };
const LINE_COLORS = ["#3949ab", "#00897b", "#c2185b", "#ef6c00", "#6d4c41", "#7b1fa2", "#0277bd", "#558b2f", "#ad1457", "#455a64", "#00838f", "#9e9d24", "#5d4037", "#283593"];
const STEPS = 40;

export class LinesScene implements ExplainScene {
  readonly id = "lines";
  readonly title = "Line ends";
  readonly about =
    "The end of each line is an item; the lines are soft obstacles. Ends that crowd leave items without a label after the search — until the fan pass stacks the crowd's labels in a column with fanning leaders.";
  readonly credits = "Generated data (random walks).";
  readonly controls: SceneControl[] = [
    { key: "count", label: "Lines", kind: "range", min: 3, max: 14, step: 1 },
    { key: "seed", label: "Data seed", kind: "range", min: 1, max: 30, step: 1 },
  ];
  readonly params: Record<string, number | boolean> = { count: 9, seed: 4 };
  #series: { id: string; name: string; ys: number[]; color: string }[] = [];

  async load(): Promise<void> {
    if (!this.#series.length) this.reset();
  }

  reset(): void {
    const r = rng(Number(this.params.seed) * 31337);
    const name = nameGen(rng(Number(this.params.seed) * 65537));
    const n = Number(this.params.count);
    const { y0, y1 } = LN_PLOT;
    this.#series = [];
    for (let k = 0; k < n; k++) {
      const ys = [y0 + (y1 - y0) * (0.15 + 0.7 * r())];
      // the walks converge toward the middle, so that their ends crowd
      const target = y0 + (y1 - y0) * (0.42 + 0.16 * r());
      for (let t = 1; t <= STEPS; t++) {
        const prev = ys[t - 1]!;
        const pull = (target - prev) * (t / STEPS) * 0.18;
        ys.push(Math.min(y1 - 4, Math.max(y0 + 4, prev + pull + gauss(r) * 6)));
      }
      this.#series.push({ id: `s${k}`, name: name(), ys, color: LINE_COLORS[k % LINE_COLORS.length]! });
    }
  }

  #pts(s: { ys: number[] }): [number, number][] {
    const { x0, x1 } = LN_PLOT;
    return s.ys.map((y, t) => [x0 + ((x1 - x0) * t) / STEPS, y]);
  }

  problem(): LabelProblem {
    const { x0, y0, y1 } = LN_PLOT;
    return {
      canvas: { width: LN_W, height: LN_H, region: [x0, y0, LN_W - x0 - 6, y1 - y0] },
      placement: { models: ["adjacent", "slider", "distant"], position_order: ["right", "top-right", "bottom-right"], fan: "auto" },
      leaders: { style: "straight", max_length: "10em" },
      avoid: { label: { lines: 1 }, leader: { lines: 0.3 } },
      items: this.#series.map((s) => {
        const e = this.#pts(s)[STEPS]!;
        return { id: s.id, anchor: { type: "point", x: r1(e[0]), y: r1(e[1]), mark: { shape: "circle", r: 2.5 } }, label: { type: "text", text: s.name } };
      }),
      obstacles: {
        vector: [{ class: "lines", width: 1.5, polylines: this.#series.map((s) => this.#pts(s).map(([x, y]) => [r1(x), r1(y)])) as never }],
      },
    } as LabelProblem;
  }

  background(ctx: CanvasRenderingContext2D): void {
    const { x0, y0, x1, y1 } = LN_PLOT;
    ctx.save();
    ctx.strokeStyle = "#eceff3";
    for (let k = 1; k < 6; k++) {
      const y = y0 + ((y1 - y0) * k) / 6;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "#aab1bd";
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    for (const s of this.#series) {
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      this.#pts(s).forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.stroke();
    }
    ctx.restore();
  }

  move(id: string, _x: number, y: number): void {
    const s = this.#series.find((q) => q.id === id);
    if (!s) return;
    const { y0, y1 } = LN_PLOT;
    const ny = Math.min(y1 - 2, Math.max(y0 + 2, y));
    // the line bends toward the new end over its last steps
    const d = ny - s.ys[STEPS]!;
    for (let t = STEPS - 8; t <= STEPS; t++) s.ys[t] = s.ys[t]! + (d * (t - (STEPS - 8))) / 8;
  }

  draggable(id: string): boolean {
    return this.#series.some((s) => s.id === id);
  }
}

// --- Areas and obstacles --------------------------------------------------------------

const AR_W = 640;
const AR_H = 440;
const RIVER: [number, number][] = [
  [0, 120], [70, 132], [140, 160], [200, 210], [250, 236], [310, 240], [370, 262], [420, 300], [470, 318], [540, 320], [640, 350],
];
const LEGEND: [number, number, number, number] = [470, 18, 150, 76];

interface Place {
  id: string;
  name: string;
  x: number;
  y: number;
}

const AREAS: { id: string; name: string; poly: [number, number][] }[] = [
  { id: "mirren", name: "Mirren Forest", poly: [[70, 230], [150, 226], [212, 262], [222, 318], [170, 360], [96, 354], [52, 300]] },
  { id: "wood", name: "Fenwood", poly: [[300, 44], [420, 38], [446, 90], [430, 150], [356, 168], [296, 128]] },
  { id: "copse", name: "Ashcopse", poly: [[548, 222], [566, 218], [574, 234], [560, 244], [546, 238]] },
  { id: "moor", name: "Grey Moor", poly: [[332, 312], [440, 352], [500, 404], [380, 420], [300, 392]] },
];

const PLACES: Place[] = [
  { id: "v1", name: "Ashby", x: 236, y: 214 },
  { id: "v2", name: "Brindle", x: 262, y: 258 },
  { id: "v3", name: "Corran", x: 300, y: 228 },
  { id: "v4", name: "Dunmore", x: 404, y: 282 },
  { id: "v5", name: "Elsby", x: 452, y: 336 },
  { id: "v6", name: "Farleigh", x: 520, y: 300 },
  { id: "v7", name: "Gilling", x: 118, y: 128 },
  { id: "v8", name: "Hartop", x: 552, y: 108 },
  { id: "v9", name: "Ivel", x: 600, y: 248 },
];

export class AreasScene implements ExplainScene {
  readonly id = "areas";
  readonly title = "Areas & obstacles";
  readonly about =
    "Areas get candidates inside them where the label fits; villages get theirs around the point. The river is a soft obstacle (covering it costs), the legend box a hard one (no label may cover it): hover a candidate to see what each term of its cost adds.";
  readonly credits = "Invented geography.";
  readonly controls: SceneControl[] = [
    { key: "riverCost", label: "Cost of covering the river", kind: "range", min: 0, max: 8, step: 0.5, hint: "avoid.label.river (per em² covered)" },
    { key: "legendHard", label: "Legend is a hard obstacle", kind: "toggle", hint: "avoid.label.legend: hard, or a cost of 4" },
  ];
  readonly params: Record<string, number | boolean> = { riverCost: 3, legendHard: true };
  #places: Place[] = [];

  async load(): Promise<void> {
    if (!this.#places.length) this.reset();
  }

  reset(): void {
    this.#places = PLACES.map((p) => ({ ...p }));
  }

  problem(): LabelProblem {
    const items: Item[] = [
      ...AREAS.map((a) => ({ id: a.id, anchor: { type: "area", polygon: a.poly }, label: { type: "text", text: a.name } }) as Item),
      ...this.#places.map((p) => ({ id: p.id, anchor: { type: "point", x: r1(p.x), y: r1(p.y), mark: { shape: "circle", r: 3 } }, label: { type: "text", text: p.name } }) as Item),
    ];
    return {
      canvas: { width: AR_W, height: AR_H },
      avoid: { label: { river: Number(this.params.riverCost), legend: this.params.legendHard ? "hard" : 4 } },
      items,
      obstacles: {
        vector: [
          { class: "river", width: 7, polylines: [RIVER] },
          { class: "legend", rects: [LEGEND] },
        ],
      },
    } as LabelProblem;
  }

  background(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.fillStyle = "#f6f8f1";
    ctx.fillRect(0, 0, AR_W, AR_H);
    ctx.strokeStyle = "#9cc3e6";
    ctx.lineWidth = 7;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    RIVER.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    const [x, y, w, h] = LEGEND;
    ctx.fillStyle = "#ffffff";
    ctx.strokeStyle = "#aab1bd";
    ctx.lineWidth = 1;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = "#5d6676";
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.fillText("Legend (obstacle)", x + 10, y + 18);
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillStyle = "#9cc3e6";
    ctx.fillRect(x + 10, y + 30, 18, 6);
    ctx.fillStyle = "#5d6676";
    ctx.fillText("river", x + 36, y + 36);
    ctx.fillStyle = "#c8dcc0";
    ctx.fillRect(x + 10, y + 46, 18, 12);
    ctx.fillStyle = "#5d6676";
    ctx.fillText("woods and moors", x + 36, y + 56);
    ctx.restore();
  }

  move(id: string, x: number, y: number): void {
    const p = this.#places.find((q) => q.id === id);
    if (!p) return;
    p.x = Math.min(AR_W - 4, Math.max(4, x));
    p.y = Math.min(AR_H - 4, Math.max(4, y));
  }

  draggable(id: string): boolean {
    return this.#places.some((p) => p.id === id);
  }
}

export function scenes(): ExplainScene[] {
  return [new EuropeScene(), new ScatterScene(), new LinesScene(), new AreasScene()];
}
