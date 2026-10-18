/**
 * The playground: one scene at a time, its items solved by the chosen engine in a worker,
 * the labels drawn with smooth transitions (LabelMotion) on a canvas.
 *
 * Solves: a *cold* solve (no warm start) after an option changed; *warm* solves while
 * things move (the previous result as `warm_start`, the short moving budget, at most
 * `maxRate` per second, only the newest problem counts); one *settle* solve when the
 * motion stops (warm start, the full budget, a lower stability weight, so that the labels
 * that a better place awaits move there). Results of a problem that is out of date are
 * dropped.
 */
import type { LabelProblem, LabelResult, RgbaPixels } from "@label-anything/core";
import { LabelMotion } from "@label-anything/extras";
import { DEFAULTS, PRESETS } from "../../core/src/generated/spec-data.js";
import { SECTIONS, type Control, type Section } from "./controls.js";
import { ENGINE_NAMES, Engines, type EngineId } from "./engines.js";
import { drawBoxes, drawCandidates, drawHighlight, drawLabels, drawNaive, drawObstacles, drawOmitted, labelAt, type Candidate, type LabelStyle, type Placement } from "./render.js";
import type { Anchors, PointerInfo, Scene, SceneHost } from "./scenes/scene.js";
import { CodeView } from "./ui/code.js";
import { h, icon } from "./ui/dom.js";
import { Inspector } from "./ui/inspector.js";
import { Panel, type PanelModel } from "./ui/panel.js";
import { deepEqual, fromBase64Url, getPath, isObject, merge, mergeAll, setPath, toBase64Url, type Obj } from "./util.js";

export interface View {
  warmStart: boolean;
  settle: boolean;
  transition: number;
  moveDelay: number;
  appearDelay: number;
  holdTime: number;
  collisions: boolean;
  fadeJumps: boolean;
  maxRate: number;
  budgetRest: number;
  budgetMoving: number;
  labelStyle: LabelStyle;
  showBoxes: boolean;
  showOmitted: boolean;
  showCandidates: boolean;
  showObstacles: boolean;
  compare: boolean;
  avoidHud: boolean;
  customJson: string;
  speed: number;
}

export const VIEW_DEFAULTS: View = {
  warmStart: true,
  settle: true,
  transition: 300,
  moveDelay: 500,
  appearDelay: 250,
  holdTime: 500,
  collisions: true,
  fadeJumps: true,
  maxRate: 30,
  budgetRest: 100,
  budgetMoving: 10,
  labelStyle: "box",
  showBoxes: false,
  showOmitted: false,
  showCandidates: false,
  showObstacles: false,
  compare: false,
  avoidHud: true,
  customJson: "",
  speed: 1,
};

type SolveKind = "cold" | "warm" | "settle";

/** One solve's record for the statistics. */
export interface Solve {
  kind: SolveKind;
  engine: EngineId;
  runtime: number;
  roundTrip: number;
  placed: number;
  total: number;
  moved: number | undefined;
  at: number;
}

/** The engine defaults as a tree (DEFAULTS is a flat map of dotted keys). */
const DEFAULT_TREE: Obj = Object.entries(DEFAULTS).reduce<Obj>((acc, [k, v]) => setPath(acc, k, v), {});

/** Settings that change only the drawing (no solve). */
const DRAW_ONLY = new Set(["labelStyle", "showBoxes", "showOmitted", "showObstacles", "compare", "speed"]);
/** View settings of the label transitions. */
const MOTION = new Set(["transition", "moveDelay", "appearDelay", "holdTime", "collisions", "fadeJumps"]);

function motionOf(v: View): LabelMotion {
  return new LabelMotion({
    duration: v.transition,
    moveDelay: v.moveDelay,
    appearDelay: v.appearDelay,
    holdTime: v.holdTime,
    collisions: v.collisions,
    jump: v.fadeJumps ? 2 : Infinity,
  });
}

export class App {
  readonly scenes: Scene[];
  scene!: Scene;
  engineId: EngineId = "wasm";
  view: View = { ...VIEW_DEFAULTS };
  /** The user's problem options per scene. */
  #overrides = new Map<string, Obj>();
  #json = new Map<string, string>();
  #jsonObj: Obj | null = null;
  #jsonError: string | null = null;
  #engineError: string | null = null;

  result: LabelResult | undefined;
  problem: LabelProblem | undefined;
  /** Anchors the latest result was solved for. */
  resultAnchors: Anchors = new Map();
  history: Solve[] = [];
  hover: string | null = null;
  selected: string | null = null;

  #engines: Engines;
  #motion = motionOf(VIEW_DEFAULTS);
  #version = 0;
  #inFlight = false;
  #coldPending = true;
  #positionsDirty = false;
  #needsSettle = false;
  #lastStart = -1e9;
  #lastMoveAt = 0;
  #redraw = true;
  #dragging = false;
  #dividerDrag = false;
  #compareX = 0.5;
  #last = 0;
  #size = { w: 800, h: 600, dpr: 1 };
  #wasmFailed = false;
  #toastTimer = 0;
  #pointers = new Map<number, { x: number; y: number }>();
  #pinch: { d: number } | null = null;
  #down: { x: number; y: number; id: number } | null = null;

  #canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #panel: Panel;
  #inspector: Inspector;
  #code: CodeView;
  #tab = "options";
  #hashTimer = 0;
  #inspectTimer = 0;
  #titleTimer = 0;
  /** The overlay rectangles of the last problem, by element. */
  #hudCache = new Map<string, number[]>();
  /** A solve from the current labels at rest (the overlays changed). */
  #warmPending = false;
  #wasPlaying = false;

  constructor(scenes: Scene[], base: URL) {
    this.scenes = scenes;
    this.#engines = new Engines(base);
    this.#canvas = document.getElementById("stage") as HTMLCanvasElement;
    this.#ctx = this.#canvas.getContext("2d")!;
    this.#panel = new Panel(document.getElementById("panel-options")!, this.#panelModel());
    this.#inspector = new Inspector(document.getElementById("panel-inspect")!, this);
    this.#code = new CodeView(document.getElementById("panel-code")!, this);
  }

  /** The label transitions (for tests and measurements). */
  get motion(): LabelMotion {
    return this.#motion;
  }

  // --- start ----------------------------------------------------------------------

  async start(): Promise<void> {
    this.#bindChrome();
    this.#bindPointer();
    new ResizeObserver(() => this.#resize()).observe(document.getElementById("stage-wrap")!);
    this.#measure();
    const fromHash = this.#readHash();
    // load the WebAssembly engine in the background; fall back to TypeScript if it fails
    this.#engines.warmUp("wasm").catch((e) => this.#wasmUnavailable(e));
    this.#engines.warmUp("ts").catch(() => undefined);
    await this.selectScene(fromHash?.scene ?? this.scenes[0]!.id, fromHash ?? undefined);
    requestAnimationFrame((t) => this.#loop(t));
  }

  get host(): SceneHost {
    const app = this;
    return {
      get width() {
        return app.#size.w;
      },
      get height() {
        return app.#size.h;
      },
      asset: (path) => new URL(`data/${path}`, document.baseURI).href,
      invalidate: () => this.#invalidate(),
      moved: () => {
        this.#positionsDirty = true;
        this.#lastMoveAt = performance.now();
        this.#redraw = true;
      },
      redraw: () => (this.#redraw = true),
      toast: (text) => this.toast(text, "info"),
    };
  }

  async selectScene(id: string, state?: HashState): Promise<void> {
    const scene = this.scenes.find((s) => s.id === id) ?? this.scenes[0]!;
    if (this.scene) this.scene.playing = false;
    this.scene = scene;
    this.view = { ...VIEW_DEFAULTS, ...(scene.view as Partial<View>), ...(state?.view ?? {}) };
    if (state?.overrides) this.#overrides.set(scene.id, state.overrides);
    if (state?.json !== undefined) this.view.customJson = state.json;
    else this.view.customJson = this.#json.get(scene.id) ?? "";
    this.#parseJson();
    this.#motion = motionOf(this.view);
    this.result = undefined;
    this.problem = undefined;
    this.history = [];
    this.hover = this.selected = null;
    document.querySelectorAll<HTMLButtonElement>("#scenes button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.scene === scene.id)));
    this.#renderTitle();
    this.toast("Loading…", "info", 0);
    await scene.load(this.host);
    if (state?.params) for (const [k, v] of Object.entries(state.params)) scene.setParam(k, v);
    scene.resize(this.#size.w, this.#size.h);
    this.#hideToast();
    this.#canvas.className = scene.cursor ?? "";
    this.#renderPanel();
    this.#renderTransport();
    this.#renderCredits();
    this.#invalidate();
    if (scene.animated && state?.playing !== false) this.setPlaying(true);
  }

  // --- options ------------------------------------------------------------------------

  get overrides(): Obj {
    return this.#overrides.get(this.scene.id) ?? {};
  }

  /** The problem options in effect, without items: defaults ← preset ← scene ← user ← JSON. */
  effectiveOptions(): Obj {
    const sceneOpts = this.scene.options() as Obj;
    const top = mergeAll<Obj>(sceneOpts, this.overrides, this.#jsonObj ?? {});
    const preset = typeof top.preset === "string" ? top.preset : "auto";
    const presetOpts = (PRESETS[preset]?.options ?? {}) as Obj;
    return mergeAll<Obj>(DEFAULT_TREE, presetOpts, top);
  }

  /** The value in effect without the user's override of `key`. */
  #baseValue(key: string): unknown {
    const sceneOpts = this.scene.options() as Obj;
    const user = setPath(this.overrides, key, undefined);
    const top = mergeAll<Obj>(sceneOpts, user);
    const preset = typeof top.preset === "string" ? top.preset : "auto";
    return lookup(mergeAll<Obj>(DEFAULT_TREE, (PRESETS[preset]?.options ?? {}) as Obj, top), key);
  }

  #panelModel(): PanelModel {
    return {
      get: (key) => this.getValue(key),
      changed: (key) => {
        if (key.startsWith("view.")) {
          const k = key.slice(5) as keyof View;
          const base = { ...VIEW_DEFAULTS, ...(this.scene.view as Partial<View>) }[k];
          return k === "customJson" ? this.view.customJson.trim() !== "" : !deepEqual(this.view[k], base);
        }
        if (key.startsWith("param.")) return false;
        return getPath(this.overrides, key) !== undefined;
      },
      set: (key, value) => this.setValue(key, value),
      reset: (key) => this.resetValue(key),
      isProblemKey: (key) => !key.startsWith("view.") && !key.startsWith("param."),
      jsonStatus: () => {
        if (this.#jsonError) return { ok: false, text: this.#jsonError };
        if (this.#engineError) return { ok: false, text: this.#engineError };
        if (this.view.customJson.trim()) return { ok: true, text: "Merged into the problem." };
        return null;
      },
    };
  }

  getValue(key: string): unknown {
    if (key.startsWith("view.")) return this.view[key.slice(5) as keyof View];
    if (key.startsWith("param.")) return this.scene.params[key.slice(6)];
    if (key.startsWith("scene.")) {
      const c = this.scene.classes;
      if (key === "scene.hasPoints") return c.includes("points");
      if (key === "scene.hasLines") return c.includes("lines");
      if (key === "scene.hasInk") return c.includes("ink");
      return undefined;
    }
    return lookup(this.effectiveOptions(), key);
  }

  setValue(key: string, value: unknown): void {
    if (key.startsWith("view.")) {
      const k = key.slice(5) as keyof View;
      (this.view as unknown as Obj)[k] = value;
      if (MOTION.has(k)) this.#motion = motionOf(this.view);
      if (k === "customJson") {
        this.#json.set(this.scene.id, String(value));
        this.#parseJson();
      }
      if (k === "warmStart" && value === false) this.#needsSettle = false;
      if (DRAW_ONLY.has(k)) this.#redraw = true;
      else if (k === "showCandidates" || k === "customJson" || k.startsWith("budget")) this.#invalidate();
    } else if (key.startsWith("param.")) {
      this.scene.setParam(key.slice(6), value);
      this.#renderTransport();
      this.#invalidate();
    } else {
      const same = deepEqual(value, this.#baseValue(key));
      this.#overrides.set(this.scene.id, setPath(this.overrides, key, same ? undefined : value));
      this.#invalidate();
    }
    this.#panel.update();
    this.#saveHash();
  }

  resetValue(key: string): void {
    if (key.startsWith("view.")) {
      const k = key.slice(5) as keyof View;
      this.setValue(key, { ...VIEW_DEFAULTS, ...(this.scene.view as Partial<View>) }[k]);
      return;
    }
    this.#overrides.set(this.scene.id, setPath(this.overrides, key, undefined));
    this.#invalidate();
    this.#panel.update();
    this.#saveHash();
  }

  resetAll(): void {
    this.#overrides.delete(this.scene.id);
    this.#json.delete(this.scene.id);
    this.view = { ...VIEW_DEFAULTS, ...(this.scene.view as Partial<View>) };
    this.#parseJson();
    this.#motion = motionOf(this.view);
    this.#invalidate();
    this.#panel.update();
    this.#renderTransport();
    this.#saveHash();
  }

  #parseJson(): void {
    const text = this.view.customJson.trim();
    this.#jsonError = null;
    this.#jsonObj = null;
    if (!text) return;
    try {
      const v: unknown = JSON.parse(text);
      if (!isObject(v)) throw new Error("expected an object, e.g. { \"leaders\": { \"style\": \"curved\" } }");
      this.#jsonObj = v;
    } catch (e) {
      this.#jsonError = `Not valid JSON: ${(e as Error).message}`;
    }
  }

  // --- problems and solves ---------------------------------------------------------

  /** The problem for the current positions. */
  buildProblem(kind: SolveKind, moving: boolean): { problem: LabelProblem; raster?: RgbaPixels } {
    const s = this.scene;
    const top = mergeAll<Obj>({ canvas: { width: round2(this.#size.w), height: round2(this.#size.h) } }, s.options(), this.overrides);
    const p: Obj = { ...top, items: s.items() };
    let obstacles = s.obstacles() as Obj | undefined;
    const hud = this.view.avoidHud ? this.#hudRects() : [];
    if (hud.length) {
      // the controls drawn over the canvas are obstacles too: labels keep off them
      const vector = [...(((obstacles?.vector as unknown[]) ?? []) as Obj[]), { class: "overlay", rects: hud }];
      obstacles = { ...obstacles, vector };
      p.avoid = merge({ label: { overlay: "hard" }, leader: { overlay: 1 } }, p.avoid);
    }
    if (obstacles) p.obstacles = merge(obstacles, top.obstacles);
    const json = this.#jsonObj ?? {};
    if (getPath(this.overrides, "solver.time_budget_ms") === undefined && getPath(json, "solver.time_budget_ms") === undefined) {
      p.solver = { ...(p.solver as Obj | undefined), time_budget_ms: moving ? this.view.budgetMoving : this.view.budgetRest };
    }
    if (kind !== "cold" && this.view.warmStart && this.result) {
      p.warm_start = { placements: this.result.placements.map(warmPlacement) };
    }
    if (kind === "settle") {
      const stability = lookup(this.effectiveOptions(), "weights.stability");
      p.weights = { ...(p.weights as Obj | undefined), stability: round2((typeof stability === "number" ? stability : 1) * 0.3) };
    }
    if (this.view.showCandidates && !moving) p.output = { ...(p.output as Obj | undefined), candidates: true };
    const problem = merge(p, json) as unknown as LabelProblem;
    return { problem, raster: s.raster?.() };
  }

  #invalidate(): void {
    this.#version++;
    this.#coldPending = true;
    this.#redraw = true;
  }

  #schedule(now: number): void {
    if (this.#inFlight || !this.scene) return;
    const moving = this.scene.playing || this.#dragging;
    if (this.#coldPending) {
      this.#coldPending = false;
      this.#positionsDirty = false;
      this.#solve("cold", moving);
      return;
    }
    if (this.#warmPending) {
      this.#warmPending = false;
      this.#positionsDirty = false;
      this.#solve("warm", moving);
      return;
    }
    const gap = this.view.maxRate >= 60 ? 0 : 1000 / this.view.maxRate;
    if (this.#positionsDirty && now - this.#lastStart >= gap) {
      this.#positionsDirty = false;
      this.#solve("warm", true);
      return;
    }
    if (this.#needsSettle && !this.#positionsDirty && !moving && now - this.#lastMoveAt > 400) {
      this.#needsSettle = false;
      this.#solve("settle", false);
    }
  }

  #solve(kind: SolveKind, moving: boolean): void {
    let built: { problem: LabelProblem; raster?: RgbaPixels };
    try {
      built = this.buildProblem(kind, moving);
    } catch (e) {
      this.toast(`Could not build the problem: ${(e as Error).message}`, "error");
      return;
    }
    const version = this.#version;
    const anchors = new Map(this.scene.anchors());
    const snapshot = this.scene.snapshot?.();
    const engine = this.#wasmFailed ? "ts" : this.engineId;
    const sceneId = this.scene.id;
    this.#inFlight = true;
    this.#lastStart = performance.now();
    this.#busy(true);
    this.#engines.place(engine, built.problem, built.raster).then(
      ({ result, roundTrip }) => {
        this.#inFlight = false;
        this.#busy(false);
        if (sceneId !== this.scene.id) return;
        if (version !== this.#version && this.result) return; // options changed meanwhile
        this.#engineError = null;
        this.#hideToast();
        this.result = result;
        this.problem = built.problem;
        this.resultAnchors = anchors;
        this.scene.onResult?.(result, snapshot);
        this.#motion.target(result, anchors);
        const st = result.stats as unknown as Obj;
        const flicker = st.flicker as Obj | undefined;
        this.history.push({
          kind, engine, runtime: Number(st.runtime_ms ?? 0), roundTrip, placed: Number(st.placed ?? 0), total: Number(st.total ?? 0),
          moved: typeof flicker?.mean_displacement === "number" ? (flicker.mean_displacement as number) : undefined, at: performance.now(),
        });
        if (this.history.length > 240) this.history.splice(0, this.history.length - 240);
        if (kind === "warm" && this.view.settle && this.view.warmStart) this.#needsSettle = true;
        this.#redraw = true;
        this.#renderStats();
        this.#panel.update();
        this.#refreshTabs();
      },
      (err: unknown) => {
        this.#inFlight = false;
        this.#busy(false);
        if (sceneId !== this.scene.id) return;
        const errors = (err as { errors?: { pointer?: string; code: string; message: string }[] }).errors;
        const text = errors?.length
          ? errors.slice(0, 3).map((e) => `${e.pointer || "/"}: ${e.message}`).join("; ")
          : String((err as Error)?.message ?? err);
        if (engine === "wasm" && /WebAssembly module did not load/.test(text)) {
          this.#wasmUnavailable(err);
          this.#coldPending = true;
          return;
        }
        this.#engineError = `The engine rejected the problem: ${text}`;
        this.toast(this.#engineError, "error");
        this.#panel.update();
      },
    );
  }

  /** Solve the current problem with both engines and compare the placements. */
  async compareEngines(): Promise<{ wasm: Solved2; ts: Solved2 } | null> {
    if (!this.scene) return null;
    const built = this.buildProblem("cold", false);
    const run = async (id: EngineId): Promise<Solved2> => {
      const { result, roundTrip } = await this.#engines.place(id, built.problem, built.raster);
      return { result, roundTrip };
    };
    const wasm = await run("wasm");
    const ts = await run("ts");
    return { wasm, ts };
  }

  #wasmUnavailable(e: unknown): void {
    if (this.#wasmFailed) return;
    this.#wasmFailed = true;
    const sel = document.getElementById("engine") as HTMLSelectElement;
    const opt = sel.querySelector<HTMLOptionElement>('option[value="wasm"]');
    if (opt) {
      opt.disabled = true;
      opt.textContent = "WebAssembly (unavailable)";
    }
    sel.value = "ts";
    this.engineId = "ts";
    console.warn("WebAssembly engine unavailable:", e);
    this.toast("The WebAssembly engine could not be loaded; solving with the TypeScript engine.", "info");
  }

  // --- the frame loop --------------------------------------------------------------

  #loop(now: number): void {
    const dt = Math.min(50, Math.max(0, now - this.#last));
    this.#last = now;
    if (this.scene) {
      if (this.scene.playing && this.scene.step(dt * this.view.speed)) {
        this.#positionsDirty = true;
        this.#lastMoveAt = now;
        this.#redraw = true;
      }
      if (this.scene.playing !== this.#wasPlaying) {
        // the scene started or stopped by itself (a layout that came to rest, a drag)
        this.#wasPlaying = this.scene.playing;
        if (!this.scene.playing && this.view.settle && this.view.warmStart) this.#needsSettle = true;
        this.#renderTransport();
      }
      this.#schedule(now);
      if (this.#redraw || this.#motion.moving) {
        this.#redraw = false;
        this.#render(now);
      }
    }
    requestAnimationFrame((t) => this.#loop(t));
  }

  #render(now: number): void {
    const ctx = this.#ctx;
    const { w, h, dpr } = this.#size;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = this.scene;
    const placed = new Set((this.result?.placements ?? []).filter((p) => p.placed).map((p) => p.id));
    const state = { hover: this.hover, selected: this.selected, placed };
    s.draw(ctx, "background", state);
    if (this.view.showObstacles) drawObstacles(ctx, this.problem?.obstacles as { vector?: unknown[] } | undefined);
    s.draw(ctx, "marks", state);
    const anchors = s.anchors();
    const frame = this.#motion.frame(anchors, now);
    const focus = this.selected ?? this.hover;
    const blockers = new Set(this.#blockers(focus));
    if (this.view.compare) {
      const x = this.#compareX * w;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, x, h);
      ctx.clip();
      drawNaive(ctx, this.#naiveItems(), this.#fontSize());
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, 0, w - x, h);
      ctx.clip();
      drawLabels(ctx, frame.result, this.view.labelStyle, frame.opacity, frame.leaderOpacity);
      ctx.restore();
      drawDivider(ctx, x, h);
    } else {
      drawLabels(ctx, frame.result, this.view.labelStyle, frame.opacity, frame.leaderOpacity);
    }
    if (this.view.showBoxes) drawBoxes(ctx, frame.result);
    if (this.view.showOmitted && this.result) drawOmitted(ctx, this.result, anchors);
    if (this.view.showCandidates && this.selected && this.result?.candidates) {
      const cands = (this.result.candidates as Candidate[]).filter((c) => c.id === this.selected);
      drawCandidates(ctx, cands, frame.result.placements.find((p) => p.id === this.selected));
    }
    const byId = new Map(frame.result.placements.map((p) => [p.id, p]));
    for (const id of blockers) drawHighlight(ctx, byId.get(id), "#c62828", 2);
    if (this.hover && this.hover !== this.selected) drawHighlight(ctx, byId.get(this.hover), "rgba(57, 73, 171, 0.55)", 1.5);
    if (this.selected) drawHighlight(ctx, byId.get(this.selected));
  }

  /** The placed labels in the way of an omitted item (`blocked_by`). */
  #blockers(id: string | null): string[] {
    if (!id || !this.result) return [];
    const p = this.result.placements.find((q) => q.id === id);
    return !p || p.placed ? [] : ((p as { blocked_by?: string[] }).blocked_by ?? []);
  }

  #fontSize(): number {
    const v = this.getValue("defaults.font.size");
    return typeof v === "number" ? v : 12;
  }

  #naiveItems(): { id: string; text: string; x: number; y: number; r: number }[] {
    const out: { id: string; text: string; x: number; y: number; r: number }[] = [];
    const anchors = this.scene.anchors();
    for (const it of this.scene.items()) {
      const id = it.id ?? "";
      const a = anchors.get(id);
      const lab = it.label as { type: string; text?: string };
      if (!a || lab.type !== "text" || !lab.text) continue;
      const anchor = it.anchor as { type: string; mark?: { shape?: string; r?: number; w?: number } };
      const r = anchor.type === "point" ? anchor.mark?.r ?? (anchor.mark?.w ?? 4) / 2 : 2;
      out.push({ id, text: lab.text, x: a[0], y: a[1], r });
    }
    return out;
  }

  // --- pointer -------------------------------------------------------------------------

  #bindPointer(): void {
    const c = this.#canvas;
    const info = (e: PointerEvent): PointerInfo => {
      const r = c.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top, touch: e.pointerType === "touch", shift: e.shiftKey };
    };
    c.addEventListener("pointerdown", (e) => {
      const p = info(e);
      this.#fadeTitle();
      this.#pointers.set(e.pointerId, { x: p.x, y: p.y });
      c.setPointerCapture(e.pointerId);
      if (this.#pointers.size === 2 && this.scene.zoom) {
        const [a, b] = [...this.#pointers.values()];
        this.#pinch = { d: Math.hypot(a!.x - b!.x, a!.y - b!.y) };
        return;
      }
      this.#down = { x: p.x, y: p.y, id: e.pointerId };
      if (this.view.compare && Math.abs(p.x - this.#compareX * this.#size.w) < (p.touch ? 18 : 8)) {
        this.#dividerDrag = true;
        return;
      }
      if (this.scene.pointerDown?.(p)) {
        this.#dragging = true;
        c.classList.add("grabbing");
      }
    });
    c.addEventListener("pointermove", (e) => {
      const p = info(e);
      if (this.#pointers.has(e.pointerId)) this.#pointers.set(e.pointerId, { x: p.x, y: p.y });
      if (this.#pinch && this.#pointers.size === 2) {
        const [a, b] = [...this.#pointers.values()];
        const d = Math.hypot(a!.x - b!.x, a!.y - b!.y);
        if (d > 0 && this.scene.zoom?.((a!.x + b!.x) / 2, (a!.y + b!.y) / 2, d / this.#pinch.d)) this.#pinch.d = d;
        return;
      }
      if (this.#dividerDrag) {
        this.#compareX = Math.min(0.98, Math.max(0.02, p.x / this.#size.w));
        this.#redraw = true;
        return;
      }
      if (this.#dragging) {
        this.scene.pointerMove?.(p);
        return;
      }
      this.#setHover(this.#hitAt(p.x, p.y));
    });
    const end = (e: PointerEvent) => {
      const p = info(e);
      this.#pointers.delete(e.pointerId);
      if (this.#pinch) {
        if (this.#pointers.size < 2) this.#pinch = null;
        return;
      }
      const click = this.#down && this.#down.id === e.pointerId && Math.hypot(p.x - this.#down.x, p.y - this.#down.y) < 5;
      this.#down = null;
      if (this.#dividerDrag) {
        this.#dividerDrag = false;
        return;
      }
      if (this.#dragging) {
        this.#dragging = false;
        c.classList.remove("grabbing");
        this.scene.pointerUp?.(p);
        this.#lastMoveAt = performance.now();
      }
      if (click && e.type === "pointerup") this.select(this.#hitAt(p.x, p.y));
    };
    c.addEventListener("pointerup", end);
    c.addEventListener("pointercancel", end);
    c.addEventListener("pointerleave", () => this.#setHover(null));
    c.addEventListener(
      "wheel",
      (e) => {
        if (!this.scene.zoom) return;
        const r = c.getBoundingClientRect();
        const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015));
        if (this.scene.zoom(e.clientX - r.left, e.clientY - r.top, factor)) e.preventDefault();
      },
      { passive: false },
    );
    c.addEventListener("keydown", (e) => {
      if (e.key === " " && this.scene.animated) {
        e.preventDefault();
        this.setPlaying(!this.scene.playing);
      }
      if (e.key === "Escape") this.select(null);
    });
  }

  #hitAt(x: number, y: number): string | null {
    const frame = this.#motion.frame(this.scene.anchors(), performance.now());
    return labelAt(frame.result, x, y)?.id ?? this.scene.hit(x, y);
  }

  #setHover(id: string | null): void {
    if (id === this.hover) return;
    this.hover = id;
    this.#canvas.classList.toggle("pointer", id !== null);
    this.#redraw = true;
    this.#scheduleInspector();
  }

  select(id: string | null): void {
    this.selected = id;
    this.#redraw = true;
    this.#inspector.update();
    if (id && this.view.showCandidates && !this.result?.candidates) this.#invalidate();
  }

  placementOf(id: string): Placement | undefined {
    return this.result?.placements.find((p) => p.id === id);
  }

  setPlaying(on: boolean): void {
    if (!this.scene.animated) return;
    this.scene.playing = on;
    this.#lastMoveAt = performance.now();
    if (!on && this.view.settle && this.view.warmStart) this.#needsSettle = true;
    this.#renderTransport();
  }

  // --- chrome ---------------------------------------------------------------------------

  #bindChrome(): void {
    const nav = document.getElementById("scenes")!;
    for (const s of this.scenes) {
      nav.appendChild(h("button", { type: "button", "data-scene": s.id, onclick: () => void this.selectScene(s.id).then(() => this.#saveHash()) }, s.title));
    }
    const sel = document.getElementById("engine") as HTMLSelectElement;
    sel.value = this.engineId;
    sel.addEventListener("change", () => {
      this.engineId = sel.value as EngineId;
      this.#invalidate();
    });
    document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) =>
      b.addEventListener("click", () => this.showTab(b.dataset.tab!)),
    );
    // a link to another scene on the page (or an edited address) switches the scene
    window.addEventListener("hashchange", () => {
      const st = this.#readHash();
      if (st && st.scene !== this.scene?.id) void this.selectScene(st.scene, st);
    });
  }

  showTab(tab: string): void {
    this.#tab = tab;
    document.querySelectorAll<HTMLButtonElement>(".tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
    document.querySelectorAll<HTMLElement>(".tabpanel").forEach((p) => (p.hidden = p.dataset.tab !== tab));
    this.#refreshTabs();
  }

  #refreshTabs(): void {
    if (this.#tab === "inspect") this.#scheduleInspector();
    if (this.#tab === "code") this.#code.update();
  }

  #scheduleInspector(): void {
    if (this.#tab !== "inspect" || this.#inspectTimer) return;
    this.#inspectTimer = window.setTimeout(() => {
      this.#inspectTimer = 0;
      this.#inspector.update();
    }, 120);
  }

  #renderPanel(): void {
    const sceneSection: Section = {
      id: "scene",
      title: this.scene.title,
      about: this.scene.about,
      note: this.scene.hint,
      open: true,
      controls: this.scene.controls.map((c) => ({ ...c, key: `param.${c.key}` }) as Control),
    };
    const toolbar = h(
      "div",
      { class: "toolbar" },
      h("button", { type: "button", onclick: () => this.resetAll(), title: "Every option back to the scene's values" }, "Reset options"),
      h("button", { type: "button", onclick: () => void this.#share(), title: "Copy a link to this scene with these options" }, "Copy link"),
    );
    this.#panel.render([sceneSection, ...SECTIONS], toolbar);
  }

  #renderTitle(): void {
    const el = document.getElementById("hud-title")!;
    const box = h("div", { class: "title" }, h("strong", {}, this.scene.title), h("span", {}, this.scene.hint));
    el.replaceChildren(box);
    clearTimeout(this.#titleTimer);
    // the hint fades after a while (or at the first gesture), freeing the drawing
    this.#titleTimer = window.setTimeout(() => this.#fadeTitle(), 7000);
  }

  #fadeTitle(): void {
    const box = document.querySelector("#hud-title .title");
    if (!box || box.classList.contains("gone")) return;
    box.classList.add("gone");
    // the labels may take the room: a solve from the current labels, not a fresh one
    if (this.view.avoidHud) this.#warmPending = true;
  }

  /** Rectangles of the controls over the drawing, in canvas px (4 px around each, out to 8 px steps). */
  #hudRects(): number[][] {
    const c = this.#canvas.getBoundingClientRect();
    const out: number[][] = [];
    const els = document.querySelectorAll<HTMLElement>("#hud-stats > *, #hud-transport > *, #hud-view > *, #hud-legend > *, #hud-title > .title:not(.gone)");
    const seen = new Set<string>();
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const key = `${el.parentElement?.id}:${[...(el.parentElement?.children ?? [])].indexOf(el)}`;
      seen.add(key);
      const [x0, y0, x1, y1] = [r.left - c.left - 4, r.top - c.top - 4, r.right - c.left + 4, r.bottom - c.top + 4];
      // an overlay that changes a little (a digit of the statistics) keeps its rectangle:
      // obstacles that change at every solve would move the labels next to them
      const old = this.#hudCache.get(key);
      if (old && x0 >= old[0] && y0 >= old[1] && x1 <= old[0] + old[2] && y1 <= old[1] + old[3] && old[2] - (x1 - x0) <= 32 && old[3] - (y1 - y0) <= 16) {
        out.push(old);
        return;
      }
      const q = 8;
      const rect = [Math.floor(x0 / q) * q, Math.floor(y0 / q) * q, 0, 0];
      rect[2] = Math.ceil(x1 / q) * q - rect[0]!;
      rect[3] = Math.ceil(y1 / q) * q - rect[1]!;
      this.#hudCache.set(key, rect);
      out.push(rect);
    });
    for (const key of [...this.#hudCache.keys()]) if (!seen.has(key)) this.#hudCache.delete(key);
    return out;
  }

  #renderTransport(): void {
    const el = document.getElementById("hud-transport")!;
    const s = this.scene;
    const parts: HTMLElement[] = [];
    if (s.animated) {
      parts.push(
        h("button", { type: "button", "aria-pressed": String(s.playing), title: "Play or pause (space)", onclick: () => this.setPlaying(!s.playing) }, icon(s.playing ? "pause" : "play"), s.playing ? "Pause" : "Play"),
      );
      const speed = h("input", { type: "range", min: "-2", max: "2", step: "0.25", value: String(Math.log2(this.view.speed)), "aria-label": "Speed" }) as HTMLInputElement;
      const label = h("b", {}, `${this.view.speed}×`);
      speed.addEventListener("input", () => {
        this.view.speed = 2 ** Number(speed.value);
        label.textContent = `${Math.round(this.view.speed * 100) / 100}×`;
      });
      parts.push(h("label", { class: "speed" }, "Speed", speed, label));
    }
    parts.push(h("button", { type: "button", title: "Back to the start", onclick: () => { s.reset(); this.#motion.clear(); this.result = undefined; this.#invalidate(); } }, icon("reset"), "Reset"));
    el.replaceChildren(...parts);
    const legend = document.getElementById("hud-legend")!;
    const entries = s.legend?.() ?? [];
    legend.replaceChildren(...(entries.length ? [h("div", { class: "legend-box" }, entries.map((e) => h("span", {}, h("i", { style: { background: e.color } }), e.label)))] : []));
    const view = document.getElementById("hud-view")!;
    view.replaceChildren(...(s.viewButtons?.() ?? []).map((b) => h("button", { type: "button", title: b.title, onclick: () => b.run() }, b.label)));
  }

  #renderStats(): void {
    const el = document.getElementById("hud-stats")!;
    const r = this.result;
    if (!r) return;
    const st = r.stats as unknown as Obj;
    const bad = Number(st.hard_violations ?? 0);
    const last = this.history[this.history.length - 1];
    el.replaceChildren(
      h(
        "div",
        { class: "chip", title: "Labels placed of the items, overlaps found by the engine's verification, solve time" },
        h("span", { class: "busy", id: "busy" }),
        h("span", {}, h("b", {}, String(st.placed)), ` / ${st.total} labels`),
        h("span", { class: "sep" }),
        h("span", { class: bad ? "bad" : "" }, bad ? `${bad} overlaps` : "no overlaps"),
        st.time_guard_hit ? h("span", { class: "bad", title: "The wall-clock guard stopped the search (see Inspect)" }, "guard") : null,
        h("span", { class: "sep" }),
        h("span", {}, h("b", {}, `${fmtMs(Number(st.runtime_ms ?? 0))}`), last ? h("span", { class: "engine-name" }, ` · ${ENGINE_NAMES[last.engine]}`) : ""),
      ),
    );
  }

  #busy(on: boolean): void {
    document.getElementById("busy")?.classList.toggle("on", on);
  }

  #renderCredits(): void {
    const el = document.getElementById("credits")!;
    el.innerHTML = `${this.scene.credits} Label Anything is experimental: options and layouts can change in any 0.x release. <a href="https://github.com/fabian-beck/label-anything">Source</a> (MIT) · <a href="THIRD-PARTY-NOTICES.txt">third-party notices</a>.`;
  }

  toast(text: string, kind: "error" | "info" = "info", ms = 5000): void {
    const el = document.getElementById("banner")!;
    el.textContent = text;
    el.className = `banner ${kind === "info" ? "info" : ""}`;
    el.hidden = false;
    clearTimeout(this.#toastTimer);
    if (ms > 0) this.#toastTimer = window.setTimeout(() => this.#hideToast(), ms);
  }

  #hideToast(): void {
    const el = document.getElementById("banner")!;
    if (el.className.includes("info")) el.hidden = true;
    if (!this.#engineError && !el.className.includes("info")) el.hidden = true;
  }

  // --- size --------------------------------------------------------------------------------

  #measure(): boolean {
    const wrap = document.getElementById("stage-wrap")!;
    const w = Math.max(200, Math.floor(wrap.clientWidth));
    const hh = Math.max(200, Math.floor(wrap.clientHeight));
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === this.#size.w && hh === this.#size.h && dpr === this.#size.dpr) return false;
    this.#size = { w, h: hh, dpr };
    this.#canvas.width = Math.round(w * dpr);
    this.#canvas.height = Math.round(hh * dpr);
    return true;
  }

  #resize(): void {
    if (!this.#measure() || !this.scene) return;
    this.scene.resize(this.#size.w, this.#size.h);
    this.#invalidate();
  }

  get size(): { w: number; h: number } {
    return { w: this.#size.w, h: this.#size.h };
  }

  // --- share links -----------------------------------------------------------------------

  #state(): HashState {
    const sceneView = { ...VIEW_DEFAULTS, ...(this.scene.view as Partial<View>) };
    const view: Partial<View> = {};
    for (const k of Object.keys(this.view) as (keyof View)[]) {
      if (k !== "customJson" && !deepEqual(this.view[k], sceneView[k])) (view as Obj)[k] = this.view[k];
    }
    const params: Obj = {};
    for (const c of this.scene.controls) params[c.key] = this.scene.params[c.key];
    return { scene: this.scene.id, overrides: this.overrides, view, params, json: this.view.customJson || undefined, playing: this.scene.playing };
  }

  #saveHash(): void {
    clearTimeout(this.#hashTimer);
    this.#hashTimer = window.setTimeout(() => {
      const st = this.#state();
      const compact = { o: st.overrides, v: st.view, p: st.params, j: st.json };
      const empty = Object.keys(st.overrides ?? {}).length === 0 && Object.keys(st.view ?? {}).length === 0 && !st.json;
      const hash = empty ? `#${st.scene}` : `#${st.scene}:${toBase64Url(JSON.stringify(compact))}`;
      history.replaceState(null, "", hash);
    }, 300);
  }

  #readHash(): HashState | null {
    const m = /^#([a-z0-9-]+)(?::([A-Za-z0-9_-]+))?$/.exec(location.hash);
    if (!m) return null;
    const state: HashState = { scene: m[1]! };
    if (m[2]) {
      try {
        const v = JSON.parse(fromBase64Url(m[2])) as { o?: Obj; v?: Partial<View>; p?: Obj; j?: string };
        if (isObject(v.o)) state.overrides = v.o;
        if (isObject(v.v)) state.view = v.v;
        if (isObject(v.p)) state.params = v.p;
        if (typeof v.j === "string") state.json = v.j;
      } catch {
        // an old or broken link: the scene with its defaults
      }
    }
    return state;
  }

  async #share(): Promise<void> {
    clearTimeout(this.#hashTimer);
    const st = this.#state();
    const compact = { o: st.overrides, v: st.view, p: st.params, j: st.json };
    const url = `${location.origin}${location.pathname}#${st.scene}:${toBase64Url(JSON.stringify(compact))}`;
    history.replaceState(null, "", url);
    try {
      await navigator.clipboard.writeText(url);
      this.toast("Link copied: it opens this scene with these options.", "info", 3000);
    } catch {
      this.toast("The link is in the address bar.", "info", 3000);
    }
  }
}

export interface Solved2 {
  result: LabelResult;
  roundTrip: number;
}

export interface HashState {
  scene: string;
  overrides?: Obj;
  view?: Partial<View>;
  params?: Obj;
  json?: string;
  playing?: boolean;
}

/** A dotted path in the effective options; map entries (`avoid.label.x`) fall back to `"*"`. */
function lookup(options: Obj, key: string): unknown {
  const v = getPath(options, key);
  if (v !== undefined) return v;
  const m = /^(avoid\.(?:label|leader))\.[^.]+$/.exec(key);
  if (m) return getPath(options, `${m[1]}.*`);
  return undefined;
}

/** What `warm_start` needs of a placement: the box, where it was placed for, its leader. */
function warmPlacement(p: Placement): Obj {
  const out: Obj = { id: p.id, placed: p.placed };
  if (p.placed && p.box) {
    out.box = p.box;
    if (p.anchor) out.anchor = p.anchor;
    if (p.leader) out.leader = { points: p.leader.points, style: p.leader.style };
  }
  return out;
}

function drawDivider(ctx: CanvasRenderingContext2D, x: number, h: number): void {
  ctx.save();
  ctx.strokeStyle = "#3949ab";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
  ctx.fillStyle = "#3949ab";
  ctx.beginPath();
  ctx.roundRect?.(x - 9, h / 2 - 18, 18, 36, 6);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "600 11px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("⇆", x, h / 2 + 4);
  ctx.textAlign = "left";
  ctx.font = "600 12px system-ui, sans-serif";
  const tag = (text: string, tx: number, align: CanvasTextAlign) => {
    ctx.textAlign = align;
    const w = ctx.measureText(text).width + 12;
    const bx = align === "right" ? tx - w : tx;
    ctx.fillStyle = "rgba(57, 73, 171, 0.92)";
    ctx.beginPath();
    ctx.roundRect?.(bx, 56, w, 22, 5);
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, align === "right" ? tx - 6 : tx + 6, 71);
  };
  tag("Naive: every label top-right", x - 14, "right");
  tag("Label Anything", x + 14, "left");
  ctx.restore();
}

const round2 = (v: number) => Math.round(v * 100) / 100;

function fmtMs(v: number): string {
  return v >= 100 ? `${Math.round(v)} ms` : `${v.toFixed(1)} ms`;
}
