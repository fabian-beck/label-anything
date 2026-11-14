/**
 * What the home page's live examples share: the drawing (an SVG that takes the place of
 * the static figure), the solve loop (the latest state wins; every solve starts from the
 * labels shown, so they stay where they can), calm transitions between results
 * (`LabelMotion`), and the hover: the label, its leader and its mark stand out, and a
 * tooltip gives the item's name (also of an item whose label was left out) and its values.
 */
import type { LabelProblem, LabelResult, RgbaPixels } from "@label-anything/core";
import { LabelMemory, LabelMotion, renderLabels, type Anchors, type MotionFrame, type MotionOptions, type RenderOptions } from "@label-anything/extras";
import type { WorkerEngine } from "@label-anything/extras/worker";
import { html, svg, type Pt } from "./util.js";

export type Placement = LabelResult["placements"][number];

/** What the tooltip says about an item. */
export interface Info {
  title: string;
  subtitle?: string;
  rows?: readonly (readonly [string, string])[];
}

/** A problem to solve, and where its items' anchors are (for the next solve's warm start). */
export interface Solve {
  problem: LabelProblem;
  anchors: Map<string, Pt>;
  raster?: RgbaPixels;
}

export interface Example {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  /** The drawing's accessible name. */
  readonly title: string;
  /** What one can do with it, in a line below the drawing. */
  readonly hint: string;
  /** How the labels and leaders are drawn. */
  readonly render: Omit<RenderOptions, "opacity" | "leaderOpacity">;
  readonly motion?: MotionOptions;
  /** Draws the picture and adds the controls. */
  mount(stage: Stage): void;
  /** The problem of the current state; `rest`: nothing moves, so the solve may take its time. */
  solve(rest: boolean): Solve;
  /** Where the anchors are now (they move during a transition, a drag, a pan). */
  anchors(): Anchors;
  /** Updates the picture for this animation frame; true while it moves by itself. */
  frame?(now: number): boolean;
  /** After the labels of a frame are drawn. */
  drawn?(frame: MotionFrame): void;
  solved?(result: LabelResult, solve: Solve): void;
  /** The item whose mark is at a point of the drawing. */
  hit(x: number, y: number): string | null;
  info(id: string): Info | null;
  /** Makes the mark of an item stand out (null: none). */
  highlight(id: string | null): void;
  /** Items whose labels stay readable while an item is hovered (its neighbours in a graph). */
  related?(id: string): ReadonlySet<string>;
}

const BUDGET_MOVING = 8; // ms of the Rust core; the TypeScript worker scales it

export class Stage {
  readonly root: HTMLDivElement;
  readonly bar: HTMLDivElement;
  readonly controls: HTMLSpanElement;
  readonly frameEl: HTMLDivElement;
  readonly svg: SVGSVGElement;
  /** Layers, bottom to top: the picture, the labels and leaders, marks above them, the hover. */
  readonly picture: SVGGElement;
  readonly labels: SVGGElement;
  readonly top: SVGGElement;
  readonly hover: SVGGElement;
  /** The latest result, the number of solves and whether the drawing has replaced the static figure. */
  result: LabelResult | undefined;
  solves = 0;
  live = false;
  /** Set by an example while a drag or a pan is under way: no hover then. */
  gesture = false;
  hoverId: string | null = null;
  readonly reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  #ex: Example;
  #engine: WorkerEngine;
  #figure: HTMLElement;
  /** The static figure the drawing replaces. */
  #static: HTMLElement | null;
  #motion: LabelMotion;
  #memory = new LabelMemory();
  #status: HTMLSpanElement;
  #tip: HTMLDivElement;
  #dirty = false;
  #busy = false;
  #rest = true;
  #cold = false;
  #raf = 0;
  #shown: Placement[] = [];
  #pointer: Pt = [0, 0];

  constructor(figure: HTMLElement, ex: Example, engine: WorkerEngine) {
    this.#figure = figure;
    this.#ex = ex;
    this.#engine = engine;
    this.#motion = new LabelMotion(this.reduced ? { duration: 0 } : (ex.motion ?? {}));

    this.root = html("div", `la-example la-example--${ex.name}`);
    this.root.hidden = true;
    this.bar = html("div", "la-example__bar", undefined, this.root);
    html("span", "la-example__live", "Live", this.bar);
    this.controls = html("span", "la-example__controls", undefined, this.bar);
    this.#status = html("span", "la-example__status", undefined, this.bar);
    this.#status.setAttribute("aria-live", "polite");
    this.frameEl = html("div", "la-example__stage", undefined, this.root);
    this.svg = svg("svg", { class: "la-example__svg", viewBox: `0 0 ${ex.width} ${ex.height}`, role: "img", "aria-label": ex.title }, this.frameEl);
    this.picture = svg("g", { class: "la-ex-picture" }, this.svg);
    this.labels = svg("g", { class: "la-ex-labels" }, this.svg);
    this.top = svg("g", { class: "la-ex-top" }, this.svg);
    this.hover = svg("g", { class: "la-ex-hover", "pointer-events": "none" }, this.svg);
    this.#tip = html("div", "la-example__tip", undefined, this.frameEl);
    this.#tip.hidden = true;
    this.#tip.style.pointerEvents = "none"; // never between the pointer and the drawing
    html("p", "la-example__hint", ex.hint, this.root);
    this.#static = ([...figure.children] as HTMLElement[]).find((c) => c.matches("img") || c.querySelector("img")) ?? null;
    figure.insertBefore(this.root, this.#static ?? figure.firstElementChild);

    ex.mount(this);

    this.svg.addEventListener("pointermove", (ev) => this.#point(ev));
    this.svg.addEventListener("pointerdown", (ev) => this.#point(ev));
    this.svg.addEventListener("pointerleave", (ev) => {
      if (ev.pointerType !== "touch") this.setHover(null);
    });
    // a tap elsewhere ends the hover a tap began
    document.addEventListener("pointerdown", (ev) => {
      if (this.hoverId !== null && !this.svg.contains(ev.target as Node)) this.setHover(null);
    });
    this.request(true);
  }

  /** A pointer event's place in the drawing's coordinates. */
  toCanvas(ev: { clientX: number; clientY: number }): Pt {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(ev.clientX, ev.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }

  /** The item at a point: the one whose label is there, else the one whose mark is. */
  pick(x: number, y: number): string | null {
    for (let i = this.#shown.length - 1; i >= 0; i--) {
      const b = this.#shown[i]!.box;
      if (b && x >= b.x - 2 && x <= b.x + b.w + 2 && y >= b.y - 2 && y <= b.y + b.h + 2) return this.#shown[i]!.id;
    }
    return this.#ex.hit(x, y);
  }

  /** Solves again for the example's current state; `cold`: not from the labels shown. */
  request(rest = true, cold = false): void {
    this.#dirty = true;
    this.#rest = rest;
    if (cold) this.#cold = true;
    if (!this.#busy) void this.#solve();
  }

  /** Draws the next frame (the picture changed, or will). */
  kick(): void {
    if (!this.#raf) this.#raf = requestAnimationFrame((now) => this.#frame(now));
  }

  /** Nothing to solve and nothing moving: the drawing shows the latest state's labels. */
  get idle(): boolean {
    return !this.#busy && !this.#dirty && !this.#raf && !this.#motion.moving;
  }

  /** Whether the latest result has a label for an item. */
  placed(id: string): boolean {
    return this.result?.placements.some((p) => p.id === id && p.placed) ?? false;
  }

  setHover(id: string | null): void {
    if (id !== this.hoverId) {
      this.hoverId = id;
      this.#ex.highlight(id);
      this.#markHover();
      const info = id === null ? null : this.#ex.info(id);
      this.#tip.replaceChildren();
      if (info) {
        html("strong", "la-example__tip-title", info.title, this.#tip);
        if (info.subtitle) html("span", "la-example__tip-sub", info.subtitle, this.#tip);
        if (info.rows?.length) {
          const dl = html("dl", undefined, undefined, this.#tip);
          for (const [k, v] of info.rows) {
            html("dt", undefined, k, dl);
            html("dd", undefined, v, dl);
          }
        }
      }
      this.#tip.hidden = !info;
    }
    if (!this.#tip.hidden) this.#placeTip();
  }

  /** Hides the tooltip (a drag begins); the hovered item still stands out. */
  hideTip(): void {
    this.#tip.hidden = true;
  }

  #point(ev: PointerEvent): void {
    if (this.gesture) return;
    this.#pointer = [ev.clientX, ev.clientY];
    const [x, y] = this.toCanvas(ev);
    this.setHover(this.pick(x, y));
  }

  /** The tooltip beside the pointer, inside the drawing. */
  #placeTip(): void {
    const box = this.frameEl.getBoundingClientRect();
    const w = this.#tip.offsetWidth;
    const h = this.#tip.offsetHeight;
    let x = this.#pointer[0] - box.left + 14;
    let y = this.#pointer[1] - box.top + 14;
    if (x + w > box.width - 4) x = this.#pointer[0] - box.left - w - 10;
    if (y + h > box.height - 4) y = this.#pointer[1] - box.top - h - 10;
    this.#tip.style.left = `${Math.max(4, x)}px`;
    this.#tip.style.top = `${Math.max(4, y)}px`;
  }

  /** The hovered item's label and leader stand out; the others step back (in CSS). */
  #markHover(): void {
    const id = this.hoverId;
    this.root.classList.toggle("has-hover", id !== null);
    for (const e of this.labels.querySelectorAll(".is-hover, .is-related")) e.classList.remove("is-hover", "is-related");
    if (id === null) return;
    const related = this.#ex.related?.(id);
    for (const e of this.labels.querySelectorAll(".la-item, .la-leader")) {
      const of = e.getAttribute("data-id") ?? "";
      if (of === id) e.classList.add("is-hover");
      else if (related?.has(of)) e.classList.add("is-related");
    }
  }

  async #solve(): Promise<void> {
    this.#busy = true;
    while (this.#dirty) {
      this.#dirty = false;
      const rest = this.#rest;
      if (this.#cold) this.#memory.clear();
      this.#cold = false;
      const solve = this.#ex.solve(rest);
      // from the labels shown; an item left out before is free to get a label now
      const shown = this.#memory.warmStart(solve.anchors)?.placements.filter((p) => p.placed);
      const warm = shown?.length ? { placements: shown } : undefined;
      const solver = { ...solve.problem.solver, ...(rest ? {} : { time_budget_ms: BUDGET_MOVING }) };
      const problem = { ...solve.problem, solver, ...(warm ? { warm_start: warm } : {}) } as LabelProblem;
      try {
        const result = await this.#engine.place(problem, solve.raster ? { raster: solve.raster } : {});
        this.result = result;
        this.solves++;
        // an area's anchor is where the engine put it: the result says
        const at = new Map(solve.anchors);
        for (const p of result.placements) if (p.anchor) at.set(p.id, [p.anchor[0]!, p.anchor[1]!]);
        this.#memory.remember(result, at);
        this.#ex.solved?.(result, solve);
        this.#motion.target(result, solve.anchors);
        this.#showStatus(result);
        this.kick();
      } catch (e) {
        console.warn(`label-anything example ${this.#ex.name}:`, e);
        break;
      }
    }
    this.#busy = false;
  }

  #showStatus(r: LabelResult): void {
    const grouped = r.placements.filter((p) => p.reason === "grouped").length;
    const total = r.stats.total - grouped;
    const ms = r.stats.runtime_ms;
    this.#status.textContent = `${r.stats.placed} of ${total} labels · ${ms < 10 ? ms.toFixed(1) : Math.round(ms)} ms`;
  }

  #frame(now: number): void {
    this.#raf = 0;
    const animating = this.#ex.frame?.(now) ?? false;
    if (this.result) {
      const f = this.#motion.frame(this.#ex.anchors());
      renderLabels(this.labels, f.result, { ...this.#ex.render, opacity: f.opacity, leaderOpacity: f.leaderOpacity });
      this.#shown = f.result.placements.filter((p) => p.placed && p.box);
      this.#ex.drawn?.(f);
      this.#markHover();
      if (!this.live) this.#goLive();
    }
    if (animating || this.#motion.moving) this.kick();
  }

  /** The drawing takes the place of the static figure. */
  #goLive(): void {
    this.live = true;
    this.root.hidden = false;
    if (this.#static) this.#static.hidden = true;
    this.#figure.classList.add("is-live");
  }
}
