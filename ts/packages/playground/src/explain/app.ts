/**
 * The explainer: a scene's problem solved by the real engine with a trace, shown one step
 * at a time — the drawing as it stood after the step, what the step decided and why, the
 * numbers behind it — with a timeline to scrub, options to change, and marks to drag (each
 * change solves again).
 */
import type { LabelProblem, LabelResult, SolveTrace, TraceEvent } from "@label-anything/core";
import { Engines, samePlacements } from "../engines.js";
import { copyText, h } from "../ui/dom.js";
import { merge } from "../util.js";
import { BAND_COLORS, bandColor, buildOverlay, drawStage, fitView, hitTest, type Hover, type Overlay, type View } from "./draw.js";
import { Explained, type GroupId, type Move, candText } from "./model.js";
import { esc, fmtCost, narrate, where } from "./narrate.js";
import { type ExplainScene, type SceneControl } from "./scenes.js";
import { Timeline } from "./timeline.js";

interface Solved {
  result: LabelResult;
  trace: SolveTrace;
  ms: number;
}

/** The traced engine in its worker; the latest problem wins. */
class TracedEngine {
  #worker: Worker;
  #next = 1;
  #pending = new Map<number, { resolve: (s: Solved) => void; reject: (e: Error) => void }>();

  constructor(url: URL) {
    this.#worker = new Worker(url, { type: "module", name: "label-anything-trace" });
    this.#worker.onmessage = (ev: MessageEvent<{ id: number; ok: boolean; result?: LabelResult; trace?: SolveTrace; ms?: number; error?: string }>) => {
      const p = this.#pending.get(ev.data.id);
      if (!p) return;
      this.#pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve({ result: ev.data.result!, trace: ev.data.trace!, ms: ev.data.ms! });
      else p.reject(new Error(ev.data.error));
    };
  }

  solve(problem: LabelProblem): Promise<Solved> {
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#worker.postMessage({ id, problem });
    });
  }
}

const LADDER = ["alternatives", "wrap", "distant", "evict_lower", "shrink:0.85", "soft_overlap"] as const;
const MODELS = ["adjacent", "slider", "distant"] as const;

interface Algo {
  strategy: "auto" | "greedy" | "local" | "exact";
  models: Record<(typeof MODELS)[number], boolean> | null;
  lookahead: boolean;
  moves: number;
  seed: number;
  fontSize: number;
  ladder: Record<(typeof LADDER)[number], boolean>;
}

const DEFAULT_MOVES = 10000;

function defaultAlgo(): Algo {
  return {
    strategy: "auto",
    models: null,
    lookahead: true,
    moves: DEFAULT_MOVES,
    seed: 0,
    fontSize: 12,
    ladder: { alternatives: true, wrap: true, distant: true, evict_lower: true, "shrink:0.85": true, soft_overlap: true },
  };
}

/** Steps per second of playback (at 1×) in each phase. */
const RATE: Record<GroupId, number> = { prepare: 0.6, candidates: 3, greedy: 2, search: 60, repairs: 0.8, verify: 0.6 };

const TERMS: Record<string, string> = {
  position: "position rank",
  distance: "distance from the mark",
  shape: "shape (shorter, wrapped, smaller)",
  edge: "close to the edge",
  ambiguity: "nearer another mark",
  leader: "leader",
  items: "covers marks",
  lower_items: "covers less important marks",
  contrast: "backdrop contrast",
  stability: "moved from before",
  user: "host cost",
  canvas_edge: "beyond the edge",
};

function termName(t: string): string {
  if (TERMS[t]) return TERMS[t]!;
  if (t.startsWith("buffer:")) return `near ${t.slice(7)}`;
  if (t.startsWith("leader:")) return `leader over ${t.slice(7)}`;
  return `covers ${t}`;
}

export class ExplainApp {
  #scenes: ExplainScene[];
  #scene: ExplainScene;
  #base: URL;
  #engine: TracedEngine;
  #wasm: Engines | null = null;
  #algo: Algo = defaultAlgo();
  #ex: Explained | null = null;
  #step = 0;
  #pinned: number | null = null;
  #hover: Hover = { cand: null, item: null };
  #overlay: Overlay | null = null;
  #view: View = { scale: 1, ox: 0, oy: 0 };
  #playing = false;
  #speed = 1;
  #acc = 0;
  #last = 0;
  #solving = false;
  /** A solve was asked for while one ran (and the step it asked for). */
  #again = false;
  #againStep: number | undefined = undefined;
  #problem: LabelProblem | null = null;
  #ms = 0;
  /** The reader's zoom over the fitted view: screen = fitted · z + (tx, ty). */
  #zoom = { z: 1, tx: 0, ty: 0 };
  #press: { x: number; y: number; hit: Hover; mode: "mark" | "pan"; moved: boolean; tx: number; ty: number; id: string | null } | null = null;
  #timeline!: Timeline;
  #el!: Record<string, HTMLElement>;
  #canvas!: HTMLCanvasElement;
  #wasmCheck: string = "";

  constructor(scenes: ExplainScene[], base: URL) {
    this.#scenes = scenes;
    this.#scene = scenes[0]!;
    this.#base = base;
    this.#engine = new TracedEngine(new URL("explain-worker.js", base));
  }

  async start(): Promise<void> {
    const $ = (id: string) => document.getElementById(id)!;
    this.#el = {
      scenes: $("scenes"),
      phase: $("phase"),
      title: $("title"),
      story: $("story"),
      details: $("details"),
      item: $("item"),
      scene: $("opts-scene"),
      algo: $("opts-algo"),
      json: $("problem-json"),
      credits: $("credits"),
      tip: $("tip"),
      banner: $("banner"),
      transport: $("transport"),
      now: $("now"),
      legend: $("legend"),
      about: $("about"),
      busy: $("busy"),
    };
    this.#canvas = $("stage") as HTMLCanvasElement;
    this.#timeline = new Timeline($("timeline") as HTMLCanvasElement, (k) => {
      this.#pause();
      this.go(k);
    });
    this.#buildTransport();
    this.#buildLegend();
    this.#bindStage();
    this.#bindKeys();
    new ResizeObserver(() => this.#renderStage()).observe(this.#canvas);
    try {
      const b = (await (await fetch(new URL("build.json", this.#base))).json()) as { wasm?: boolean };
      if (b.wasm) this.#wasm = new Engines(this.#base);
    } catch {
      this.#wasm = null;
    }
    window.addEventListener("hashchange", () => void this.#fromHash());
    await this.#fromHash(true);
  }

  /** The scene and step of the address (`#scene=europe&step=120`). */
  async #fromHash(first = false): Promise<void> {
    const hash = new URLSearchParams(location.hash.slice(1));
    const want = this.#scenes.find((s) => s.id === hash.get("scene")) ?? (first ? this.#scenes[0]! : this.#scene);
    const step = hash.has("step") ? Number(hash.get("step")) - 1 : 0;
    const k = Number.isFinite(step) ? step : 0;
    if (first || want !== this.#scene) await this.selectScene(want, k);
    else if (k !== this.#step) this.go(k);
  }

  /** The latest solve (for tests and the console). */
  get explained(): Explained | null {
    return this.#ex;
  }

  get step(): number {
    return this.#step;
  }

  get scene(): ExplainScene {
    return this.#scene;
  }

  /** Change an algorithm option and solve again (for tests). */
  async setOption(key: keyof Algo, value: unknown): Promise<void> {
    (this.#algo as unknown as Record<string, unknown>)[key] = value;
    this.#buildAlgoOptions();
    await this.solve();
  }

  // --- scenes, options, solving --------------------------------------------------------

  async selectScene(s: ExplainScene, step = 0): Promise<void> {
    this.#scene = s;
    this.#pinned = null;
    this.#algo = defaultAlgo();
    this.#zoom = { z: 1, tx: 0, ty: 0 };
    this.#el.scenes.replaceChildren(
      ...this.#scenes.map((sc) => h("button", { type: "button", "aria-pressed": String(sc === s), onclick: () => void this.selectScene(sc) }, sc.title)),
    );
    this.#el.about.innerHTML = s.about;
    this.#el.credits.innerHTML = `${s.credits} The engine: <code>placeTraced</code> of <code>@label-anything/core</code>, the TypeScript port of the Rust core.`;
    await s.load(this.#base);
    this.#buildSceneOptions();
    this.#buildAlgoOptions();
    this.#ex = null;
    await this.solve(step);
  }

  #patch(): Record<string, unknown> {
    const a = this.#algo;
    const p: Record<string, unknown> = {};
    const solver: Record<string, unknown> = {};
    if (a.strategy !== "auto") solver.strategy = a.strategy;
    if (a.moves !== DEFAULT_MOVES) solver.max_iterations = a.moves;
    if (a.seed !== 0) solver.seed = a.seed;
    if (Object.keys(solver).length) p.solver = solver;
    if (a.models) p.placement = { models: MODELS.filter((m) => a.models![m]) };
    if (!a.lookahead) p.weights = { lookahead: 0, starve: 0 };
    if (a.fontSize !== 12) p.defaults = { font: { size: a.fontSize } };
    if (LADDER.some((s) => !a.ladder[s])) p.degrade = [...LADDER.filter((s) => a.ladder[s]), "omit"];
    return p;
  }

  #buildProblem(): LabelProblem {
    return merge(this.#scene.problem(), this.#patch());
  }

  /** Solve the scene's problem again; keep the reader's place (the same phase and position in it), or go to `step`. */
  async solve(step?: number): Promise<void> {
    const problem = this.#buildProblem();
    this.#problem = problem;
    this.#el.json.textContent = JSON.stringify(problem, null, 1);
    if (this.#solving) {
      this.#again = true;
      if (step !== undefined) this.#againStep = step;
      return;
    }
    this.#solving = true;
    this.#el.busy.classList.add("on");
    const scene = this.#scene;
    try {
      const solved = await this.#engine.solve(problem);
      // a solve of the scene the reader left is not shown
      if (scene !== this.#scene) return;
      this.#banner(null);
      const prev = this.#ex;
      const ex = new Explained(solved.trace, solved.result);
      let k = step ?? 0;
      if (step === undefined && prev) {
        const g = prev.groupAt(this.#step);
        const ng = ex.group(g.id) ?? ex.groups[ex.groups.length - 1]!;
        k = this.#step >= prev.length - 1 ? ex.length - 1 : Math.min(ng.end - 1, ng.start + (this.#step - g.start));
      }
      this.#ex = ex;
      this.#ms = solved.ms;
      if (this.#pinned !== null && this.#pinned >= ex.trace.items.length) this.#pinned = null;
      this.#timeline.setData(ex);
      this.go(k);
      void this.#checkWasm(problem, solved.result);
    } catch (e) {
      this.#banner(e instanceof Error ? e.message : String(e));
    } finally {
      this.#solving = false;
      this.#el.busy.classList.remove("on");
      if (this.#again) {
        const k = this.#againStep;
        this.#again = false;
        this.#againStep = undefined;
        void this.solve(k);
      }
    }
  }

  /** Solve the same problem with the WebAssembly engine (the Rust core) and compare. */
  async #checkWasm(problem: LabelProblem, result: LabelResult): Promise<void> {
    if (!this.#wasm) {
      this.#wasmCheck = "";
      return;
    }
    try {
      const { result: r } = await this.#wasm.place("wasm", problem);
      if (problem !== this.#problem) return;
      const cmp = samePlacements(result, r);
      this.#wasmCheck =
        cmp.same === cmp.total
          ? `<span class="ok">✓</span> The WebAssembly build of the Rust core gives the same ${cmp.total} placements.`
          : `<span class="err">✗</span> WebAssembly differs at ${esc(cmp.firstDiff ?? "?")} (${cmp.same} of ${cmp.total} the same).`;
    } catch {
      this.#wasmCheck = "";
    }
    this.#renderFooter();
  }

  #banner(text: string | null): void {
    const b = this.#el.banner;
    b.hidden = text === null;
    if (text !== null) b.textContent = text;
  }

  // --- navigation ----------------------------------------------------------------------

  go(k: number): void {
    const ex = this.#ex;
    if (!ex) return;
    this.#step = Math.max(0, Math.min(ex.length - 1, Math.round(k)));
    this.#hover = { cand: null, item: null };
    this.#hideTip();
    this.#render();
    this.#saveHash();
  }

  #saveHash(): void {
    const s = `#scene=${this.#scene.id}&step=${this.#step + 1}`;
    if (location.hash !== s) history.replaceState(null, "", s);
  }

  #play(): void {
    const ex = this.#ex;
    if (!ex) return;
    if (this.#step >= ex.length - 1) this.go(0);
    this.#playing = true;
    // the explanation is a live region: not while the steps run by
    this.#el.now.setAttribute("aria-live", "off");
    this.#acc = 0;
    this.#last = performance.now();
    this.#renderTransport();
    const tick = (t: number) => {
      if (!this.#playing || !this.#ex) return;
      const dt = Math.min(250, t - this.#last);
      this.#last = t;
      const g = this.#ex.groupAt(this.#step).id;
      this.#acc += (dt / 1000) * RATE[g] * this.#speed;
      if (this.#acc >= 1) {
        const n = Math.floor(this.#acc);
        this.#acc -= n;
        const next = Math.min(this.#ex.length - 1, this.#step + n);
        // stop at the start of each phase group for a moment
        const ng = this.#ex.groupAt(next);
        const k = ng.id !== g ? ng.start : next;
        this.go(k);
        if (k >= this.#ex.length - 1) {
          this.#pause();
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  #pause(): void {
    this.#playing = false;
    this.#el.now.setAttribute("aria-live", "polite");
    this.#renderTransport();
  }

  #buildTransport(): void {
    const t = this.#el.transport;
    const btn = (label: string, title: string, run: () => void, html?: string) => {
      const b = h("button", { type: "button", class: "tbtn", title, "aria-label": title, onclick: run });
      if (html) b.innerHTML = html;
      else b.textContent = label;
      return b;
    };
    const ex = () => this.#ex;
    const prevPhase = () => {
      const e = ex();
      if (!e) return;
      const g = e.groupAt(this.#step);
      const i = e.groups.indexOf(g);
      this.go(this.#step > g.start || i === 0 ? g.start : e.groups[i - 1]!.start);
    };
    const nextPhase = () => {
      const e = ex();
      if (!e) return;
      const i = e.groups.indexOf(e.groupAt(this.#step));
      this.go(i + 1 < e.groups.length ? e.groups[i + 1]!.start : e.length - 1);
    };
    const play = btn("", "Play (space)", () => (this.#playing ? this.#pause() : this.#play()));
    play.id = "play";
    t.replaceChildren(
      btn("", "Start of the phase, or the previous phase (Page Up)", () => (this.#pause(), prevPhase()), SVG.first),
      btn("", "Previous decision (Shift + ←)", () => (this.#pause(), this.go(ex() ? ex()!.nextMajor(this.#step, -1) : 0)), SVG.prevMajor),
      btn("", "Previous step (←)", () => (this.#pause(), this.go(this.#step - 1)), SVG.prev),
      play,
      btn("", "Next step (→)", () => (this.#pause(), this.go(this.#step + 1)), SVG.next),
      btn("", "Next decision (Shift + →)", () => (this.#pause(), this.go(ex() ? ex()!.nextMajor(this.#step, 1) : 0)), SVG.nextMajor),
      btn("", "Next phase (Page Down)", () => (this.#pause(), nextPhase()), SVG.last),
      h(
        "label",
        { class: "speed", title: "Playback speed" },
        h("span", { class: "sr" }, "Speed"),
        h(
          "select",
          {
            onchange: (e: Event) => {
              this.#speed = Number((e.target as HTMLSelectElement).value);
            },
          },
          ...[0.5, 1, 2, 4, 10].map((v) => h("option", { value: String(v), selected: v === 1 }, `${v}×`)),
        ),
      ),
      h("span", { class: "counter", id: "counter" }),
    );
    this.#el.counter = t.querySelector("#counter")!;
    this.#renderTransport();
  }

  #renderTransport(): void {
    const play = document.getElementById("play");
    if (play) {
      play.innerHTML = this.#playing ? SVG.pause : SVG.play;
      play.setAttribute("aria-pressed", String(this.#playing));
      play.title = this.#playing ? "Pause (space)" : "Play (space)";
    }
  }

  #bindKeys(): void {
    window.addEventListener("keydown", (e) => {
      const tgt = e.target as HTMLElement;
      if (tgt.closest("input, select, textarea, [contenteditable]")) return;
      const ex = this.#ex;
      if (!ex) return;
      let k: number | null = null;
      switch (e.key) {
        case "ArrowRight":
          k = e.shiftKey ? ex.nextMajor(this.#step, 1) : this.#step + 1;
          break;
        case "ArrowLeft":
          k = e.shiftKey ? ex.nextMajor(this.#step, -1) : this.#step - 1;
          break;
        case "Home":
          k = 0;
          break;
        case "End":
          k = ex.length - 1;
          break;
        case "PageDown": {
          const i = ex.groups.indexOf(ex.groupAt(this.#step));
          k = i + 1 < ex.groups.length ? ex.groups[i + 1]!.start : ex.length - 1;
          break;
        }
        case "PageUp": {
          const g = ex.groupAt(this.#step);
          const i = ex.groups.indexOf(g);
          k = this.#step > g.start || i === 0 ? g.start : ex.groups[i - 1]!.start;
          break;
        }
        case " ":
          if (tgt.closest("button")) return;
          e.preventDefault();
          if (this.#playing) this.#pause();
          else this.#play();
          return;
        case "Escape":
          this.#pinned = null;
          this.#render();
          return;
        default:
          return;
      }
      e.preventDefault();
      this.#pause();
      this.go(k);
    });
  }

  // --- the drawing ---------------------------------------------------------------------

  #toProblem(e: PointerEvent): [number, number] {
    const r = this.#canvas.getBoundingClientRect();
    const v = this.#view;
    return [(e.clientX - r.left - v.ox) / v.scale, (e.clientY - r.top - v.oy) / v.scale];
  }

  #bindStage(): void {
    const c = this.#canvas;
    const tol = () => 8 / this.#view.scale;
    c.addEventListener("pointerdown", (e) => {
      const ex = this.#ex;
      if (!ex || !this.#overlay) return;
      const [x, y] = this.#toProblem(e);
      const hit = hitTest(ex, this.#step, this.#overlay, x, y, tol());
      const mark = hit.item !== null && this.#scene.draggable(ex.trace.items[hit.item]!.id) && nearMark(ex, hit.item, x, y, tol());
      this.#press = { x: e.clientX, y: e.clientY, hit, mode: mark ? "mark" : "pan", moved: false, tx: this.#zoom.tx, ty: this.#zoom.ty, id: mark ? ex.trace.items[hit.item!]!.id : null };
      c.setPointerCapture(e.pointerId);
    });
    c.addEventListener("pointermove", (e) => {
      const ex = this.#ex;
      if (!ex || !this.#overlay) return;
      const [x, y] = this.#toProblem(e);
      const p = this.#press;
      if (p) {
        if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 3) {
          p.moved = true;
          this.#pause();
          this.#hideTip();
          c.classList.add("grabbing");
        }
        if (!p.moved) return;
        if (p.mode === "mark") {
          this.#scene.move(p.id!, x, y);
          void this.solve();
        } else {
          this.#zoom.tx = p.tx + e.clientX - p.x;
          this.#zoom.ty = p.ty + e.clientY - p.y;
          this.#renderStage();
        }
        return;
      }
      const hit = hitTest(ex, this.#step, this.#overlay, x, y, tol());
      const draggable = hit.item !== null && this.#scene.draggable(ex.trace.items[hit.item]!.id) && nearMark(ex, hit.item, x, y, tol());
      c.classList.toggle("grab", draggable);
      c.classList.toggle("pointer", !draggable && (hit.cand !== null || hit.item !== null));
      if (hit.cand !== this.#hover.cand || hit.item !== this.#hover.item) {
        this.#hover = hit;
        this.#renderStage();
      }
      this.#showTip(e, hit);
    });
    const end = () => {
      const p = this.#press;
      this.#press = null;
      c.classList.remove("grabbing");
      if (!p || p.moved || !this.#ex) return;
      // a click: follow the item clicked (again: stop following it)
      const hit = p.hit;
      const item = hit.item ?? (hit.cand !== null ? this.#ex.trace.candidates[hit.cand]!.item : null);
      this.#pinned = item !== null && item === this.#pinned && hit.cand === null ? null : item;
      this.#render();
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", () => {
      this.#press = null;
      c.classList.remove("grabbing");
    });
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const r = c.getBoundingClientRect();
        this.#zoomBy(Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
      },
      { passive: false },
    );
    c.addEventListener("dblclick", () => this.#zoomFit());
    const zoom = document.getElementById("zoom")!;
    const zb = (text: string, title: string, run: () => void, cls = "") => h("button", { type: "button", title, "aria-label": title, class: cls, onclick: run }, text);
    zoom.replaceChildren(
      zb("+", "Zoom in (or scroll)", () => this.#zoomBy(1.5, c.clientWidth / 2, c.clientHeight / 2)),
      zb("−", "Zoom out", () => this.#zoomBy(1 / 1.5, c.clientWidth / 2, c.clientHeight / 2)),
      zb("Fit", "Fit the drawing (or double-click)", () => this.#zoomFit(), "fit"),
    );
    c.addEventListener("pointerleave", () => {
      if (this.#hover.cand !== null || this.#hover.item !== null) {
        this.#hover = { cand: null, item: null };
        this.#renderStage();
      }
      this.#hideTip();
    });
  }

  #renderStage(): void {
    const ex = this.#ex;
    const c = this.#canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const hh = c.clientHeight;
    if (w === 0 || hh === 0) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hh * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hh * dpr);
    }
    const ctx = c.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hh);
    if (!ex || !this.#problem) return;
    const cv = this.#problem.canvas as { width: number; height: number };
    const fit = fitView(cv.width, cv.height, w, hh);
    const z = this.#zoom;
    this.#view = { scale: fit.scale * z.z, ox: fit.ox * z.z + z.tx, oy: fit.oy * z.z + z.ty };
    this.#overlay = buildOverlay(ex, this.#step, this.#pinned);
    drawStage(ctx, this.#view, ex, this.#step, this.#overlay, this.#hover, (g) => this.#scene.background(g), cv);
  }

  /** Zoom by `f` around the point (sx, sy) of the drawing (CSS px). */
  #zoomBy(f: number, sx: number, sy: number): void {
    const z = this.#zoom;
    const nz = Math.min(16, Math.max(1, z.z * f));
    const g = nz / z.z;
    z.tx = sx - (sx - z.tx) * g;
    z.ty = sy - (sy - z.ty) * g;
    z.z = nz;
    if (nz === 1) {
      z.tx = 0;
      z.ty = 0;
    }
    this.#renderStage();
  }

  #zoomFit(): void {
    this.#zoom = { z: 1, tx: 0, ty: 0 };
    this.#renderStage();
  }

  #buildLegend(): void {
    const sw = (cls: string) => h("i", { class: `sw ${cls}` });
    this.#el.legend.replaceChildren(
      h(
        "div",
        { class: "legend-box" },
        h("span", { title: "A candidate no placed label blocks; the darker, the cheaper" }, sw("free"), "free (darker: cheaper)"),
        h("span", {}, sw("chosen"), "chosen"),
        h("span", { title: "A candidate that conflicts with a placed label" }, sw("dead"), "ruled out"),
        h("span", { title: "A candidate that breaks a hard rule by itself (covers a mark, leaves the label area)" }, sw("infeasible"), "breaks a hard rule"),
        h("span", { title: "A label that changed in this step" }, sw("changed"), "changed"),
      ),
    );
  }

  // --- tooltip ---------------------------------------------------------------------------

  #showTip(e: PointerEvent, hit: Hover): void {
    const tip = this.#el.tip;
    let html = "";
    if (hit.cand !== null) html = this.#candHtml(hit.cand);
    else if (hit.item !== null) html = this.#itemHtml(hit.item);
    if (!html) return this.#hideTip();
    tip.innerHTML = html;
    tip.hidden = false;
    const wrap = tip.parentElement!.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let x = e.clientX - wrap.left + 14;
    let y = e.clientY - wrap.top + 14;
    if (x + tw > wrap.width - 6) x = Math.max(6, e.clientX - wrap.left - tw - 14);
    if (y + th > wrap.height - 6) y = Math.max(6, e.clientY - wrap.top - th - 14);
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  }

  #hideTip(): void {
    this.#el.tip.hidden = true;
  }

  #candHtml(c: number): string {
    const ex = this.#ex!;
    const t = ex.trace.candidates[c]!;
    const it = ex.trace.items[t.item]!;
    let status: string;
    if (t.fate === "pruned") status = "dropped: far more expensive than the item's best";
    else if (t.fate === "k_distant") status = "dropped: not among the cheapest distant candidates";
    else if (t.fate === "blocked") status = "dropped: a placed label blocks it";
    else if (t.feasible === null) status = "not evaluated: the solver never needed its cost";
    else if (!t.feasible) status = `breaks a hard rule: ${esc(blockedText(t.blocked))}`;
    else if (ex.killedAt[c]! <= this.#step && ex.groupAt(this.#step).id === "greedy") status = `ruled out by the label of <b>${esc(ex.trace.items[ex.killedBy[c]!]!.text)}</b>`;
    else status = "usable";
    const placed = ex.placementAt(this.#step)[t.item] === c;
    let rows = "";
    if (t.breakdown) {
      const terms = t.breakdown.filter(([, v]) => Math.abs(v) > 1e-9).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
      const max = Math.max(1e-9, ...terms.map(([, v]) => Math.abs(v)));
      rows = terms
        .map(([n, v]) => `<tr><td>${esc(termName(n))}</td><td class="num">${fmtCost(v)}</td><td class="bar"><i style="width:${Math.round((Math.abs(v) / max) * 100)}%"></i></td></tr>`)
        .join("");
      if (!terms.length) rows = `<tr><td colspan="3" class="muted">every term 0</td></tr>`;
    }
    const text = candText(ex.trace, c);
    return (
      `<div class="tip-h"><b>${esc(it.text)}</b> · ${esc(where(ex, c))}</div>` +
      `<div class="tip-s">${esc(t.model)}${t.level > 0 ? ` · ladder step ${t.level}` : ""}${text !== it.text ? ` · “${esc(text)}”` : ""}${placed ? " · <b>its label now</b>" : ""}</div>` +
      `<div class="tip-s">${status}</div>` +
      (t.cost !== null ? `<table class="terms"><tr><th>static cost</th><th class="num">${fmtCost(t.cost)}</th><th></th></tr>${rows}</table>` : "")
    );
  }

  #itemHtml(i: number): string {
    const ex = this.#ex!;
    const it = ex.trace.items[i]!;
    const c = ex.placementAt(this.#step)[i]!;
    const band = ex.bands > 1 ? `band ${ex.bandOf[i]! + 1} of ${ex.bands} · ` : "";
    const now = c >= 0 ? `label ${esc(where(ex, c))}` : "no label (yet)";
    const reason = c < 0 && this.#step === ex.length - 1 && it.reason ? ` — ${esc(it.reason.replace(/_/g, " "))}` : "";
    return `<div class="tip-h"><b>${esc(it.text)}</b></div><div class="tip-s">${band}priority rank ${it.rank + 1}</div><div class="tip-s">${now}${reason}</div><div class="tip-s muted">click to follow it${this.#scene.draggable(it.id) ? " · drag the mark to move it" : ""}</div>`;
  }

  // --- the panel -------------------------------------------------------------------------

  #render(): void {
    this.#renderStage();
    this.#renderPanel();
    this.#timeline.setStep(this.#step);
    this.#renderFooter();
  }

  #renderFooter(): void {
    const ex = this.#ex;
    if (!ex || !this.#el.counter) return;
    this.#el.counter.textContent = `step ${(this.#step + 1).toLocaleString("en-US")} of ${ex.length.toLocaleString("en-US")}`;
    const st = ex.result.stats;
    document.getElementById("verdict")!.innerHTML =
      `${st.placed} of ${st.total} labeled · ${ex.trace.candidates.length.toLocaleString("en-US")} candidates · ${ex.moves.length.toLocaleString("en-US")} moves · solved in ${Math.round(this.#ms)} ms with the trace` +
      (this.#wasmCheck ? `<br>${this.#wasmCheck}` : "");
  }

  #renderPanel(): void {
    const ex = this.#ex!;
    const k = this.#step;
    const g = ex.groupAt(k);
    const e = ex.event(k);
    const n = narrate(ex, k);
    this.#el.phase.innerHTML = ex.groups
      .map((x) => `<span class="${x === g ? "on" : k >= x.end ? "done" : ""}">${esc(x.title)}</span>`)
      .join('<i aria-hidden="true">›</i>');
    this.#el.title.innerHTML = n.title;
    this.#el.story.innerHTML = n.html;
    this.#el.details.replaceChildren(...this.#details(e, k));
    this.#renderItem();
  }

  #candRow(c: number, cells: (string | number)[], chosen: boolean): HTMLTableRowElement {
    const row = h("tr", { class: chosen ? "chosen" : "" });
    row.innerHTML = cells.map((x, i) => `<td class="${i > 0 ? "num" : ""}">${typeof x === "number" ? fmtCost(x) : x}</td>`).join("");
    row.addEventListener("pointerenter", () => {
      this.#hover = { cand: c, item: null };
      this.#renderStage();
    });
    row.addEventListener("pointerleave", () => {
      this.#hover = { cand: null, item: null };
      this.#renderStage();
    });
    return row;
  }

  #details(e: TraceEvent, k: number): Node[] {
    const ex = this.#ex!;
    const tr = ex.trace;
    const out: Node[] = [];
    switch (e.type) {
      case "phase":
        if (e.phase === "prepare" && ex.bands > 1) {
          const sizes = new Array<number>(ex.bands).fill(0);
          for (const b of ex.bandOf) sizes[b]! += 1;
          out.push(
            h(
              "div",
              { class: "bands" },
              ...sizes.map((s, b) => h("span", {}, h("i", { style: { background: bandColorOf(ex, b) } }), `band ${b + 1}: ${s} items`)),
            ),
          );
        }
        if (e.phase === "candidates") out.push(this.#candidateTotals());
        break;
      case "generate": {
        const usable = e.cands.filter((c) => tr.candidates[c]!.fate === "kept" && tr.candidates[c]!.feasible === true);
        usable.sort((a, b) => (tr.candidates[a]!.cost ?? 0) - (tr.candidates[b]!.cost ?? 0));
        if (usable.length) {
          const t = h("table", { class: "cands" }, h("tr", {}, h("th", {}, "cheapest usable"), h("th", { class: "num" }, "cost")));
          for (const c of usable.slice(0, 8)) t.appendChild(this.#candRow(c, [esc(where(ex, c)), tr.candidates[c]!.cost ?? 0], false));
          out.push(t);
        }
        out.push(h("p", { class: "hint" }, "Hover a candidate in the drawing for the terms of its cost."));
        break;
      }
      case "pick": {
        if (e.pass !== "level0") break;
        const killers = new Map<number, number>();
        for (const c of ex.liveAt(e.item, 0)) if (!ex.aliveAt(c, k)) killers.set(ex.killedBy[c]!, (killers.get(ex.killedBy[c]!) ?? 0) + 1);
        if (killers.size) {
          const t = h("table", { class: "cands" }, h("tr", {}, h("th", {}, "ruled out by the label of"), h("th", { class: "num" }, "candidates")));
          for (const [j, m] of [...killers].sort((a, b) => b[1] - a[1])) {
            const row = h("tr");
            row.innerHTML = `<td>${esc(tr.items[j]!.text)}</td><td class="num">${m}</td>`;
            t.appendChild(row);
          }
          out.push(t);
        }
        break;
      }
      case "score": {
        if (!e.options.length) break;
        const la = e.options.some((o) => o.lookahead !== null);
        // the contenders (with lookahead) first, as the solver compares only those
        const rows = e.options
          .map((o) => ({ o, total: o.cost + o.dynamic + (o.lookahead ?? 0), out: la && o.lookahead === null }))
          .sort((a, b) => Number(a.out) - Number(b.out) || a.total - b.total)
          .slice(0, 12);
        const t = h(
          "table",
          { class: "cands" },
          h("tr", {}, h("th", {}, "candidate"), h("th", { class: "num" }, "static"), h("th", { class: "num" }, "labels"), la ? h("th", { class: "num" }, "look­ahead") : null, h("th", { class: "num" }, "total")),
        );
        for (const { o, total, out: away } of rows) {
          const cells: (string | number)[] = [esc(where(ex, o.cand)), o.cost, o.dynamic];
          if (la) cells.push(o.lookahead === null ? "–" : o.lookahead);
          cells.push(away ? "–" : total);
          const row = this.#candRow(o.cand, cells, o.cand === e.chosen);
          if (away) row.classList.add("out");
          t.appendChild(row);
        }
        out.push(t);
        if (e.options.length > rows.length) out.push(h("p", { class: "hint" }, `and ${e.options.length - rows.length} more`));
        if (la && rows.some((r) => r.out)) out.push(h("p", { class: "hint" }, "Grey rows got no lookahead: they are beyond the eight cheapest, or cost more by themselves than the best total, so they cannot win."));
        break;
      }
      case "place": {
        const per = new Map<number, number>();
        for (const c of e.killed) per.set(tr.candidates[c]!.item, (per.get(tr.candidates[c]!.item) ?? 0) + 1);
        if (per.size) {
          const t = h("table", { class: "cands" }, h("tr", {}, h("th", {}, "waiting item"), h("th", { class: "num" }, "loses"), h("th", { class: "num" }, "free left")));
          for (const [j, m] of [...per].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
            const row = h("tr");
            row.innerHTML = `<td>${esc(tr.items[j]!.text)}</td><td class="num">${m}</td><td class="num">${ex.liveAt(j, k + 1).length}</td>`;
            t.appendChild(row);
          }
          out.push(t);
        }
        break;
      }
      case "anneal":
      case "move":
        out.push(this.#searchPanel(k));
        break;
      case "verify": {
        const st = ex.result.stats;
        const kv = h("dl", { class: "kv" });
        const add = (a: string, b: string) => kv.append(h("dt", {}, a), h("dd", {}, b));
        add("labeled", `${st.placed} of ${st.total}`);
        add("hard violations", String(st.hard_violations));
        add("crossing leaders", String(st.leader_crossings));
        add("priority inversions", String(st.priority_inversions ?? 0));
        add("total cost", fmtCost(st.total_cost));
        add("strategy", `${st.strategy_used} (${(st.iterations ?? 0).toLocaleString("en-US")} moves)`);
        const deg = st.degraded as Record<string, number> | undefined;
        if (deg && Object.keys(deg).length) add("degraded", Object.entries(deg).map(([a, b]) => `${b} ${a}`).join(", "));
        out.push(kv);
        const omitted = ex.result.placements.filter((p) => !p.placed);
        if (omitted.length) {
          out.push(h("p", { class: "hint" }, `Without a label: ${omitted.map((p) => `${tr.items.find((x) => x.id === p.id)?.text ?? p.id} (${String(p.reason ?? "").replace(/_/g, " ")})`).join(", ")}.`));
        }
        break;
      }
      default:
        break;
    }
    return out;
  }

  #candidateTotals(): HTMLElement {
    const ex = this.#ex!;
    const g = ex.group("candidates");
    const counts = new Map<string, [number, number, number]>();
    for (let k = g ? g.start : 0; g && k < g.end; k++) {
      const e = ex.event(k);
      if (e.type !== "generate") continue;
      for (const c of e.cands) {
        const t = ex.trace.candidates[c]!;
        const v = counts.get(t.model) ?? [0, 0, 0];
        if (t.fate !== "kept") v[2] += 1;
        else if (t.feasible) v[0] += 1;
        else v[1] += 1;
        counts.set(t.model, v);
      }
    }
    const t = h("table", { class: "cands" }, h("tr", {}, h("th", {}, "model"), h("th", { class: "num" }, "usable"), h("th", { class: "num" }, "hard rule"), h("th", { class: "num" }, "dropped")));
    for (const [m, v] of counts) {
      const row = h("tr");
      row.innerHTML = `<td>${esc(m)}</td><td class="num">${v[0]}</td><td class="num">${v[1]}</td><td class="num">${v[2]}</td>`;
      t.appendChild(row);
    }
    return t;
  }

  /** The local search: cost and temperature over the moves, the move counts so far, jumps. */
  #searchPanel(k: number): HTMLElement {
    const ex = this.#ex!;
    const wrap = h("div", { class: "search" });
    const cv = h("canvas", { class: "chart", title: "Click to jump to a move" }) as HTMLCanvasElement;
    wrap.appendChild(cv);
    const counts: Record<string, number> = {};
    let j = 0;
    for (; j < ex.moves.length && ex.moves[j]! <= k; j++) {
      const m = ex.event(ex.moves[j]!) as Move;
      counts[m.outcome] = (counts[m.outcome] ?? 0) + 1;
    }
    const lbl: [string, string][] = [
      ["improved", "improved"],
      ["accepted", "worse, accepted"],
      ["rejected", "worse, rejected"],
      ["blocked", "blocked"],
      ["no_room", "swap, no room"],
      ["inserted", "inserted"],
      ["not_inserted", "not inserted"],
      ["idle", "no move"],
    ];
    const list = h("div", { class: "counts" });
    for (const [key, text] of lbl) if (counts[key]) list.appendChild(h("span", { class: key }, h("b", {}, counts[key]!.toLocaleString("en-US")), ` ${text}`));
    wrap.appendChild(list);
    const jump = (dir: 1 | -1, test: (m: Move) => boolean) => {
      for (let t = k + dir; t >= 0 && t < ex.length; t += dir) {
        const e = ex.event(t);
        if (e.type === "move" && test(e)) return this.go(t);
        if (ex.groupAt(t).id !== "search") break;
      }
    };
    const changed = (m: Move) => m.changes.length > 0;
    wrap.appendChild(
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn", onclick: () => (this.#pause(), jump(-1, changed)) }, "◀ previous change"),
        h("button", { type: "button", class: "btn", onclick: () => (this.#pause(), jump(1, changed)) }, "next change ▶"),
        h("button", { type: "button", class: "btn", onclick: () => (this.#pause(), jump(1, (m) => m.outcome === "improved" && (m.delta ?? 0) < -1e-9)) }, "next improvement"),
      ),
    );
    requestAnimationFrame(() => drawSearchChart(cv, ex, k, (t) => (this.#pause(), this.go(t))));
    return wrap;
  }

  #renderItem(): void {
    const ex = this.#ex!;
    const box = this.#el.item;
    const i = this.#pinned;
    if (i === null) {
      box.replaceChildren(h("p", { class: "hint" }, "Click a mark or a label to follow one item through the solve; drag a mark to move it."));
      return;
    }
    const it = ex.trace.items[i]!;
    const c = ex.placementAt(this.#step)[i]!;
    const head = h(
      "div",
      { class: "item-h" },
      h("i", { class: "dot", style: { background: bandColor(ex, i) } }),
      h("b", {}, it.text),
      h("button", { type: "button", class: "linkish", onclick: () => ((this.#pinned = null), this.#render()) }, "close"),
    );
    const kv = h("dl", { class: "kv" });
    const add = (a: string, b: string) => kv.append(h("dt", {}, a), h("dd", {}, b));
    add("priority", `${ex.bands > 1 ? `band ${ex.bandOf[i]! + 1} · ` : ""}rank ${it.rank + 1} of ${ex.trace.items.length}`);
    add("candidates", `${ex.candsOf[i]!.length} (models: ${it.models.join(", ")})`);
    add("label now", c >= 0 ? `${where(ex, c)}${ex.trace.candidates[c]!.cost !== null ? ` · cost ${fmtCost(ex.trace.candidates[c]!.cost)}` : ""}` : "none");
    if (c < 0 && it.reason && this.#step === ex.length - 1) add("why", it.reason.replace(/_/g, " "));
    const story = h("ol", { class: "story-list" });
    let moves = 0;
    let shown = 0;
    for (const t of ex.itemEvents[i]!) {
      const e = ex.event(t);
      if (e.type === "move") {
        moves++;
        if (e.changes.every(([j]) => j !== i)) continue;
      }
      const label = storyLabel(ex, e, i, t);
      if (!label) continue;
      if (shown++ >= 60) continue;
      const li = h("li", { class: t === this.#step ? "now" : t < this.#step ? "past" : "" }, h("button", { type: "button", class: "linkish", onclick: () => (this.#pause(), this.go(t)) }, label));
      story.appendChild(li);
    }
    box.replaceChildren(head, kv, h("h3", {}, "Its steps"), story, moves ? h("p", { class: "hint" }, `${moves} local-search moves drew it; the list shows those that changed its label.`) : "");
  }

  // --- options ---------------------------------------------------------------------------

  #buildSceneOptions(): void {
    const s = this.#scene;
    const body = this.#el.scene;
    const ctls = s.controls.map((c) => this.#control(c, () => s.params[c.key]!, (v) => {
      s.params[c.key] = v;
      if (c.key === "count" || c.key === "seed" || c.key === "spread") s.reset();
      void this.solve();
    }));
    body.replaceChildren(
      ...ctls,
      h("div", { class: "row" }, h("button", { type: "button", class: "btn", onclick: () => (s.reset(), void this.solve()) }, "Reset positions")),
    );
  }

  #control(c: SceneControl, get: () => number | boolean, set: (v: number | boolean) => void): HTMLElement {
    if (c.kind === "toggle") {
      const input = h("input", { type: "checkbox", checked: Boolean(get()), onchange: (e: Event) => set((e.target as HTMLInputElement).checked) });
      return h("label", { class: "toggle ctl-row" }, h("span", {}, c.label, c.hint ? h("span", { class: "hint" }, c.hint) : null), input);
    }
    const val = h("span", { class: "val" }, String(get()));
    const input = h("input", {
      type: "range",
      min: String(c.min),
      max: String(c.max),
      step: String(c.step ?? 1),
      value: String(get()),
      oninput: (e: Event) => {
        const v = Number((e.target as HTMLInputElement).value);
        val.textContent = String(v);
        set(v);
      },
    });
    return h("div", { class: "ctl" }, h("div", { class: "head" }, h("span", { class: "name" }, c.label), val), input, c.hint ? h("span", { class: "hint" }, c.hint) : null);
  }

  #buildAlgoOptions(): void {
    const a = this.#algo;
    const body = this.#el.algo;
    const redo = () => void this.solve();
    const seg = (label: string, key: string, options: [string, string, string][], get: () => string, set: (v: string) => void) => {
      const wrap = h("div", { class: "seg" });
      const paint = () => wrap.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.v === get())));
      for (const [v, text, title] of options) {
        const b = h("button", { type: "button", title, onclick: () => (set(v), paint(), redo()) }, text);
        b.dataset.v = v;
        wrap.appendChild(b);
      }
      paint();
      return h("div", { class: "ctl" }, h("div", { class: "head" }, h("span", { class: "name" }, label), h("span", { class: "key" }, key)), wrap);
    };
    const sceneModels = ((this.#scene.problem().placement as { models?: string[] } | undefined)?.models ?? ["adjacent", "slider", "distant"]) as string[];
    const models = h(
      "div",
      { class: "checks" },
      ...MODELS.map((m) =>
        h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: a.models ? a.models[m] : sceneModels.includes(m),
            onchange: (e: Event) => {
              const cur = a.models ?? { adjacent: sceneModels.includes("adjacent"), slider: sceneModels.includes("slider"), distant: sceneModels.includes("distant") };
              cur[m] = (e.target as HTMLInputElement).checked;
              a.models = cur;
              redo();
            },
          }),
          m,
        ),
      ),
    );
    const ladder = h(
      "div",
      { class: "checks" },
      ...LADDER.map((s) =>
        h(
          "label",
          {},
          h("input", {
            type: "checkbox",
            checked: a.ladder[s],
            onchange: (e: Event) => {
              a.ladder[s] = (e.target as HTMLInputElement).checked;
              redo();
            },
          }),
          s,
        ),
      ),
    );
    const range = (label: string, key: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => String(v)) => {
      const val = h("span", { class: "val" }, fmt(get()));
      const input = h("input", {
        type: "range",
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(get()),
        oninput: (e: Event) => {
          const v = Number((e.target as HTMLInputElement).value);
          val.textContent = fmt(v);
          set(v);
          redo();
        },
      });
      return h("div", { class: "ctl" }, h("div", { class: "head" }, h("span", { class: "name" }, label), h("span", { class: "key" }, key), val), input);
    };
    body.replaceChildren(
      seg(
        "Strategy",
        "solver.strategy",
        [
          ["greedy", "greedy", "The greedy pass and the ladder only"],
          ["auto", "local", "Greedy, then local search (the default)"],
          ["exact", "exact", "Local search, then branch and bound"],
        ],
        () => (a.strategy === "local" ? "auto" : a.strategy),
        (v) => (a.strategy = v as Algo["strategy"]),
      ),
      range("Local-search moves", "solver.max_iterations", 0, DEFAULT_MOVES, 100, () => a.moves, (v) => (a.moves = v), (v) => v.toLocaleString("en-US")),
      range("Seed", "solver.seed", 0, 20, 1, () => a.seed, (v) => (a.seed = v)),
      h("div", { class: "ctl" }, h("div", { class: "head" }, h("span", { class: "name" }, "Candidate models"), h("span", { class: "key" }, "placement.models")), models),
      h(
        "label",
        { class: "toggle ctl-row" },
        h("span", {}, "Lookahead", h("span", { class: "hint" }, "weights.lookahead, weights.starve: count what a choice takes from waiting items")),
        h("input", { type: "checkbox", checked: a.lookahead, onchange: (e: Event) => ((a.lookahead = (e.target as HTMLInputElement).checked), redo()) }),
      ),
      h("div", { class: "ctl" }, h("div", { class: "head" }, h("span", { class: "name" }, "Degradation ladder"), h("span", { class: "key" }, "degrade")), ladder),
      range("Font size", "defaults.font.size", 8, 20, 1, () => a.fontSize, (v) => (a.fontSize = v), (v) => `${v} px`),
      h(
        "div",
        { class: "row" },
        h("button", { type: "button", class: "btn", onclick: () => ((this.#algo = defaultAlgo()), this.#buildAlgoOptions(), redo()) }, "Reset options"),
        h("button", { type: "button", class: "btn", onclick: () => void copyText(JSON.stringify(this.#problem, null, 2), this.#el.json) }, "Copy problem JSON"),
      ),
    );
  }
}

function nearMark(ex: Explained, i: number, x: number, y: number, tol: number): boolean {
  const a = ex.trace.items[i]!.anchor;
  return Math.hypot(a[0] - x, a[1] - y) <= tol && !ex.trace.items[i]!.area;
}

function bandColorOf(ex: Explained, b: number): string {
  const i = ex.bandOf.indexOf(b);
  return i >= 0 ? bandColor(ex, i) : BAND_COLORS[0]!;
}

function blockedText(b: string | null): string {
  switch (b) {
    case "canvas_edge":
      return "outside the label area";
    case "items":
      return "covers a mark";
    case null:
      return "a hard rule";
    default:
      return `covers ${b}`;
  }
}

/** A line of an item's story (null: not worth a line). */
function storyLabel(ex: Explained, e: TraceEvent, i: number, k: number): string | null {
  const c = (id: number) => where(ex, id);
  switch (e.type) {
    case "generate":
      return `${e.cands.length} candidates${e.level > 0 ? ` (ladder step ${e.level})` : ex.groupAt(k).id === "greedy" ? " (on demand)" : ""}`;
    case "band":
      return null;
    case "pick":
      return e.pass === "ladder" ? "back for the ladder" : `taken next (${e.live} free)`;
    case "score":
      return e.chosen === null ? "nothing free" : `scored ${e.options.length} free`;
    case "place":
      return e.item === i ? `placed ${c(e.cand)}` : null;
    case "defer":
      return "deferred";
    case "ladder":
      return `ladder: ${e.step}${e.chosen !== null ? " ✓" : ""}`;
    case "evict":
      return e.item === i ? "evicts less important labels" : "evicted";
    case "omit":
      return "no label";
    case "move": {
      const ch = e.changes.find(([j]) => j === i);
      if (!ch) return null;
      return `move ${e.it + 1}: ${ch[1] >= 0 ? c(ch[1]) : "label removed"}`;
    }
    case "pass": {
      const ch = e.changes.find(([j]) => j === i);
      return `${e.what}${ch ? `: ${ch[1] >= 0 ? c(ch[1]) : "label removed"}` : ""}`;
    }
    default:
      return null;
  }
}

/** The search chart: total cost (and the best so far) over the moves, the temperature, the current move. */
function drawSearchChart(cv: HTMLCanvasElement, ex: Explained, k: number, seek: (k: number) => void): void {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth;
  const hh = cv.clientHeight;
  if (!w || !hh) return;
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(hh * dpr);
  const ctx = cv.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const css = getComputedStyle(cv);
  const muted = css.getPropertyValue("--muted").trim() || "#5d6676";
  const accent = css.getPropertyValue("--accent").trim() || "#3949ab";
  const warn = css.getPropertyValue("--warn").trim() || "#b45309";
  const s = ex.searchSeries();
  const m = s.cost.length;
  if (m < 2) return;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of s.cost) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  const pad = (hi - lo) * 0.08 || 1;
  lo -= pad;
  hi += pad;
  const L = 34;
  const R = 6;
  const T = 8;
  const B = 16;
  const x = (j: number) => L + (j / (m - 1)) * (w - L - R);
  const y = (v: number) => T + (1 - (v - lo) / (hi - lo)) * (hh - T - B);
  ctx.font = "10px system-ui, sans-serif";
  ctx.fillStyle = muted;
  ctx.textAlign = "right";
  ctx.fillText(hi.toFixed(1), L - 4, T + 8);
  ctx.fillText(lo.toFixed(1), L - 4, hh - B);
  ctx.textAlign = "left";
  ctx.fillText("cost", L + 2, T + 8);
  ctx.textAlign = "right";
  ctx.fillText(`${m.toLocaleString("en-US")} moves`, w - R, hh - 3);
  ctx.textAlign = "left";
  ctx.fillStyle = warn;
  ctx.fillText("temperature", L + 30, T + 8);
  // temperature, log scale, from the top
  const t0 = s.temp[0]!;
  const tl = (t: number) => T + (Math.log(t0 / Math.max(t, 1e-12)) / Math.log(1000)) * (hh - T - B);
  const stride = Math.max(1, Math.floor(m / (w * 2)));
  const line = (f: (j: number) => number, color: string, lw: number, dash: number[] = []) => {
    ctx.beginPath();
    for (let j = 0; j < m; j += stride) (j ? ctx.lineTo : ctx.moveTo).call(ctx, x(j), f(j));
    ctx.strokeStyle = color;
    ctx.lineWidth = lw;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  line((j) => tl(s.temp[j]!), warn, 1, [3, 3]);
  line((j) => y(s.cost[j]!), muted, 1);
  line((j) => y(s.best[j]!), accent, 1.6);
  // current move
  let j = 0;
  while (j < m && ex.moves[j]! < k) j++;
  if (j < m) {
    ctx.strokeStyle = "#1b2130";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x(j) + 0.5, T);
    ctx.lineTo(x(j) + 0.5, hh - B);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x(j), y(s.cost[j]!), 3, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }
  cv.onclick = (e) => {
    const f = Math.max(0, Math.min(1, (e.offsetX - L) / (w - L - R)));
    seek(ex.moves[Math.round(f * (m - 1))]!);
  };
}

const SVG = {
  play: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M4 2.5v11l9-5.5z"/></svg>',
  pause: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z"/></svg>',
  prev: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11 3v10L4 8z"/></svg>',
  next: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M5 3v10l7-5z"/></svg>',
  prevMajor: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 3v10L2 8zM14 3v10L8 8z"/></svg>',
  nextMajor: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3v10l6-5zM8 3v10l6-5z"/></svg>',
  first: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 3h2v10H3zM13 3v10L6 8z"/></svg>',
  last: '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M11 3h2v10h-2zM3 3v10l7-5z"/></svg>',
};

