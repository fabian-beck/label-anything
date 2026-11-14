/**
 * A chart: the world's economies as a bubble chart (examples/showcase/economies.py, live).
 *
 * Every country of Natural Earth with at least 100,000 people is a bubble. What the axes
 * and the bubbles' area show can be chosen: GDP per person, population, GDP, area or
 * population density. The chart is drawn as an SVG, and that SVG is what the engine gets
 * as the background: grid lines may be covered, the axes, their text and the legend may
 * not. Every country has a label, its full name, the larger bubbles first (the eight
 * largest set larger and bold), inside the bubble where it fits. With the default choice
 * the problem is the one of the static figure.
 */
import type { LabelProblem } from "@label-anything/core";
import type { Example, Info, Solve, Stage } from "./stage.js";
import { LABEL_FAMILY, compact, easeInOut, esc, f2, round, select, set, svg, tick, type Pt } from "./util.js";

const W = 960;
const H = 600;
const PLOT = [78, 16, 944, 548] as const; // x0, y0, x1, y1 of the plot area
const R_MAX = 50; // the largest bubble
const LEGEND = [118, 126] as const; // width, height

const CONTINENTS: Record<string, string> = {
  Africa: "#59a14f",
  Asia: "#e15759",
  Europe: "#4e79a7",
  "North America": "#f28e2b",
  "South America": "#d4a72c",
  Oceania: "#b07aa1",
};
// every label is the country's name in full (world.json writes Natural Earth's abbreviations
// out): the Republic of the Congo told apart from the Democratic Republic, Eswatini as usual
const FULL: Record<string, string> = { COG: "Republic of the Congo", SWZ: "Eswatini" };
// names wider than this (in em of their font) break into two balanced lines
const LONG_EM = 9.0;
const FONT_SIZE = 11.5;
const CLASSES = [{ first: 8, scale: 1.25, weight: "bold" }, { first: 30, scale: 1.0 }, { scale: 0.85 }] as const;
const TEXT = "#1f2328";
const MUTED = "#5f6670";
const MOVE_MS = 900;

export interface WorldCountry {
  id: string;
  name: string;
  abbrev: string | null;
  continent: string;
  pop: number | null;
  gdp: number | null;
  area: number | null;
  parts: [number, number][][][];
}

type VarKey = "gdppc" | "pop" | "gdp" | "area" | "density";

interface Variable {
  name: string;
  axis: string;
  /** The axis' range (log scale). */
  domain: readonly [number, number];
  money: boolean;
  of(c: Country): number;
  text(v: number): string;
}

const VARS: Record<VarKey, Variable> = {
  gdppc: { name: "GDP per person", axis: "GDP per person (US$, log scale)", domain: [200, 160_000], money: true, of: (c) => (c.gdp * 1e6) / c.pop, text: (v) => `US$${compact(v)}` },
  pop: { name: "Population", axis: "Population (log scale)", domain: [80_000, 3e9], money: false, of: (c) => c.pop, text: compact },
  gdp: { name: "GDP", axis: "GDP (US$, log scale)", domain: [1.2e8, 5e13], money: true, of: (c) => c.gdp * 1e6, text: (v) => `US$${compact(v)}` },
  area: { name: "Area", axis: "Area (km², log scale)", domain: [15, 3e7], money: false, of: (c) => c.area, text: (v) => `${compact(v)} km²` },
  density: { name: "Population density", axis: "People per km² (log scale)", domain: [1.4, 45_000], money: false, of: (c) => c.pop / c.area, text: (v) => `${compact(v)} per km²` },
};
const AXIS_VARS: VarKey[] = ["gdppc", "pop", "gdp", "area", "density"];
const SIZE_VARS: VarKey[] = ["gdp", "pop", "area"];

interface Country {
  id: string;
  name: string;
  continent: string;
  pop: number;
  gdp: number;
  area: number;
  /** The name's width in em, regular and bold. */
  em: [number, number];
}

interface State {
  x: VarKey;
  y: VarKey;
  size: VarKey;
}

interface Bubble {
  x: number;
  y: number;
  r: number;
}

/** A state laid out: the countries, largest first, their bubbles and where the legend goes. */
interface Layout {
  state: State;
  order: Country[];
  at: Map<string, Bubble>;
  legend: Pt;
}

const scale = (v: number, domain: readonly [number, number], a: number, b: number): number => {
  const d0 = Math.log10(domain[0]);
  const d1 = Math.log10(domain[1]);
  return a + ((Math.log10(v) - d0) / (d1 - d0)) * (b - a);
};

/** The ticks of a log axis: 1–2–5 over a short range, decades over a long one. */
function ticks(v: Variable): number[] {
  const [lo, hi] = v.domain;
  const steps = Math.log10(hi / lo) < 3.2 ? [1, 2, 5] : [1];
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const s of steps) {
      const t = Number(`${s}e${e}`);
      if (t >= lo && t <= hi) out.push(t);
    }
  }
  return out;
}

export class Economies implements Example {
  readonly name = "economies";
  readonly width = W;
  readonly height = H;
  readonly title = "The world's economies as a bubble chart, every country a bubble, labeled live by Label Anything";
  readonly hint = "Choose what the axes and the bubbles show: the labels are placed again. Hover or tap a bubble or a label for the country's values.";
  readonly render = {
    font: { family: LABEL_FAMILY, size: FONT_SIZE, weight: 400, italic: false },
    fill: TEXT,
    halo: "#ffffff",
    haloWidth: 2.6,
    leaderStroke: MUTED,
    leaderWidth: 0.8,
    decorate: (text: SVGTextElement, p: { model?: string }) => {
      // a label inside its bubble is white, without a halo
      if (p.model === "internal") set(text, { fill: "#ffffff", stroke: "none" });
    },
  };
  readonly motion = { duration: 450, appearDelay: 120, holdTime: 200, moveDelay: 0 };

  state: State = { x: "gdppc", y: "pop", size: "gdp" };
  #countries: Country[];
  #layout: Layout;
  #stage!: Stage;
  #frame!: SVGGElement;
  #bubbles!: SVGGElement;
  #legend!: SVGGElement;
  #circles = new Map<string, SVGCircleElement>();
  #selects = {} as Record<keyof State, HTMLSelectElement>;
  /** The bubbles as drawn, and the transition under way. */
  #now = new Map<string, Bubble>();
  #from = new Map<string, Bubble>();
  #t0 = -1;

  constructor(world: WorldCountry[]) {
    const ctx = document.createElement("canvas").getContext("2d");
    const em = (name: string, weight: number): number => {
      if (!ctx) return name.length * 0.55;
      ctx.font = `${weight} 100px ${LABEL_FAMILY}`;
      return ctx.measureText(name).width / 100;
    };
    this.#countries = world
      .filter((c) => c.continent in CONTINENTS && (c.pop ?? 0) >= 100_000 && (c.gdp ?? 0) > 0 && (c.area ?? 0) > 0)
      .map((c) => {
        const name = FULL[c.id] ?? c.name;
        return { id: c.id, name, continent: c.continent, pop: c.pop!, gdp: c.gdp!, area: c.area!, em: [em(name, 400), em(name, 700)] };
      });
    this.#layout = this.#lay(this.state);
    this.#now = new Map(this.#layout.at);
  }

  #lay(state: State): Layout {
    const [x0, y0, x1, y1] = PLOT;
    const size = VARS[state.size];
    const max = Math.max(...this.#countries.map((c) => size.of(c)));
    const at = new Map<string, Bubble>();
    for (const c of this.#countries) {
      at.set(c.id, {
        x: scale(VARS[state.x].of(c), VARS[state.x].domain, x0, x1),
        y: scale(VARS[state.y].of(c), VARS[state.y].domain, y1, y0),
        r: Math.max(2, R_MAX * Math.sqrt(size.of(c) / max)),
      });
    }
    // the largest bubbles first, so that the smaller ones are drawn over them
    const order = [...this.#countries].sort((a, b) => size.of(b) - size.of(a));
    // the legend goes into the corner with the least under it
    const corners: Pt[] = [[x0 + 6, y0 + 4], [x1 - 6 - LEGEND[0], y0 + 4], [x0 + 6, y1 - 4 - LEGEND[1]], [x1 - 6 - LEGEND[0], y1 - 4 - LEGEND[1]]];
    const under = ([lx, ly]: Pt): number => {
      let s = 0;
      for (const b of at.values()) {
        const dx = Math.max(lx - b.x, 0, b.x - lx - LEGEND[0]);
        const dy = Math.max(ly - b.y, 0, b.y - ly - LEGEND[1]);
        if (dx * dx + dy * dy < (b.r + 4) ** 2) s += b.r * b.r;
      }
      return s;
    };
    let legend = corners[0]!;
    for (const c of corners) if (under(c) < under(legend)) legend = c;
    return { state, order, at, legend };
  }

  /** Grid and axes, as SVG markup. */
  #axes(l: Layout): string {
    const [x0, y0, x1, y1] = PLOT;
    const vx = VARS[l.state.x];
    const vy = VARS[l.state.y];
    const sx = (v: number) => scale(v, vx.domain, x0, x1);
    const sy = (v: number) => scale(v, vy.domain, y1, y0);
    const name = (v: Variable, t: number) => (v.money ? "$" : "") + tick(t);
    const o = ['<g class="grid" stroke="#e6e8eb" stroke-width="1">'];
    for (const t of ticks(vx)) o.push(`<line x1="${f2(sx(t))}" y1="${y0}" x2="${f2(sx(t))}" y2="${y1}"/>`);
    for (const t of ticks(vy)) o.push(`<line x1="${x0}" y1="${f2(sy(t))}" x2="${x1}" y2="${f2(sy(t))}"/>`);
    o.push("</g>");
    o.push(`<g class="axis" fill="${MUTED}" font-size="11" stroke="none">`);
    o.push(`<line x1="${x0}" y1="${y1}" x2="${x1}" y2="${y1}" stroke="#9aa1a9"/>`);
    o.push(`<line x1="${x0}" y1="${y0}" x2="${x0}" y2="${y1}" stroke="#9aa1a9"/>`);
    for (const t of ticks(vx)) o.push(`<text x="${f2(sx(t))}" y="${y1 + 16}" text-anchor="middle">${name(vx, t)}</text>`);
    for (const t of ticks(vy)) o.push(`<text x="${x0 - 6}" y="${f2(sy(t) + 4)}" text-anchor="end">${name(vy, t)}</text>`);
    o.push(`<text x="${f2((x0 + x1) / 2)}" y="${y1 + 38}" text-anchor="middle" fill="${TEXT}" font-size="12">${esc(vx.axis)}</text>`);
    o.push(`<text transform="translate(${x0 - 44} ${f2((y0 + y1) / 2)}) rotate(-90)" text-anchor="middle" fill="${TEXT}" font-size="12">${esc(vy.axis)}</text>`);
    o.push("</g>");
    return o.join("\n");
  }

  #legendMarkup(l: Layout): string {
    const lx = l.legend[0] + 8;
    const ly = l.legend[1] + 8;
    const names = Object.keys(CONTINENTS);
    const o = [`<g class="legend" font-size="11" fill="${TEXT}">`];
    o.push(`<rect x="${lx - 8}" y="${ly - 8}" width="${LEGEND[0]}" height="${names.length * 16 + 30}" rx="4" fill="#ffffff" stroke="#e6e8eb"/>`);
    names.forEach((name, i) => {
      const y = ly + 6 + i * 16;
      o.push(`<circle cx="${lx + 5}" cy="${y}" r="5" fill="${CONTINENTS[name]}" fill-opacity="0.78"/>`);
      o.push(`<text x="${lx + 15}" y="${y + 4}">${esc(name)}</text>`);
    });
    o.push(`<text x="${lx}" y="${ly + 6 + names.length * 16 + 4}" fill="${MUTED}" font-size="10">Area: ${esc(VARS[l.state.size].name)}</text>`);
    o.push("</g>");
    return o.join("\n");
  }

  /** The chart as a host draws it: grid, axes, bubbles, legend. The engine reads this SVG. */
  chart(l: Layout = this.#layout): string {
    const o = [`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`, `<rect id="background" width="${W}" height="${H}" fill="#ffffff"/>`, this.#axes(l)];
    o.push('<g class="bubbles" stroke="#ffffff" stroke-width="0.8">');
    for (const c of l.order) {
      const b = l.at.get(c.id)!;
      o.push(`<circle class="bubble" id="${c.id}" cx="${f2(b.x)}" cy="${f2(b.y)}" r="${f2(b.r)}" fill="${CONTINENTS[c.continent]}" fill-opacity="0.78"/>`);
    }
    o.push("</g>", this.#legendMarkup(l), "</svg>");
    return o.join("\n") + "\n";
  }

  problem(l: Layout = this.#layout): LabelProblem {
    const items = l.order.map((c, rank) => {
      const b = l.at.get(c.id)!;
      const k = CLASSES.findIndex((cl) => !("first" in cl) || rank < cl.first);
      const em = c.em["weight" in CLASSES[k]! ? 1 : 0];
      return {
        id: c.id,
        anchor: { type: "point", x: round(b.x, 2), y: round(b.y, 2), mark: { shape: "circle", r: round(b.r, 2) } },
        // a long name breaks into two balanced lines, the engine choosing the break
        label: { type: "text", text: c.name, ...(em > LONG_EM ? { wrap: { max_width: `${(0.6 * em).toFixed(2)}em`, max_lines: 2 } } : {}) },
        // the larger first (GDP in million US$, as the data has it)
        priority: l.state.size === "gdp" ? c.gdp : VARS[l.state.size].of(c),
        // a label inside its bubble where it fits
        ...(b.r >= 15 ? { placement: { internal: "prefer" } } : {}),
      };
    });
    return {
      version: "1",
      canvas: { width: W, height: H, padding: 2 },
      defaults: { font: { size: FONT_SIZE } },
      obstacles: {
        svg: {
          source: this.chart(l),
          classes: [
            { selector: "#background", class: "ignore" },
            { selector: ".grid line", class: "grid" },
            { selector: ".legend *", class: "legend" },
            { selector: ".axis *", class: "axes" },
            // the bubbles are the items' marks
            { selector: "circle.bubble", class: "ignore" },
          ],
        },
      },
      items,
      avoid: {
        label: { grid: "ignore", axes: "hard", legend: "hard" },
        leader: { grid: "ignore", axes: "hard", legend: "hard" },
      },
      // a label next to its bubble among other bubbles may stand off it with a stub
      placement: { models: ["adjacent", "slider", "internal", "distant"], max_distance: "6em", stubs: "auto" },
      leaders: { style: "straight", max_length: "9em" },
      priority: { font_classes: CLASSES },
      degrade: ["distant", "omit"],
      solver: { seed: 1 },
    } as unknown as LabelProblem;
  }

  mount(stage: Stage): void {
    this.#stage = stage;
    svg("rect", { width: W, height: H, fill: "#ffffff" }, stage.picture);
    this.#frame = svg("g", {}, stage.picture);
    this.#bubbles = svg("g", { class: "la-ex-bubbles", stroke: "#ffffff", "stroke-width": 0.8 }, stage.picture);
    this.#legend = svg("g", {}, stage.picture);
    for (const c of this.#countries) {
      this.#circles.set(c.id, svg("circle", { class: "la-ex-bubble la-ex-fade", fill: CONTINENTS[c.continent], "fill-opacity": 0.78 }));
    }
    this.#drawFrame();
    this.#drawBubbles();
    const options = (keys: VarKey[]) => keys.map((k) => [k, VARS[k].name] as const);
    this.#selects.x = select(stage.controls, "Across", options(AXIS_VARS), this.state.x, (v) => this.set({ x: v }));
    this.#selects.y = select(stage.controls, "Up", options(AXIS_VARS), this.state.y, (v) => this.set({ y: v }));
    this.#selects.size = select(stage.controls, "Bubble area", options(SIZE_VARS), this.state.size, (v) => this.set({ size: v }));
  }

  /** Changes what the chart shows: the bubbles travel to their new places, the labels with them. */
  set(change: Partial<State>): void {
    const next = { ...this.state, ...change };
    // the same variable on both axes: the other axis takes the one that was here
    if (next.x === next.y) {
      if (change.x !== undefined) next.y = this.state.x;
      else next.x = this.state.y;
    }
    this.state = next;
    for (const k of ["x", "y", "size"] as const) this.#selects[k].value = next[k];
    this.#from = new Map(this.#now);
    this.#layout = this.#lay(next);
    this.#t0 = this.#stage.reduced ? -1 : performance.now();
    if (this.#t0 < 0) this.#now = new Map(this.#layout.at);
    this.#stage.setHover(null);
    this.#drawFrame();
    this.#drawBubbles();
    // everything moves: solved afresh, not from the labels shown
    this.#stage.request(true, true);
    this.#stage.kick();
  }

  #drawFrame(): void {
    this.#frame.innerHTML = this.#axes(this.#layout);
    this.#legend.innerHTML = this.#legendMarkup(this.#layout);
  }

  #drawBubbles(): void {
    this.#bubbles.replaceChildren(...this.#layout.order.map((c) => this.#circles.get(c.id)!));
    for (const [id, b] of this.#now) set(this.#circles.get(id)!, { cx: f2(b.x), cy: f2(b.y), r: f2(b.r) });
  }

  frame(now: number): boolean {
    if (this.#t0 < 0) return false;
    const t = Math.min(1, (now - this.#t0) / MOVE_MS);
    const e = easeInOut(t);
    for (const [id, to] of this.#layout.at) {
      const a = this.#from.get(id)!;
      this.#now.set(id, { x: a.x + (to.x - a.x) * e, y: a.y + (to.y - a.y) * e, r: a.r + (to.r - a.r) * e });
    }
    if (t >= 1) this.#t0 = -1;
    this.#drawBubbles();
    return t < 1;
  }

  solve(): Solve {
    const l = this.#layout;
    return { problem: this.problem(l), anchors: new Map([...l.at].map(([id, b]) => [id, [round(b.x, 2), round(b.y, 2)]])) };
  }

  anchors(): Map<string, Pt> {
    return new Map([...this.#now].map(([id, b]) => [id, [b.x, b.y]]));
  }

  hit(x: number, y: number): string | null {
    // the bubble on top first: the smallest
    const order = this.#layout.order;
    for (let i = order.length - 1; i >= 0; i--) {
      const b = this.#now.get(order[i]!.id)!;
      if (Math.hypot(x - b.x, y - b.y) <= Math.max(b.r, 4)) return order[i]!.id;
    }
    return null;
  }

  info(id: string): Info | null {
    const c = this.#countries.find((c) => c.id === id);
    if (!c) return null;
    const keys = [...new Set([this.state.x, this.state.y, this.state.size])];
    return { title: c.name, subtitle: c.continent, rows: keys.map((k) => [VARS[k].name, VARS[k].text(VARS[k].of(c))] as const) };
  }

  highlight(id: string | null): void {
    this.#stage.hover.replaceChildren();
    for (const [k, e] of this.#circles) e.classList.toggle("is-hover", k === id);
    const b = id === null ? undefined : this.#now.get(id);
    if (b) svg("circle", { cx: f2(b.x), cy: f2(b.y), r: f2(b.r + 1), fill: "none", stroke: TEXT, "stroke-width": 1.6 }, this.#stage.hover);
  }
}
