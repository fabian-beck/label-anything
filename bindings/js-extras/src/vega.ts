/**
 * Vega: a `labelAnything` transform, a drop-in alternative to Vega's `label` transform.
 *
 * ```js
 * import * as vega from "vega";
 * import { registerVegaTransform } from "@label-anything/extras/vega";
 * registerVegaTransform(vega);
 * ```
 * ```json
 * { "type": "text", "from": {"data": "points"},
 *   "encode": {"enter": {"text": {"field": "datum.name"}, "fontSize": {"value": 11}}},
 *   "transform": [{ "type": "labelAnything", "size": {"signal": "[width, height]"},
 *                   "avoidMarks": ["trend"], "priority": "datum.datum.population" }] }
 * ```
 *
 * Like `label`, it works on a text mark with reactive geometry (`from.data` = the labeled
 * mark) and writes `x`, `y`, `opacity`, `align` and `baseline` (`as`). With `leaders`, it
 * also writes `leaderPath` (SVG path data, for a `path` mark on the text mark's data).
 * Avoided marks become vector obstacles with their mark name as class. Vega draws the
 * text items as encoded, so labels are moved but never wrapped or shrunk (the ladder
 * leaves out `wrap`, `truncate` and `shrink`).
 */
import type { FontSpec, LabelProblem, LabelResult } from "@label-anything/core";
import { isPromiseLike, resolveEngine, type AnyEngine, type Engine } from "./engine.js";
import { buildProblem, keepHostText, placeOptionsOf, resolveFont, type LabelOptions, type PointAnchor } from "./options.js";
import { leaderPath, lineStart } from "./render.js";

/** The parts of the `vega` module used here. */
export interface VegaLike {
  transforms: Record<string, unknown>;
  Transform: { call(self: unknown, value: unknown, params: unknown): void; prototype: object };
  inherits(child: unknown, parent: unknown, members?: object): unknown;
  textMetrics?: { width(item: object, text: string): number };
}

export interface VegaTransformDefaults {
  /** Engine for every `labelAnything` transform (default `@label-anything/core`). Must be synchronous. */
  engine?: Engine;
  /** Helper options applied to every transform (spec params override them). */
  options?: Omit<LabelOptions<unknown>, "engine">;
}

interface SceneItem {
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  width?: number;
  height?: number;
  size?: number;
  text?: string | string[];
  font?: string;
  fontSize?: number;
  fontWeight?: string | number;
  fontStyle?: string;
  bounds?: { x1: number; y1: number; x2: number; y2: number };
  datum?: SceneItem & Record<string, unknown>;
  mark?: { marktype?: string; name?: string };
  items?: SceneItem[];
  [k: string]: unknown;
}

const OUTPUT = ["x", "y", "opacity", "align", "baseline"];

/** Registers the `labelAnything` transform in `vega` (call once). */
export function registerVegaTransform(vega: VegaLike, defaults: VegaTransformDefaults = {}): void {
  function LabelAnything(this: unknown, params: unknown) {
    vega.Transform.call(this, null, params);
  }
  (LabelAnything as unknown as { Definition: object }).Definition = {
    type: "LabelAnything",
    metadata: { modifies: true },
    params: [
      { name: "size", type: "number", array: true, length: 2, required: true },
      { name: "sort", type: "compare" },
      { name: "priority", type: "field" },
      { name: "avoidMarks", type: "data", array: true },
      { name: "avoidBaseMark", type: "boolean", default: true },
      { name: "radius", type: "number" },
      { name: "padding", type: "number", default: 0 },
      { name: "preset", type: "string" },
      { name: "leaders", type: "string" },
      { name: "options", type: "string" },
      { name: "as", type: "string", array: true, length: OUTPUT.length, default: OUTPUT },
      { name: "leaderAs", type: "string", default: "leaderPath" },
    ],
  };
  vega.inherits(LabelAnything, vega.Transform, {
    transform(
      this: unknown,
      _: Record<string, unknown> & { modified(): boolean },
      pulse: {
        changed(flags: number): boolean;
        ADD_REM: number;
        materialize(flags: number): { source?: SceneItem[] };
        SOURCE: number;
        reflow(mod: boolean): { modifies(fields: string[]): unknown };
      },
    ) {
      const mod = _.modified();
      if (!(mod || pulse.changed(pulse.ADD_REM))) return;
      const size = _.size as number[] | undefined;
      if (!size || size.length !== 2) throw new Error("labelAnything: size must be a [width, height] array");
      const texts = pulse.materialize(pulse.SOURCE).source ?? [];
      const as = (_.as as string[] | undefined) ?? OUTPUT;
      const leaderAs = (_.leaderAs as string | undefined) ?? "leaderPath";
      layout(vega, texts, size as [number, number], _, defaults).forEach(({ item, x, y, placed, leader, align }) => {
        item[as[0]!] = x;
        item[as[1]!] = y;
        item[as[2]!] = placed ? 1 : 0;
        item[as[3]!] = align;
        item[as[4]!] = "alphabetic";
        item[leaderAs] = leader ?? "";
      });
      return pulse.reflow(mod).modifies([...as, leaderAs]);
    },
  });
  vega.transforms["labelanything"] = LabelAnything;
}

interface Laid {
  item: SceneItem;
  x: number | undefined;
  y: number | undefined;
  placed: boolean;
  leader: string | null;
  /** Vega's `align` of the text item: its lines aligned as the engine laid them out. */
  align: "left" | "center" | "right";
}

function layout(
  vega: VegaLike,
  texts: SceneItem[],
  size: [number, number],
  params: Record<string, unknown>,
  defaults: VegaTransformDefaults,
): Laid[] {
  if (!texts.length) return [];
  const opts: LabelOptions<SceneItem> = { ...(defaults.options as LabelOptions<SceneItem>) };
  if (typeof params.preset === "string") opts.preset = params.preset as LabelProblem["preset"];
  if (typeof params.leaders === "string") opts.leaders = params.leaders === "none" ? false : (params.leaders as LabelOptions["leaders"]);
  if (params.leaders === undefined && opts.leaders === undefined) opts.leaders = false;
  if (typeof params.padding === "number") opts.padding = params.padding;
  if (typeof params.options === "string" && params.options) {
    Object.assign(opts, { problem: { ...opts.problem, ...(JSON.parse(params.options) as Partial<LabelProblem>) } });
  }

  // Priority: a field accessor, else the sort comparator's order (first = most important).
  const prio = new Map<SceneItem, number>();
  const field = params.priority as ((d: unknown) => unknown) | undefined;
  const sort = params.sort as ((a: unknown, b: unknown) => number) | undefined;
  if (typeof field === "function") {
    for (const t of texts) {
      const v = Number(field(t));
      if (Number.isFinite(v)) prio.set(t, v);
    }
  } else if (typeof sort === "function") {
    const order = texts.slice().sort((a, b) => sort(a.datum ?? a, b.datum ?? b));
    order.forEach((t, k) => prio.set(t, order.length - k));
  }

  const first = texts[0]!;
  const font = resolveFont({ family: first.font ?? "sans-serif", size: first.fontSize ?? 11 });
  const radius = typeof params.radius === "number" ? params.radius : undefined;
  const avoidBase = params.avoidBaseMark !== false;
  const items: LabelProblem["items"] = [];
  texts.forEach((t, i) => {
    const text = Array.isArray(t.text) ? t.text.join("\n") : t.text;
    if (text === undefined || text === null || text === "") return;
    const base = t.datum && typeof t.datum === "object" && t.datum.mark ? t.datum : undefined;
    const { anchor, mark } = baseGeometry(base ?? t, base !== undefined, radius, avoidBase);
    if (!anchor) return;
    const label: LabelProblem["items"][number]["label"] = { type: "text", text: String(text) };
    if (t.fontSize !== undefined || t.font !== undefined || t.fontWeight !== undefined || t.fontStyle !== undefined) {
      label.font = {
        ...(t.font ? { family: t.font } : {}),
        ...(t.fontSize ? { size: t.fontSize } : {}),
        ...(t.fontWeight !== undefined ? { weight: Number(t.fontWeight) || (t.fontWeight === "bold" ? 700 : 400) } : {}),
        ...(t.fontStyle === "italic" ? { style: "italic" as const } : {}),
      };
    }
    const item: LabelProblem["items"][number] = { id: String(i), anchor: mark ? { ...anchor, mark } : { ...anchor }, label };
    const p = prio.get(t);
    if (p !== undefined) item.priority = p;
    items.push(item);
  });

  const vectors: NonNullable<NonNullable<LabelProblem["obstacles"]>["vector"]> = [];
  const avoid = (params.avoidMarks as SceneItem[][] | undefined) ?? [];
  avoid.forEach((markItems, k) => {
    const layer = obstacleLayer(markItems, k);
    if (layer) vectors.push(layer);
  });
  // Avoided marks are hard by default (as in Vega's label transform).
  const hard: Record<string, "hard"> = {};
  for (const v of vectors) if (v.class !== undefined) hard[v.class] = "hard";
  if (!opts.avoid) opts.avoid = { label: hard };
  else opts.avoid = { ...opts.avoid, label: { ...hard, ...opts.avoid.label } };

  // Vega draws the text items as encoded: labels are moved, never wrapped or shrunk.
  const problem = keepHostText(
    buildProblem({ canvas: { width: size[0], height: size[1] }, items, ...(vectors.length ? { obstacles: { vector: vectors } } : {}) }, opts, font),
  );
  const measure = vega.textMetrics
    ? (text: string, f: FontSpec) => ({
        width: vega.textMetrics!.width({ font: f.family, fontSize: f.size, fontWeight: f.weight, fontStyle: f.italic ? "italic" : "normal" }, text),
        ascent: 0.8 * f.size,
        descent: 0.2 * f.size,
      })
    : undefined;
  const engine: AnyEngine = defaults.engine ?? resolveEngine(opts.engine);
  const out = engine.place(problem, placeOptionsOf(opts, measure ?? undefined));
  if (isPromiseLike(out)) throw new Error("labelAnything: the Vega transform needs a synchronous engine (@label-anything/core or /wasm)");
  return apply(texts, out as LabelResult);
}

function apply(texts: SceneItem[], result: LabelResult): Laid[] {
  const byId = new Map(result.placements.map((p) => [p.id, p]));
  return texts.map((item, i) => {
    const p = byId.get(String(i));
    if (!p || !p.placed || !p.box) return { item, x: item.x, y: item.y, placed: false, leader: null, align: "left" };
    const t = p.text ?? p.parts?.find((q) => q.text)?.text;
    const y = p.box.y + (t?.baseline_offsets[0] ?? p.box.h * 0.8);
    const leaders = p.leaders ?? (p.leader ? [p.leader] : []);
    const leader = leaders.length ? leaders.map(leaderPath).join("") : null;
    // Vega draws the lines of a text item itself: several lines take the engine's alignment
    if (t && t.lines.length > 1 && t.align === "center") return { item, x: p.box.x + p.box.w / 2, y, placed: true, leader, align: "center" };
    if (t && t.lines.length > 1 && t.align === "end") return { item, x: p.box.x + p.box.w - (t.x_offset ?? 0), y, placed: true, leader, align: "right" };
    return { item, x: p.box.x + (t ? lineStart(t, 0) : 0), y, placed: true, leader, align: "left" };
  });
}

type Anchor = PointAnchor;

/** Anchor point and mark of a labeled scene item (reactive geometry) or of the text itself. */
function baseGeometry(
  d: SceneItem,
  reactive: boolean,
  radius: number | undefined,
  avoidBase: boolean,
): { anchor?: Anchor; mark?: Anchor["mark"] } {
  const type = d.mark?.marktype;
  if (!reactive || !d.bounds || type === "line" || type === "area") {
    if (!Number.isFinite(d.x) || !Number.isFinite(d.y)) return {};
    return { anchor: { type: "point", x: d.x!, y: d.y! }, mark: { shape: "circle", r: radius ?? 0 } };
  }
  const b = d.bounds;
  const [w, h] = [b.x2 - b.x1, b.y2 - b.y1];
  const anchor: Anchor = { type: "point", x: (b.x1 + b.x2) / 2, y: (b.y1 + b.y2) / 2 };
  if (!avoidBase) return { anchor, mark: { shape: "circle", r: 0 } };
  if (type === "symbol") return { anchor, mark: { shape: "circle", r: radius ?? Math.max(w, h) / 2 } };
  return { anchor, mark: { shape: "rect", w, h } };
}

type VectorLayer = NonNullable<NonNullable<LabelProblem["obstacles"]>["vector"]>[number];

/** Vector obstacles of the items of an avoided mark (class: the mark name). */
function obstacleLayer(markItems: SceneItem[], k: number): VectorLayer | null {
  const rects: [number, number, number, number][] = [];
  const polylines: [number, number][][] = [];
  const visit = (items: SceneItem[]) => {
    if (!items.length) return;
    const type = items[0]!.mark?.marktype;
    if (type === "group") {
      for (const g of items) for (const m of (g.items ?? []) as SceneItem[]) visit((m.items ?? []) as SceneItem[]);
      return;
    }
    if (type === "line" || type === "trail") {
      const pts = items.filter((d) => Number.isFinite(d.x) && Number.isFinite(d.y)).map((d) => [d.x!, d.y!] as [number, number]);
      if (pts.length >= 2) polylines.push(pts);
      return;
    }
    if (type === "rule") {
      for (const d of items) {
        const x2 = d.x2 ?? d.x;
        const y2 = d.y2 ?? d.y;
        if ([d.x, d.y, x2, y2].every(Number.isFinite)) polylines.push([[d.x!, d.y!], [x2!, y2!]]);
      }
      return;
    }
    for (const d of items) {
      const b = d.bounds;
      if (b && Number.isFinite(b.x1) && b.x2 >= b.x1 && b.y2 >= b.y1) rects.push([b.x1, b.y1, b.x2 - b.x1, b.y2 - b.y1]);
    }
  };
  visit(markItems ?? []);
  if (!rects.length && !polylines.length) return null;
  const name = markItems[0]?.mark?.name;
  const cls = name && /^[A-Za-z_][A-Za-z0-9_.:-]*$/.test(name) ? name : `avoid${k}`;
  const layer: VectorLayer = { class: cls };
  if (rects.length) layer.rects = rects;
  if (polylines.length) {
    layer.polylines = polylines as VectorLayer["polylines"];
    layer.width = 1;
  }
  return layer;
}
