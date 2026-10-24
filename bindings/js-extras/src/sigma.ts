/**
 * sigma.js (v2/v3): node labels placed by Label Anything.
 *
 * ```js
 * import { labelSigma } from "@label-anything/extras/sigma";
 * const labels = labelSigma(renderer, { priority: (key, attrs) => attrs.size });
 * ```
 *
 * Sigma draws labels at a fixed pixel size while nodes move under the camera, so the solve
 * runs in viewport pixels: after camera moves and graph changes (debounced), warm-started
 * from the previous result. In between, labels follow their nodes; after a solve they glide
 * into their new places and fade in and out (`transition`). Labels are drawn by a
 * replacement of sigma's label renderer; omitted labels are hidden via `nodeReducer`.
 */
import type { LabelProblem, LabelResult } from "@label-anything/core";
import { LatestRunner, resolveEngine } from "./engine.js";
import { cssFont, numericWeight } from "./measure.js";
import { LabelMotion } from "./motion.js";
import { buildProblem, labelOf, placeOptionsOf, resolveFont, type LabelOptions } from "./options.js";
import { lineStart } from "./render.js";
import { LabelMemory } from "./stable.js";

type P = { x: number; y: number };
type Attrs = Record<string, unknown>;
type DisplayData = { x: number; y: number; size: number; label?: string | null; hidden?: boolean };
type Placement = LabelResult["placements"][number];

/** The parts of a graphology graph used here. */
export interface GraphLike {
  forEachNode(f: (key: string, attrs: Attrs) => void): void;
  forEachEdge(f: (key: string, attrs: Attrs, source: string, target: string) => void): void;
  on?(event: string, f: () => void): unknown;
  off?(event: string, f: () => void): unknown;
  removeListener?(event: string, f: () => void): unknown;
}

/** The parts of a sigma renderer used here. */
export interface SigmaLike {
  getGraph(): GraphLike;
  getNodeDisplayData(key: string): DisplayData | undefined;
  framedGraphToViewport(p: P): P;
  scaleSize?(size: number): number;
  getDimensions(): { width: number; height: number };
  getSetting(key: string): unknown;
  setSetting(key: string, value: unknown): unknown;
  getCamera(): { on(e: string, f: () => void): unknown; removeListener?(e: string, f: () => void): unknown; off?(e: string, f: () => void): unknown };
  on(e: string, f: () => void): unknown;
  removeListener?(e: string, f: () => void): unknown;
  off?(e: string, f: () => void): unknown;
  refresh?(): unknown;
}

export interface SigmaNode {
  key: string;
  attributes: Attrs;
}

export interface SigmaLabelOptions extends Omit<LabelOptions<SigmaNode>, "id" | "text" | "priority" | "attrs"> {
  /** Label text (default: the node's display label). */
  text?: (key: string, attrs: Attrs) => string | null | undefined;
  /** Priority per node (higher = kept first). */
  priority?: ((key: string, attrs: Attrs) => number | null | undefined) | LabelProblem["priority"];
  /** Text colour (default: sigma's `labelColor`). */
  fill?: string;
  /** Edges as obstacles (default `true`). */
  avoidEdges?: boolean;
  /** Re-solve delay after camera moves and graph changes in ms (default 120). */
  debounce?: number;
  /** Transition time in ms (default 300): labels glide into new places and fade in and out; 0: none. */
  transition?: number;
  onResult?: (result: LabelResult) => void;
  onError?: (error: unknown) => void;
}

export interface SigmaLabels {
  update(): void;
  remove(): void;
  readonly result: LabelResult | undefined;
}

type DrawLabel = (ctx: CanvasRenderingContext2D, data: DisplayData & { key: string }, settings: Attrs) => void;

export function labelSigma(renderer: SigmaLike, options: SigmaLabelOptions = {}): SigmaLabels {
  const runner = new LatestRunner(resolveEngine(options.engine));
  const memory = new LabelMemory();
  const graph = renderer.getGraph();
  const color = (renderer.getSetting("labelColor") as { color?: string } | undefined)?.color;
  const font = resolveFont(options.font, {
    family: String(renderer.getSetting("labelFont") ?? "Arial"),
    size: Number(renderer.getSetting("labelSize") ?? 14),
    weight: numericWeight(renderer.getSetting("labelWeight") as string | undefined),
  });
  const fill = options.fill ?? color ?? "#000";
  const helper: LabelOptions<SigmaNode> = {
    ...options,
    text: undefined,
    priority: typeof options.priority === "function" ? (n) => (options.priority as (k: string, a: Attrs) => number)(n.key, n.attributes) : options.priority,
  };
  const motion = new LabelMotion({ duration: options.transition ?? 300 });
  // the labels as drawn now (moving or fading), at the positions of their last solve
  let shown = new Map<string, { p: Placement; opacity: number; leaderOpacity: number }>();
  const snapshot = () => {
    const f = motion.frame();
    shown = new Map(
      f.result.placements.map((p) => {
        const opacity = f.opacity.get(p.id) ?? 1;
        return [p.id, { p, opacity, leaderOpacity: f.leaderOpacity.get(p.id) ?? opacity }];
      }),
    );
  };
  let frame: number | undefined;
  const animate = () => {
    if (frame !== undefined || !motion.moving) return;
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== "function") {
      motion.finish();
      snapshot();
      renderer.refresh?.();
      return;
    }
    const step = () => {
      frame = undefined;
      snapshot();
      renderer.refresh?.();
      if (motion.moving) frame = raf(step);
    };
    frame = raf(step);
  };

  const viewport = (key: string): (DisplayData & P) | undefined => {
    const d = renderer.getNodeDisplayData(key);
    if (!d || d.hidden) return undefined;
    const p = renderer.framedGraphToViewport(d);
    return { ...d, x: p.x, y: p.y };
  };

  // Labels: drawn at their offset from the node's current position.
  const draw: DrawLabel = (ctx, data) => {
    const s = shown.get(data.key);
    const p = s?.p;
    if (!s || !p || !p.box || !p.anchor) return;
    const dx = data.x - p.anchor[0];
    const dy = data.y - p.anchor[1];
    ctx.save();
    const leaders = p.leaders ?? (p.leader ? [p.leader] : []);
    if (leaders.length) {
      ctx.globalAlpha = s.leaderOpacity;
      ctx.strokeStyle = fill;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const l of leaders) l.points.forEach((q, i) => (i ? ctx.lineTo(q[0] + dx, q[1] + dy) : ctx.moveTo(q[0] + dx, q[1] + dy)));
      ctx.stroke();
    }
    const t = p.text;
    if (t) {
      ctx.globalAlpha = s.opacity;
      ctx.fillStyle = fill;
      ctx.font = cssFont({ ...font, size: t.font_size });
      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      t.lines.forEach((line, i) => ctx.fillText(line, p.box!.x + lineStart(t, i) + dx, p.box!.y + (t.baseline_offsets[i] ?? 0) + dy));
    }
    ctx.restore();
  };
  const v3 = renderer.getSetting("defaultDrawNodeLabel") !== undefined;
  const drawKey = v3 ? "defaultDrawNodeLabel" : "labelRenderer";
  const previousDraw = renderer.getSetting(drawKey);
  const previousReducer = renderer.getSetting("nodeReducer") as ((key: string, data: Attrs) => Attrs) | null | undefined;
  renderer.setSetting(drawKey, draw);
  renderer.setSetting("nodeReducer", (key: string, data: Attrs) => {
    const out = previousReducer ? previousReducer(key, data) : data;
    return shown.has(key) ? { ...out, forceLabel: true } : { ...out, label: null };
  });

  const solve = () => {
    const { width, height } = renderer.getDimensions();
    if (!(width > 0 && height > 0)) return;
    const items: LabelProblem["items"] = [];
    const anchors = new Map<string, readonly [number, number]>();
    const pos = new Map<string, P>();
    graph.forEachNode((key, attrs) => {
      const d = viewport(key);
      if (!d) return;
      pos.set(key, d);
      if (!(d.x >= 0 && d.y >= 0 && d.x <= width && d.y <= height)) return;
      // the label sigma would show (our reducer hides omitted ones in the display data)
      const shown = previousReducer ? previousReducer(key, attrs) : attrs;
      const text = options.text ? options.text(key, attrs) : (shown.label as string | null | undefined);
      const label = labelOf<SigmaNode>({ text: () => text }, { key, attributes: attrs }, 0);
      if (!label) return;
      const r = renderer.scaleSize ? renderer.scaleSize(d.size) : d.size;
      anchors.set(key, [d.x, d.y]);
      const item: LabelProblem["items"][number] = { id: key, anchor: { type: "point", x: d.x, y: d.y, mark: { shape: "circle", r } }, label };
      if (typeof helper.priority === "function") {
        const p = helper.priority({ key, attributes: attrs }, 0);
        if (typeof p === "number" && Number.isFinite(p)) item.priority = p;
      }
      items.push(item);
    });
    const polylines: [number, number][][] = [];
    if (options.avoidEdges !== false) {
      graph.forEachEdge((_k, _a, s, t) => {
        const a = pos.get(s);
        const b = pos.get(t);
        if (a && b) polylines.push([[a.x, a.y], [b.x, b.y]]);
      });
    }
    const warm = memory.warmStart(anchors);
    const problem = buildProblem(
      {
        canvas: { width, height },
        items,
        ...(polylines.length ? { obstacles: { vector: [{ class: "edges", polylines: polylines as never, width: 1 }] } } : {}),
        ...(warm ? { warm_start: warm } : {}),
      },
      helper,
      font,
    );
    runner.run(
      problem,
      placeOptionsOf(helper),
      (r) => {
        memory.remember(r, anchors);
        motion.target(r, anchors);
        snapshot();
        renderer.refresh?.();
        animate();
        options.onResult?.(r);
      },
      (e) => (options.onError ? options.onError(e) : console.error(e)),
    );
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      solve();
    }, options.debounce ?? 120);
  };
  const camera = renderer.getCamera();
  const graphEvents = ["nodeAdded", "nodeDropped", "edgeAdded", "edgeDropped", "nodeAttributesUpdated", "cleared"];
  camera.on("updated", schedule);
  renderer.on("resize", schedule);
  for (const e of graphEvents) graph.on?.(e, schedule);
  solve();

  const off = (target: { removeListener?(e: string, f: () => void): unknown; off?(e: string, f: () => void): unknown }, e: string, f: () => void) =>
    target.removeListener ? target.removeListener(e, f) : target.off?.(e, f);

  return {
    update: solve,
    remove() {
      if (timer !== undefined) clearTimeout(timer);
      if (frame !== undefined) globalThis.cancelAnimationFrame?.(frame);
      frame = undefined;
      motion.clear();
      runner.cancel();
      off(camera, "updated", schedule);
      off(renderer, "resize", schedule);
      for (const e of graphEvents) off(graph, e, schedule);
      renderer.setSetting(drawKey, previousDraw);
      renderer.setSetting("nodeReducer", previousReducer ?? null);
      shown = new Map();
      renderer.refresh?.();
    },
    get result() {
      return memory.result;
    },
  };
}
