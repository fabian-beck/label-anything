/**
 * The live header of the documentation's home page (docs/_overrides/home.html). The logo —
 * a label, its leader and a dot — carries the name as its label, among a few labeled dots;
 * the engine places every label, keeping off the header's text, while dots and labels are
 * dragged or added by a click. Built into dist/hero.js; the home page loads it from the
 * playground's directory and solves with the playground's TypeScript engine (engine-ts.js)
 * in a worker. Without it (e.g. under `mkdocs serve`) the header shows the static logo the
 * live one starts from.
 *
 * The page provides, inside `[data-la-hero]`: the stage the drawing goes into
 * (`[data-la-hero-stage]`), the static logo (`[data-la-hero-name]` with its label
 * `[data-la-hero-label]` and dot `[data-la-hero-dot]`), the elements to keep labels off
 * (`[data-la-avoid]`: `text` for the boxes of its lines, `children` for each child's box,
 * empty for its own box) and the hint shown while live (`[data-la-hero-hint]`, out of the
 * flow, with `[data-la-hero-stats]` and a `[data-la-hero-reset]` button).
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LabelMotion } from "@label-anything/extras";
import { createWorkerEngine, type WorkerEngine } from "@label-anything/extras/worker";

type Placement = LabelResult["placements"][number];
type Box = { x: number; y: number; w: number; h: number };
type Rect = [number, number, number, number];

const SVG_NS = "http://www.w3.org/2000/svg";
/** Font size of the small labels (px). */
const SMALL = 14;
/** Budgets (ms, of the Rust core; the TypeScript worker scales them) while dragging and at rest. */
const BUDGET_MOVING = 4;
const BUDGET_REST = 10;
/** At most this many dots: the oldest added by a click go first. */
const MAX_THINGS = 36;

interface Thing {
  id: string;
  text: string;
  /** Where it is: x = the stage's centre + u · half the scene's width, y = v · the stage's height. */
  u: number;
  v: number;
  r: number;
  accent?: boolean;
  priority: number;
  /** Added by a click, at this count (the oldest go first when there are too many). */
  added?: number;
  /** Moved by the user: shown wherever it is (the others only where clear of the text and the logo). */
  moved?: boolean;
}

/** The dots the header starts with: a few things one labels, in charts, maps, networks and the sky. */
const THINGS: readonly Omit<Thing, "id">[] = [
  { text: "Lisbon", u: -0.9, v: 0.2, r: 4, priority: 6 },
  { text: "Porto", u: -0.87, v: 0.14, r: 3, priority: 4 },
  { text: "Saturn", u: -0.6, v: 0.12, r: 6, priority: 5 },
  { text: "Reykjavík", u: -0.74, v: 0.36, r: 3.5, priority: 4 },
  { text: "outlier", u: -0.86, v: 0.6, r: 6, accent: true, priority: 8 },
  { text: "median", u: -0.68, v: 0.74, r: 3, priority: 3 },
  { text: "you are here", u: -0.92, v: 0.88, r: 4.5, accent: true, priority: 7 },
  { text: "Andromeda", u: -0.42, v: 0.1, r: 3, priority: 2 },
  { text: "hub", u: 0.62, v: 0.16, r: 7, priority: 8 },
  { text: "router", u: 0.44, v: 0.3, r: 3.5, priority: 3 },
  { text: "Kyoto", u: 0.84, v: 0.3, r: 4, priority: 6 },
  { text: "Osaka", u: 0.8, v: 0.37, r: 4.5, priority: 6 },
  { text: "Nara", u: 0.86, v: 0.4, r: 3, priority: 4 },
  { text: "peak", u: 0.7, v: 0.58, r: 5, accent: true, priority: 7 },
  { text: "BRCA1", u: 0.93, v: 0.7, r: 3.5, priority: 5 },
  { text: "the best café", u: 0.64, v: 0.84, r: 4.5, priority: 6 },
  { text: "summit", u: 0.9, v: 0.92, r: 3, priority: 3 },
];

/** Labels of the dots added by a click, in turn. */
const MORE = [
  "Nairobi", "Mars", "lighthouse", "max", "Lima", "node 7", "Vega", "bus stop", "Oslo", "anomaly",
  "Sirius", "trailhead", "Hanoi", "ice cream", "Quito", "you", "harbor", "Jupiter", "record", "Cairo",
];

const svg = <K extends keyof SVGElementTagNameMap>(tag: K, cls?: string): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVG_NS, tag);
  if (cls) e.setAttribute("class", cls);
  return e;
};
const px = (n: number) => String(Math.round(n * 100) / 100);
const inside = (b: Box, x: number, y: number, pad = 0) => x >= b.x - pad && x <= b.x + b.w + pad && y >= b.y - pad && y <= b.y + b.h + pad;

/** What `warm_start` needs of a placement: the box, where it was placed for, its leader. */
function warm(p: Placement): object {
  if (!p.placed || !p.box) return { id: p.id, placed: false };
  return { id: p.id, placed: true, box: p.box, anchor: p.anchor, ...(p.leader ? { leader: { points: p.leader.points, style: p.leader.style } } : {}) };
}

interface Shown {
  g: SVGGElement;
  rect?: SVGRectElement;
  text: SVGTextElement;
}

export class Hero {
  readonly root: HTMLElement;
  /** The latest result. */
  result: LabelResult | undefined;
  /** Solves done. */
  solves = 0;
  things: Thing[] = [];

  #engine: WorkerEngine;
  #motion: LabelMotion;
  #stage: HTMLElement;
  #svg: SVGSVGElement;
  #gLeaders: SVGGElement;
  #gDots: SVGGElement;
  #gLabels: SVGGElement;
  #name: HTMLElement;
  #nameLabel: HTMLElement;
  #nameDot: SVGGraphicsElement;
  #hint: HTMLElement | null;
  #stats: HTMLElement | null;
  /** The widest the hint has been: labels keep off that much of it, as its numbers change. */
  #hintW = 0;
  #ctx = document.createElement("canvas").getContext("2d")!;
  #w = 0;
  #h = 0;
  #obstacles: Rect[] = [];
  /** Where the static logo is: the dots it starts with keep clear of it. */
  #logo: Rect = [0, 0, 0, 0];
  /** The name's dot while it is where the static logo has it (not dragged since). */
  #nameHome = true;
  #nameAnchor: [number, number] = [0, 0];
  /** Where the name's dot was when the name last had a place, and the glide back there. */
  #nameOk: [number, number] | null = null;
  #glide: { from: [number, number]; to: [number, number]; t0: number } | null = null;
  #nameWarm: object | null = null;
  /**
   * The name's dot radius, leader width and corner radius as the static logo draws them;
   * the page's font family; the offsets of the baselines from the tops of the name's and
   * the small labels' boxes.
   */
  #nameR = 8;
  #nameStroke = 4;
  #nameRx = 0;
  #family = "sans-serif";
  #nameBase = 0;
  #smallBase = 0;
  #dots = new Map<string, SVGCircleElement>();
  #leaders = new Map<string, SVGPathElement>();
  #labels = new Map<string, Shown>();
  /** The boxes as drawn, for hit tests. */
  #drawn = new Map<string, Box>();
  #busy = false;
  #dirty = false;
  /** Counts resets: a solve that started before one is not shown. */
  #generation = 0;
  #rest = true;
  #raf = 0;
  #drag: { thing: Thing | "name"; dx: number; dy: number; id: number } | null = null;
  #press: { x: number; y: number; t: number; id: number } | null = null;
  #added = 0;
  #reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  constructor(root: HTMLElement, engine: WorkerEngine) {
    this.root = root;
    this.#engine = engine;
    this.#motion = new LabelMotion(this.#reduced ? { duration: 0 } : { duration: 260, appearDelay: 120, holdTime: 250, moveDelay: 150 });
    this.#stage = root.querySelector<HTMLElement>("[data-la-hero-stage]")!;
    this.#name = root.querySelector<HTMLElement>("[data-la-hero-name]")!;
    this.#nameLabel = root.querySelector<HTMLElement>("[data-la-hero-label]")!;
    this.#nameDot = root.querySelector<SVGGraphicsElement>("[data-la-hero-dot]")!;
    this.#hint = root.querySelector<HTMLElement>("[data-la-hero-hint]");
    this.#stats = root.querySelector<HTMLElement>("[data-la-hero-stats]");
    this.#svg = svg("svg", "la-hero__svg");
    this.#svg.setAttribute("aria-hidden", "true");
    this.#gLeaders = this.#svg.appendChild(svg("g"));
    this.#gDots = this.#svg.appendChild(svg("g"));
    this.#gLabels = this.#svg.appendChild(svg("g"));
    this.#stage.appendChild(this.#svg);
    this.#reset();
    this.#listen();
    new ResizeObserver(() => this.#layout()).observe(root);
  }

  // --- layout -----------------------------------------------------------------------------

  /** Measures the stage, the text to keep off and the static logo; solves again. */
  #layout(): void {
    const r = this.root.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    this.#w = r.width;
    this.#h = r.height;
    this.#svg.setAttribute("viewBox", `0 0 ${px(r.width)} ${px(r.height)}`);
    this.#obstacles = this.#measureObstacles(r);
    this.#measureName();
    const lr = this.#name.getBoundingClientRect();
    const em = parseFloat(getComputedStyle(this.#name).fontSize);
    this.#logo = [lr.left - r.left, lr.top - r.top, lr.width + em, lr.height + em];
    const name = this.#labels.get("name");
    if (name) this.#styleName(name.text);
    if (this.#nameHome) this.#homeName(r);
    else {
      // a dragged dot stays where it is, off the text that may have moved over it
      const at = this.#free(this.#nameAnchor[0], this.#nameAnchor[1], this.#nameR);
      if (at) this.#nameAnchor = at;
      else {
        this.#nameHome = true;
        this.#homeName(r);
      }
    }
    this.#request(true);
  }

  #measureObstacles(origin: DOMRect): Rect[] {
    const out: Rect[] = [];
    const add = (b: DOMRect, pad: number) => {
      if (b.width > 0 && b.height > 0) out.push([b.left - origin.left - pad, b.top - origin.top - pad, b.width + 2 * pad, b.height + 2 * pad]);
    };
    for (const el of this.root.querySelectorAll<HTMLElement>("[data-la-avoid]")) {
      const how = el.dataset.laAvoid;
      if (el === this.#hint) {
        const b = el.getBoundingClientRect();
        this.#hintW = Math.max(this.#hintW, b.width);
        add(new DOMRect(b.left + b.width / 2 - this.#hintW / 2, b.top, this.#hintW, b.height), 2);
      } else if (how === "text") {
        const range = document.createRange();
        range.selectNodeContents(el);
        for (const b of range.getClientRects()) add(b, 2);
      } else if (how === "children") {
        for (const c of el.children) add(c.getBoundingClientRect(), 2);
      } else add(el.getBoundingClientRect(), 2);
    }
    return out;
  }

  #measureName(): void {
    const tail = this.#nameDot.ownerSVGElement;
    const scale = tail ? tail.getBoundingClientRect().width / (tail.viewBox.baseVal.width || 1) : 1;
    const leader = this.root.querySelector("[data-la-hero-leader]");
    this.#nameR = this.#nameDot.getBoundingClientRect().width / 2;
    this.#nameStroke = parseFloat(leader?.getAttribute("stroke-width") ?? "") * scale || 4;
    const cs = getComputedStyle(this.#nameLabel);
    this.#nameRx = parseFloat(cs.borderTopLeftRadius) || 0;
    this.#family = getComputedStyle(this.root).fontFamily;
    // where the browser puts the baseline in a line box: half the leading, then the ascent
    const size = parseFloat(cs.fontSize);
    const lh = parseFloat(cs.lineHeight) || size * 1.2;
    this.#nameBase = parseFloat(cs.paddingTop) + this.#baseline(`${cs.fontWeight} ${size}px ${cs.fontFamily}`, lh);
    this.#smallBase = 3 + this.#baseline(`400 ${SMALL}px ${this.#family}`, Math.round(SMALL * 1.25));
  }

  /** The baseline's offset from the top of a line box of height `lh`. */
  #baseline(font: string, lh: number): number {
    this.#ctx.font = font;
    const m = this.#ctx.measureText("Label Anything");
    const asc = m.fontBoundingBoxAscent ?? m.actualBoundingBoxAscent;
    const desc = m.fontBoundingBoxDescent ?? m.actualBoundingBoxDescent;
    return (lh - (asc + desc)) / 2 + asc;
  }

  #styleName(text: SVGTextElement): void {
    const cs = getComputedStyle(this.#nameLabel);
    Object.assign(text.style, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, letterSpacing: cs.letterSpacing });
  }

  /** The name's label and dot where the static logo draws them, as the warm start of the name. */
  #homeName(origin: DOMRect): void {
    const b = this.#nameLabel.getBoundingClientRect();
    const d = this.#nameDot.getBoundingClientRect();
    const box = { x: b.left - origin.left, y: b.top - origin.top, w: b.width, h: b.height };
    const a: [number, number] = [d.left - origin.left + d.width / 2, d.top - origin.top + d.height / 2];
    const r = this.#nameR;
    // the leader leaves the box at its point nearest to the dot and ends at the dot's edge
    const port: [number, number] = [Math.min(Math.max(a[0], box.x), box.x + box.w), Math.min(Math.max(a[1], box.y), box.y + box.h)];
    const len = Math.hypot(port[0] - a[0], port[1] - a[1]) || 1;
    const start: [number, number] = [a[0] + ((port[0] - a[0]) / len) * (r + 1.5), a[1] + ((port[1] - a[1]) / len) * (r + 1.5)];
    this.#nameAnchor = a;
    this.#nameWarm = { id: "name", placed: true, box, anchor: a, leader: { points: [start, port], style: "straight" } };
  }

  #span(): number {
    return Math.min(this.#w - 32, 1320);
  }

  #pos(t: Thing): [number, number] {
    return [this.#w / 2 + (t.u * this.#span()) / 2, t.v * this.#h];
  }

  #setPos(t: Thing, x: number, y: number): void {
    t.u = ((x - this.#w / 2) * 2) / this.#span();
    t.v = y / this.#h;
  }

  /** The dots shown: those clear of the text and the logo, unless the user put them there. */
  #visible(): Thing[] {
    return this.things.filter((t) => {
      if (t.moved || t.added !== undefined) return true;
      const [x, y] = this.#pos(t);
      if (x < 8 || x > this.#w - 8 || y < 8 || y > this.#h - 8) return false;
      const pad = t.r + 6;
      return ![...this.#obstacles, this.#logo].some(([ox, oy, ow, oh]) => x > ox - pad && x < ox + ow + pad && y > oy - pad && y < oy + oh + pad);
    });
  }

  /**
   * A place near (x, y) for a dot of radius r, on the stage and not under the text (dots
   * stop at the text's edge, so they stay in reach and in sight); null where none is near.
   */
  #free(x: number, y: number, r: number): [number, number] | null {
    for (let i = 0; i < 6; i++) {
      x = Math.min(Math.max(x, 8), this.#w - 8);
      y = Math.min(Math.max(y, 8), this.#h - 8);
      const pad = r + 3;
      const hit = this.#obstacles.find(([ox, oy, ow, oh]) => x > ox - pad && x < ox + ow + pad && y > oy - pad && y < oy + oh + pad);
      if (!hit) return [x, y];
      const [ox, oy, ow, oh] = hit;
      // out over the nearest edge
      const out: [number, number, number][] = [
        [ox - pad - 0.5 - x, 0, x - (ox - pad)],
        [ox + ow + pad + 0.5 - x, 0, ox + ow + pad - x],
        [0, oy - pad - 0.5 - y, y - (oy - pad)],
        [0, oy + oh + pad + 0.5 - y, oy + oh + pad - y],
      ];
      out.sort((a, b) => a[2] - b[2]);
      x += out[0]![0];
      y += out[0]![1];
    }
    return null;
  }

  #anchors(things: Thing[]): Map<string, [number, number]> {
    const m = new Map<string, [number, number]>([["name", this.#nameAnchor]]);
    for (const t of things) m.set(t.id, this.#pos(t));
    return m;
  }

  // --- solving -----------------------------------------------------------------------------

  #measure(text: string): number {
    this.#ctx.font = `400 ${SMALL}px ${this.#family}`;
    return Math.ceil(this.#ctx.measureText(text).width);
  }

  #problem(things: Thing[], rest: boolean): LabelProblem {
    const nb = this.#nameLabel.getBoundingClientRect();
    const nameFont = parseFloat(getComputedStyle(this.#nameLabel).fontSize);
    const pad = Math.round(nb.height * 0.2);
    const placements = this.result?.placements.filter((p) => p.id !== "name" || !this.#nameHome).map(warm) ?? [];
    if (this.#nameHome && this.#nameWarm) placements.push(this.#nameWarm);
    const sides = ["top-left", "top-right", "bottom-left", "bottom-right", "left", "right", "top", "bottom"];
    return {
      canvas: { width: Math.round(this.#w), height: Math.round(this.#h), padding: 6 },
      preset: "none",
      defaults: { font: { size: SMALL }, padding: 3 },
      items: [
        {
          id: "name",
          anchor: { type: "point", x: this.#nameAnchor[0], y: this.#nameAnchor[1], mark: { shape: "circle", r: this.#nameR } },
          label: {
            type: "text",
            text: this.#nameLabel.textContent?.trim() ?? "",
            width: Math.max(1, nb.width - 2 * pad),
            height: Math.max(1, nb.height - 2 * pad),
            padding: pad,
            font: { size: nameFont, weight: "bold" },
          },
          priority: 100,
          required: true,
          // the logo keeps its leader: the name sits at a distance from its dot
          placement: { models: ["distant"], position_order: sides },
        },
        ...things.map((t) => ({
          id: t.id,
          anchor: { type: "point", x: this.#pos(t)[0], y: this.#pos(t)[1], mark: { shape: "circle", r: t.r } },
          label: { type: "text", text: t.text, width: this.#measure(t.text), height: Math.round(SMALL * 1.25) },
          priority: t.priority,
        })),
      ],
      obstacles: this.#obstacles.length ? { vector: [{ class: "text", rects: this.#obstacles }] } : undefined,
      // the name may cover the dots of less important things (they lose their labels)
      avoid: { label: { lower_items: 10 }, leader: { text: 2, lower_items: 2.5 } },
      placement: { models: ["adjacent", "slider", "distant"], min_distance: "1em", max_distance: "6em" },
      leaders: { style: "straight", max_length: "8em", width: 2 },
      degrade: ["distant", "evict_lower", "omit"],
      solver: { time_budget_ms: rest ? BUDGET_REST : BUDGET_MOVING },
      warm_start: { placements },
    } as unknown as LabelProblem;
  }

  /** Solves again (once the solve running has returned). */
  #request(rest: boolean): void {
    this.#dirty = true;
    this.#rest = rest;
    if (!this.#busy) void this.#solve();
  }

  async #solve(): Promise<void> {
    this.#busy = true;
    while (this.#dirty && this.#w > 0) {
      this.#dirty = false;
      const things = this.#visible();
      const anchors = this.#anchors(things);
      const generation = this.#generation;
      const rest = this.#rest;
      try {
        const result = await this.#engine.place(this.#problem(things, rest));
        if (generation !== this.#generation) continue;
        this.result = result;
        this.solves++;
        this.#motion.target(result, anchors);
        // the name always shows: where it has no room, its dot glides back once let go
        if (result.placements.some((p) => p.id === "name" && p.placed)) this.#nameOk = anchors.get("name")!;
        else if (rest && !this.#drag && this.#nameOk) this.#glide = { from: this.#nameAnchor, to: this.#nameOk, t0: performance.now() };
        this.#showStats(result);
        this.#kick();
        // the first solve compiles the engine's code: solve once more for a time that tells
        if (this.solves === 1) this.#request(this.#rest);
      } catch (e) {
        console.warn("label-anything hero:", e);
        break;
      }
    }
    this.#busy = false;
  }

  #showStats(r: LabelResult): void {
    if (!this.#stats) return;
    const omitted = r.stats.total - r.stats.placed;
    const time = this.solves > 1 ? ` in ${Math.max(1, Math.round(r.stats.runtime_ms))} ms` : "";
    this.#stats.textContent = `${r.stats.placed} labels placed${omitted ? `, ${omitted} left out` : ""}${time}`;
    if (this.#hint && this.#hint.getBoundingClientRect().width > this.#hintW + 0.5) this.#layout();
  }

  // --- drawing -----------------------------------------------------------------------------

  #kick(): void {
    if (!this.#raf) this.#raf = requestAnimationFrame(() => this.#frame());
  }

  #frame(): void {
    this.#raf = 0;
    if (this.#glide) {
      const { from, to, t0 } = this.#glide;
      const t = this.#reduced ? 1 : Math.min(1, (performance.now() - t0) / 350);
      const e = 1 - (1 - t) ** 3;
      this.#nameAnchor = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      if (t >= 1) {
        this.#glide = null;
        this.#request(true);
      }
    }
    const things = this.#visible();
    const anchors = this.#anchors(things);
    this.#drawDots(things);
    const f = this.#motion.frame(anchors);
    this.#drawLabels(f.result.placements, f.opacity, f.leaderOpacity, anchors);
    // the drawing takes over from the static logo once it shows the name
    if (this.result?.placements.some((p) => p.id === "name" && p.placed)) this.root.classList.add("is-live");
    if (this.#motion.moving || this.#drag || this.#glide) this.#kick();
  }

  #drawDots(things: Thing[]): void {
    const seen = new Set<string>();
    const dot = (id: string, x: number, y: number, r: number, cls: string) => {
      seen.add(id);
      let c = this.#dots.get(id);
      if (!c) {
        c = this.#gDots.appendChild(svg("circle", cls));
        this.#dots.set(id, c);
      }
      c.setAttribute("cx", px(x));
      c.setAttribute("cy", px(y));
      c.setAttribute("r", px(r));
    };
    for (const t of things) dot(t.id, ...this.#pos(t), t.r, t.accent ? "la-hero__dot la-hero__dot--accent" : "la-hero__dot");
    dot("name", this.#nameAnchor[0], this.#nameAnchor[1], this.#nameR, "la-hero__dot la-hero__dot--name");
    for (const [id, c] of this.#dots) {
      if (!seen.has(id)) {
        c.remove();
        this.#dots.delete(id);
      }
    }
  }

  #drawLabels(placements: readonly Placement[], opacity: ReadonlyMap<string, number>, leaderOpacity: ReadonlyMap<string, number>, anchors: Map<string, [number, number]>): void {
    const seen = new Set<string>();
    this.#drawn.clear();
    for (const p of placements) {
      if (!p.placed || !p.box) continue;
      const id = p.id;
      const main = id === "name";
      seen.add(id);
      const o = opacity.get(id) ?? 1;
      // the leader, from the dot's centre (the dot covers its start)
      let path = this.#leaders.get(id);
      if (p.leader && p.leader.points.length >= 2) {
        if (!path) {
          path = this.#gLeaders.appendChild(svg("path", main ? "la-hero__leader la-hero__leader--name" : "la-hero__leader"));
          this.#leaders.set(id, path);
        }
        const pts = p.leader.points.map((q) => [q[0]!, q[1]!] as [number, number]);
        const a = anchors.get(id);
        if (a) pts[0] = a;
        if (main) {
          // into the box, under its rounded corner, as the static logo draws it
          const [q, e] = [pts[pts.length - 2]!, pts[pts.length - 1]!];
          const len = Math.hypot(e[0] - q[0], e[1] - q[1]) || 1;
          pts[pts.length - 1] = [e[0] + ((e[0] - q[0]) / len) * this.#nameRx, e[1] + ((e[1] - q[1]) / len) * this.#nameRx];
          path.style.strokeWidth = `${px(this.#nameStroke)}px`;
        }
        path.setAttribute("d", pts.map((q, i) => `${i ? "L" : "M"}${px(q[0])} ${px(q[1])}`).join(""));
        path.style.opacity = String(leaderOpacity.get(id) ?? o);
      } else if (path) {
        path.remove();
        this.#leaders.delete(id);
      }
      let s = this.#labels.get(id);
      if (!s) {
        const g = this.#gLabels.appendChild(svg("g", main ? "la-hero__label la-hero__label--name" : "la-hero__label"));
        const rect = main ? g.appendChild(svg("rect")) : undefined;
        const text = g.appendChild(svg("text"));
        text.textContent = main ? (this.#nameLabel.textContent?.trim() ?? "") : (this.things.find((t) => t.id === id)?.text ?? "");
        text.setAttribute("text-anchor", "middle");
        if (main) this.#styleName(text);
        s = { g, rect, text };
        this.#labels.set(id, s);
      }
      const b = p.box;
      if (s.rect) {
        s.rect.setAttribute("x", px(b.x));
        s.rect.setAttribute("y", px(b.y));
        s.rect.setAttribute("width", px(b.w));
        s.rect.setAttribute("height", px(b.h));
        s.rect.setAttribute("rx", px(this.#nameRx));
      }
      s.text.setAttribute("x", px(b.x + b.w / 2));
      s.text.setAttribute("y", px(b.y + (main ? this.#nameBase : this.#smallBase)));
      s.g.style.opacity = String(o);
      this.#drawn.set(id, b);
    }
    for (const [id, s] of this.#labels) {
      if (!seen.has(id)) {
        s.g.remove();
        this.#labels.delete(id);
        this.#leaders.get(id)?.remove();
        this.#leaders.delete(id);
      }
    }
  }

  // --- interaction -------------------------------------------------------------------------

  /** The dot or label at a point: its thing, or "name". */
  #hit(x: number, y: number, touch: boolean): Thing | "name" | null {
    const slop = touch ? 14 : 6;
    if (Math.hypot(x - this.#nameAnchor[0], y - this.#nameAnchor[1]) <= this.#nameR + slop) return "name";
    const things = this.#visible();
    let best: Thing | null = null;
    let bestD = Infinity;
    for (const t of things) {
      const [tx, ty] = this.#pos(t);
      const d = Math.hypot(x - tx, y - ty) - t.r;
      if (d <= slop && d < bestD) [best, bestD] = [t, d];
    }
    if (best) return best;
    const nb = this.#drawn.get("name");
    if (nb && inside(nb, x, y)) return "name";
    for (const t of things) {
      const b = this.#drawn.get(t.id);
      if (b && inside(b, x, y, touch ? 4 : 0)) return t;
    }
    return null;
  }

  #at(e: PointerEvent): [number, number] {
    const r = this.root.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  #listen(): void {
    // on the whole header: the text's boxes are wider than its lines, and a dot or a label
    // can sit next to a line, inside the box of its paragraph
    const root = this.root;
    const onStage = (e: Event) => e.target instanceof Node && this.#svg.contains(e.target);
    const grabbable = (e: Event) => !(e.target instanceof Element && e.target.closest("a, button"));
    root.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || !grabbable(e)) return;
      const [x, y] = this.#at(e);
      const hit = this.#hit(x, y, e.pointerType !== "mouse");
      if (hit) {
        const [ax, ay] = hit === "name" ? this.#nameAnchor : this.#pos(hit);
        this.#drag = { thing: hit, dx: ax - x, dy: ay - y, id: e.pointerId };
        if (hit === "name") this.#glide = null;
        root.setPointerCapture(e.pointerId);
        root.classList.add("is-dragging");
        e.preventDefault();
      } else if (onStage(e)) {
        this.#press = { x, y, t: performance.now(), id: e.pointerId };
      }
    });
    // on touch screens, a finger on a dot or label drags it instead of scrolling the page
    root.addEventListener(
      "touchstart",
      (e) => {
        const t = e.touches[0];
        if (!t || !grabbable(e)) return;
        const r = root.getBoundingClientRect();
        if (this.#hit(t.clientX - r.left, t.clientY - r.top, true)) e.preventDefault();
      },
      { passive: false },
    );
    root.addEventListener("pointermove", (e) => {
      const [x, y] = this.#at(e);
      if (!this.#drag) {
        if (e.pointerType === "mouse") root.classList.toggle("is-over", grabbable(e) && this.#hit(x, y, false) !== null);
        return;
      }
      if (e.pointerId !== this.#drag.id) return;
      const thing = this.#drag.thing;
      const to = this.#free(x + this.#drag.dx, y + this.#drag.dy, thing === "name" ? this.#nameR : thing.r);
      if (!to) return;
      const [nx, ny] = to;
      if (thing === "name") {
        this.#nameHome = false;
        this.#nameAnchor = [nx, ny];
      } else {
        thing.moved = true;
        this.#setPos(thing, nx, ny);
      }
      this.#request(false);
      this.#kick();
    });
    const end = (e: PointerEvent) => {
      if (this.#drag && e.pointerId === this.#drag.id) {
        this.#drag = null;
        root.classList.remove("is-dragging");
        this.#request(true);
        return;
      }
      const p = this.#press;
      this.#press = null;
      if (!p || p.id !== e.pointerId || e.type !== "pointerup") return;
      const [x, y] = this.#at(e);
      if (Math.hypot(x - p.x, y - p.y) < 6 && performance.now() - p.t < 600) this.#add(x, y);
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.querySelector("[data-la-hero-reset]")?.addEventListener("click", () => {
      this.#reset();
      this.#layout();
    });
  }

  /** A new dot where the user clicked, with the next label in turn. */
  #add(x: number, y: number): void {
    const n = this.#added;
    const t: Thing = { id: `add${n}`, text: MORE[n % MORE.length]!, u: 0, v: 0, r: 3 + ((n * 7) % 4), priority: 1, added: n, accent: n % 5 === 2 };
    const at = this.#free(x, y, t.r);
    if (!at) return;
    this.#added++;
    this.#setPos(t, ...at);
    this.things.push(t);
    while (this.things.length > MAX_THINGS) {
      const i = this.things.findIndex((q) => q.added !== undefined);
      if (i < 0) break;
      this.things.splice(i, 1);
    }
    this.#request(true);
    this.#kick();
  }

  #reset(): void {
    this.things = THINGS.map((t, i) => ({ ...t, id: `t${i}` }));
    this.#added = 0;
    this.#nameHome = true;
    this.#nameOk = null;
    this.#glide = null;
    this.result = undefined;
    this.#generation++;
  }
}

/** Starts the live header of the page, if it has one. */
export function start(doc: Document = document): Hero | undefined {
  const root = doc.querySelector<HTMLElement>("[data-la-hero]");
  if (!root || typeof Worker === "undefined") return undefined;
  const url = new URL("engine-ts.js", import.meta.url);
  const engine = createWorkerEngine(() => new Worker(url, { type: "module", name: "label-anything-hero" }));
  const hero = new Hero(root, engine);
  (globalThis as { labelAnythingHero?: Hero }).labelAnythingHero = hero;
  return hero;
}

start();
