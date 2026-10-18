/**
 * A scatterplot: the countries of the world by population, wealth, area and density
 * (Natural Earth), or generated clusters of up to 5,000 points. Play cycles the axes, so
 * every point travels to its new place and the labels travel with it; drag a point. Only
 * some points may be labeled: the others become unlabeled `points` the labels avoid softly.
 */
import { FONT_CLASSES, type Control } from "../controls.js";
import { easeInOut, gauss, nameGen, rng, type Obj } from "../util.js";
import type { Anchors, DrawState, Item, PointerInfo, Scene, SceneHost } from "./scene.js";

type P = [number, number];

interface Pt {
  id: string;
  name: string;
  abbrev: string | null;
  values: Record<string, number>;
  r: number;
  weight: number;
  continent: string;
  /** Current position, and the transition's start and end. */
  x: number;
  y: number;
  from: P;
  to: P;
  labeled: boolean;
}

interface Axis {
  key: string;
  title: string;
  log: boolean;
}

const AXES: Record<string, Axis> = {
  gdppc: { key: "gdppc", title: "GDP per person (US$)", log: true },
  pop: { key: "pop", title: "Population", log: true },
  area: { key: "area", title: "Land area (km²)", log: true },
  density: { key: "density", title: "People per km²", log: true },
  gdp: { key: "gdp", title: "GDP (million US$)", log: true },
};

/** The axis pairs Play cycles through. */
const CYCLE: [string, string][] = [
  ["gdppc", "pop"],
  ["area", "pop"],
  ["density", "gdppc"],
  ["gdp", "area"],
];

const CONTINENT_COLORS: Record<string, string> = {
  Africa: "#c2185b",
  Asia: "#ef6c00",
  Europe: "#3949ab",
  "North America": "#00897b",
  "South America": "#7cb342",
  Oceania: "#8e24aa",
  "Seven seas (open ocean)": "#78909c",
  Antarctica: "#90a4ae",
};

export class ScatterScene implements Scene {
  readonly id = "scatter";
  readonly title = "Scatterplot";
  readonly hint = "Play moves every point to new axes; the labels travel along. Drag a point.";
  readonly about =
    "Labels avoid every bubble and stay inside the plot (canvas.region). Where it is crowded the engine tries abbreviations, two lines and leaders; the more important countries keep their labels first (strict priority).";
  readonly credits = 'Country data: <a href="https://www.naturalearthdata.com/">Made with Natural Earth</a> (public domain).';
  readonly classes: readonly string[] = ["points"];
  readonly animated = true;
  readonly cursor = "default" as const;
  readonly view = { budgetMoving: 15, maxRate: 24 };
  readonly controls: Control[] = [
    {
      key: "data", label: "Data", kind: "segmented",
      options: [{ value: "countries", label: "countries" }, { value: "clusters", label: "clusters" }],
    },
    { key: "count", label: "Points", kind: "range", min: 50, max: 5000, step: 50, log: true, format: (n) => String(Math.round(n)), when: (g) => g("param.data") === "clusters" },
    {
      key: "labeled", label: "Labeled", kind: "segmented",
      options: [{ value: 1, label: "all" }, { value: 0.5, label: "half" }, { value: 0.2, label: "a fifth" }],
      hint: "The other points are obstacles of the class points",
    },
    {
      key: "axes", label: "Axes", kind: "select",
      options: CYCLE.map(([x, y]) => ({ value: `${x},${y}`, label: `${AXES[x]!.title} × ${AXES[y]!.title}` })),
      when: (g) => g("param.data") === "countries",
    },
  ];
  readonly params: Obj = { data: "countries", count: 600, labeled: 1, axes: "gdppc,pop" };
  playing = false;

  #all: Pt[] = [];
  #pts: Pt[] = [];
  #w = 800;
  #h = 600;
  #plot = { x0: 70, y0: 30, x1: 760, y1: 540 };
  #t = 1;
  #hold = 0;
  #cycle = 0;
  #drag: Pt | null = null;
  #host!: SceneHost;
  #countries: Pt[] = [];
  #scales: { x: (v: number) => number; y: (v: number) => number; xt: number[]; yt: number[]; ax: Axis; ay: Axis } | null = null;

  async load(host: SceneHost): Promise<void> {
    this.#host = host;
    if (this.#countries.length) return;
    const world = (await (await fetch(host.asset("world.json"))).json()) as {
      countries: { id: string; name: string; abbrev: string | null; continent: string; pop: number; gdp: number; area: number }[];
    };
    const maxPop = Math.max(...world.countries.map((c) => c.pop));
    this.#countries = world.countries
      .filter((c) => c.pop >= 50000 && c.gdp > 0 && c.area > 0)
      .map((c) => ({
        id: c.id, name: c.name, abbrev: c.abbrev, continent: c.continent,
        values: { pop: c.pop, gdp: c.gdp, area: c.area, gdppc: (c.gdp * 1e6) / c.pop, density: c.pop / c.area },
        r: 2 + Math.sqrt(c.pop / maxPop) * 16,
        weight: c.pop,
        x: 0, y: 0, from: [0, 0], to: [0, 0], labeled: true,
      }));
  }

  resize(w: number, h: number): void {
    this.#w = w;
    this.#h = h;
    this.#plot = { x0: 74, y0: 26, x1: w - 24, y1: h - 64 };
    if (!this.#pts.length) this.#rebuild();
    else this.#layout(false);
  }

  setParam(key: string, value: unknown): void {
    this.params[key] = value;
    if (key === "data" || key === "count") this.#rebuild();
    else if (key === "labeled") this.#markLabeled();
    else if (key === "axes") {
      this.#cycle = Math.max(0, CYCLE.findIndex(([x, y]) => `${x},${y}` === value));
      this.#layout(true);
    }
  }

  reset(): void {
    this.#cycle = 0;
    this.params.axes = "gdppc,pop";
    this.#rebuild();
  }

  #rebuild(): void {
    if (this.params.data === "countries") {
      this.#pts = this.#countries.map((p) => ({ ...p }));
    } else {
      const r = rng(5);
      const name = nameGen(rng(9));
      const n = Math.round(Number(this.params.count));
      const k = 7;
      const centers = Array.from({ length: k }, () => [0.15 + 0.7 * r(), 0.15 + 0.7 * r(), 0.03 + 0.09 * r()] as const);
      this.#pts = Array.from({ length: n }, (_, i) => {
        const c = centers[i % k]!;
        const size = r();
        return {
          id: `p${i}`, name: name(), abbrev: null, continent: "",
          values: { u: Math.min(0.99, Math.max(0.01, c[0] + gauss(r) * c[2])), v: Math.min(0.99, Math.max(0.01, c[1] + gauss(r) * c[2])) },
          r: 2 + size * size * 5, weight: size,
          x: 0, y: 0, from: [0, 0], to: [0, 0], labeled: true,
        };
      });
    }
    this.#markLabeled();
    this.#layout(false);
    this.#host?.invalidate();
  }

  #markLabeled(): void {
    const share = Number(this.params.labeled);
    // the larger points keep their labels
    const order = [...this.#pts].sort((a, b) => b.weight - a.weight);
    const n = Math.round(order.length * share);
    order.forEach((p, i) => (p.labeled = i < n));
    this.#host?.invalidate();
  }

  /** Positions for the current axes; `animate`: travel there. */
  #layout(animate: boolean): void {
    const { x0, y0, x1, y1 } = this.#plot;
    if (this.params.data === "countries") {
      const [kx, ky] = String(this.params.axes).split(",") as [string, string];
      const ax = AXES[kx]!;
      const ay = AXES[ky]!;
      const sx = logScale(this.#pts.map((p) => p.values[kx]!), x0 + 10, x1 - 10);
      const sy = logScale(this.#pts.map((p) => p.values[ky]!), y1 - 10, y0 + 10);
      this.#scales = { x: sx.f, y: sy.f, xt: sx.ticks, yt: sy.ticks, ax, ay };
      for (const p of this.#pts) p.to = [sx.f(p.values[kx]!), sy.f(p.values[ky]!)];
    } else {
      this.#scales = null;
      for (const p of this.#pts) p.to = [x0 + p.values.u! * (x1 - x0), y1 - p.values.v! * (y1 - y0)];
    }
    for (const p of this.#pts) p.from = [p.x, p.y];
    if (animate) this.#t = 0;
    else {
      this.#t = 1;
      for (const p of this.#pts) [p.x, p.y] = p.to;
    }
    this.#host?.moved();
  }

  options() {
    return {
      preset: "scatter" as const,
      canvas: { region: [this.#plot.x0, this.#plot.y0, this.#plot.x1 - this.#plot.x0, this.#plot.y1 - this.#plot.y0] as [number, number, number, number] },
      placement: { max_distance: "6em" },
      leaders: { max_length: "7em" },
      priority: { font_classes: (this.params.data === "countries" ? FONT_CLASSES[1]!.value : []) as never },
    };
  }

  items(): Item[] {
    const out: Item[] = [];
    for (const p of this.#pts) {
      if (!p.labeled) continue;
      const label: Record<string, unknown> = { type: "text", text: p.name };
      if (p.abbrev) label.alternatives = [p.abbrev];
      out.push({ id: p.id, anchor: { type: "point", x: round(p.x), y: round(p.y), mark: { shape: "circle", r: round(p.r) } }, label, priority: p.weight } as unknown as Item);
    }
    return out;
  }

  obstacles() {
    const rest = this.#pts.filter((p) => !p.labeled);
    if (!rest.length) return undefined;
    return { vector: [{ class: "points", circles: rest.map((p): [number, number, number] => [round(p.x), round(p.y), round(p.r)]) }] };
  }

  anchors(): Anchors {
    return new Map(this.#pts.filter((p) => p.labeled).map((p) => [p.id, [round(p.x), round(p.y)]]));
  }

  step(dt: number): boolean {
    if (this.#t >= 1) {
      // hold a moment on each pair of axes, then travel to the next
      this.#hold += dt;
      if (this.#hold < 2400) return false;
      this.#hold = 0;
      if (this.params.data === "countries") {
        this.#cycle = (this.#cycle + 1) % CYCLE.length;
        this.params.axes = CYCLE[this.#cycle]!.join(",");
      } else {
        // clusters: every point to a new place nearby
        const r = Math.random;
        for (const p of this.#pts) {
          p.values.u = Math.min(0.99, Math.max(0.01, p.values.u! + (r() - 0.5) * 0.12));
          p.values.v = Math.min(0.99, Math.max(0.01, p.values.v! + (r() - 0.5) * 0.12));
        }
      }
      this.#layout(true);
      return true;
    }
    this.#t = Math.min(1, this.#t + dt / 2400);
    const e = easeInOut(this.#t);
    for (const p of this.#pts) {
      if (p === this.#drag) continue;
      p.x = p.from[0] + (p.to[0] - p.from[0]) * e;
      p.y = p.from[1] + (p.to[1] - p.from[1]) * e;
    }
    return true;
  }

  draw(ctx: CanvasRenderingContext2D, layer: "background" | "marks", state: DrawState): void {
    const { x0, y0, x1, y1 } = this.#plot;
    if (layer === "background") {
      ctx.save();
      ctx.strokeStyle = "#e6e9ee";
      ctx.lineWidth = 1;
      ctx.fillStyle = "#5d6676";
      ctx.font = "11px system-ui, sans-serif";
      const s = this.#scales;
      if (s && this.#t >= 1) {
        ctx.textAlign = "center";
        for (const v of s.xt) {
          const x = s.x(v);
          ctx.beginPath();
          ctx.moveTo(x, y0);
          ctx.lineTo(x, y1);
          ctx.stroke();
          ctx.fillText(tick(v), x, y1 + 16);
        }
        ctx.textAlign = "right";
        for (const v of s.yt) {
          const y = s.y(v);
          ctx.beginPath();
          ctx.moveTo(x0, y);
          ctx.lineTo(x1, y);
          ctx.stroke();
          ctx.fillText(tick(v), x0 - 8, y + 4);
        }
      }
      ctx.strokeStyle = "#aab1bd";
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, x1 - x0, y1 - y0);
      if (s) {
        ctx.fillStyle = "#1b2130";
        ctx.font = "600 12px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(s.ax.title, (x0 + x1) / 2, y1 + 38);
        ctx.save();
        ctx.translate(x0 - 52, (y0 + y1) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(s.ay.title, 0, 0);
        ctx.restore();
        this.#legend(ctx);
      }
      ctx.restore();
      return;
    }
    ctx.save();
    const focus = state.selected ?? state.hover;
    // larger bubbles first, so that small ones stay visible on top
    const order = [...this.#pts].sort((a, b) => b.r - a.r);
    for (const p of order) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      const color = CONTINENT_COLORS[p.continent] ?? "#6f7d96";
      ctx.fillStyle = color;
      ctx.globalAlpha = p.labeled ? (p.id === focus ? 0.95 : 0.55) : 0.25;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = p.id === focus ? 2 : 0.75;
      ctx.strokeStyle = p.id === focus ? "#1b2130" : "#ffffff";
      ctx.stroke();
    }
    ctx.restore();
  }

  /** Continents, right-aligned under the plot (outside the labels' region). */
  #legend(ctx: CanvasRenderingContext2D): void {
    const seen = new Set(this.#pts.map((p) => p.continent));
    const entries = Object.entries(CONTINENT_COLORS).filter(([c]) => seen.has(c) && !c.startsWith("Seven") && c !== "Antarctica");
    ctx.save();
    ctx.font = "11px system-ui, sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    let x = this.#plot.x1;
    const y = this.#plot.y1 + 54;
    for (const [label, color] of [...entries].reverse()) {
      const w = ctx.measureText(label).width;
      x -= w + 22;
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(x + 5, y, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#5d6676";
      ctx.fillText(label, x + 13, y);
    }
    ctx.restore();
  }

  hit(x: number, y: number): string | null {
    let best: Pt | null = null;
    let bd = Infinity;
    for (const p of this.#pts) {
      if (!p.labeled) continue;
      const d = Math.hypot(p.x - x, p.y - y) - p.r;
      if (d < 4 && d < bd) [best, bd] = [p, d];
    }
    return best?.id ?? null;
  }

  pointerDown(pi: PointerInfo): boolean {
    const id = this.hit(pi.x, pi.y);
    const p = this.#pts.find((q) => q.id === id);
    if (!p) return false;
    this.#drag = p;
    return true;
  }

  pointerMove(pi: PointerInfo): void {
    const p = this.#drag;
    if (!p) return;
    const { x0, y0, x1, y1 } = this.#plot;
    p.x = Math.min(x1, Math.max(x0, pi.x));
    p.y = Math.min(y1, Math.max(y0, pi.y));
    p.to = [p.x, p.y];
    this.#host.moved();
  }

  pointerUp(): void {
    this.#drag = null;
  }
}

/** A log scale over the values' extent (padded), with ticks at powers of ten. */
function logScale(values: number[], r0: number, r1: number): { f: (v: number) => number; ticks: number[] } {
  const ls = values.filter((v) => v > 0).map(Math.log10);
  const lo = Math.min(...ls) - 0.08;
  const hi = Math.max(...ls) + 0.08;
  const f = (v: number) => r0 + ((Math.log10(Math.max(v, 1e-12)) - lo) / (hi - lo || 1)) * (r1 - r0);
  const ticks: number[] = [];
  for (let e = Math.ceil(lo); e <= Math.floor(hi); e++) ticks.push(10 ** e);
  return { f, ticks };
}

function tick(v: number): string {
  if (v >= 1e9) return `${v / 1e9} B`;
  if (v >= 1e6) return `${v / 1e6} M`;
  if (v >= 1e3) return `${v / 1e3} k`;
  return String(v);
}

const round = (v: number) => Math.round(v * 100) / 100;
