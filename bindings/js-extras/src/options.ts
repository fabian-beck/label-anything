/** Options shared by all helpers and the problem they turn into. */
import type { LabelProblem, PlaceOptions } from "@label-anything/core";
import type { AnyEngine } from "./engine.js";
import { canvasMeasure, numericWeight, type CssFont, type MeasureFn } from "./measure.js";

export type Item = LabelProblem["items"][number];
export type Label = Item["label"];
export type LeaderStyle = NonNullable<NonNullable<LabelProblem["leaders"]>["style"]>;
/** Geometry of a labeled feature (spec §3.2). */
export type Mark = NonNullable<NonNullable<LabelProblem["defaults"]>["mark"]>;
/** A point anchor (the generated `Anchor` type does not discriminate point and area). */
export interface PointAnchor {
  type: "point";
  x: number;
  y: number;
  mark?: Mark;
}

/** Font options: CSS family list, size in px, weight, style. */
export interface FontOptions {
  family?: string;
  size?: number;
  weight?: number | "normal" | "bold";
  style?: "normal" | "italic";
}

/** Options every helper accepts (`D` is the datum type). */
export interface LabelOptions<D = unknown> {
  /** Solver: `@label-anything/core` (default), `@label-anything/wasm` or a worker engine. */
  engine?: AnyEngine;
  /** Label text, or a full label object (`{type: "text", ...}`, icons, composites). */
  text?: ((d: D, i: number) => string | Label | null | undefined) | string;
  /** Stable item ids (needed for warm starts across updates). Default: the index. */
  id?: (d: D, i: number) => string | number;
  /**
   * Item priority: a number per datum (higher = more important, kept when space runs out),
   * or the problem's `priority` section (terms, omission, budget, ...).
   */
  priority?: ((d: D, i: number) => number | null | undefined) | LabelProblem["priority"];
  /** Free data per item for priority terms and expressions (`item.attrs`). */
  attrs?: (d: D, i: number) => Record<string, unknown> | undefined;
  /** Preset: auto (default), scatter, map, graph, illustration, none. */
  preset?: LabelProblem["preset"];
  /** Label font; the helper renders labels with exactly this font. */
  font?: FontOptions;
  /** Avoidance policy (`{label: {points: 0.3, ...}, leader: {...}}`). */
  avoid?: LabelProblem["avoid"];
  /**
   * Leaders: `false` keeps labels next to their anchors, a style name (`"straight"`,
   * `"elbow"`, ...) enables distant labels with that style, an object sets `leaders`.
   */
  leaders?: false | LeaderStyle | LabelProblem["leaders"];
  placement?: LabelProblem["placement"];
  solver?: LabelProblem["solver"];
  /** Keep labels this far inside the canvas edge (px). */
  padding?: number;
  /** Any other problem fields, merged last (top-level keys replace the helper's). */
  problem?: Partial<LabelProblem>;
  /**
   * Text measurement. Default: the browser's canvas (`canvasMeasure()`), which matches how
   * the labels are rendered; `false` uses the engine's built-in metrics.
   */
  measure?: MeasureFn | false;
  /** Further solve options (progress, signal, cost, ...). */
  placeOptions?: Omit<PlaceOptions, "measure">;
}

export function resolveFont(font: FontOptions | undefined, fallback: Partial<CssFont> = {}): CssFont {
  return {
    family: font?.family ?? fallback.family ?? "sans-serif",
    size: font?.size ?? fallback.size ?? 11,
    weight: numericWeight(font?.weight ?? fallback.weight),
    italic: (font?.style ?? (fallback.italic ? "italic" : "normal")) === "italic",
  };
}

/** The label of a datum (`null` when it has no text). */
export function labelOf<D>(options: LabelOptions<D>, d: D, i: number, fallback?: (d: D) => unknown): Label | null {
  let t: unknown;
  if (typeof options.text === "function") t = options.text(d, i);
  else if (typeof options.text === "string") t = (d as Record<string, unknown> | null)?.[options.text];
  else t = fallback ? fallback(d) : undefined;
  if (t === null || t === undefined || t === "") return null;
  if (typeof t === "object") return t as Label;
  return { type: "text", text: String(t) };
}

export function idOf<D>(options: LabelOptions<D>, d: D, i: number): string {
  return String(options.id ? options.id(d, i) : i);
}

/** Per-item fields from the accessors: priority and attrs. */
export function itemExtras<D>(options: LabelOptions<D>, d: D, i: number): Partial<Item> {
  const out: Partial<Item> = {};
  if (typeof options.priority === "function") {
    const p = options.priority(d, i);
    if (typeof p === "number" && Number.isFinite(p)) out.priority = p;
  }
  if (options.attrs) {
    const a = options.attrs(d, i);
    if (a) out.attrs = a;
  }
  return out;
}

/** Assembles the problem: helper-built parts, then the option sections, then `options.problem`. */
export function buildProblem<D>(
  base: Pick<LabelProblem, "canvas" | "items"> & Partial<LabelProblem>,
  options: LabelOptions<D>,
  font: CssFont,
): LabelProblem {
  const p: LabelProblem = { ...base };
  if (options.preset) p.preset = options.preset;
  p.defaults = {
    ...base.defaults,
    font: { family: font.family, size: font.size, weight: font.weight, style: font.italic ? "italic" : "normal" },
  };
  if (options.padding !== undefined && p.canvas) p.canvas = { ...p.canvas, padding: options.padding };
  if (options.avoid) p.avoid = options.avoid;
  // with a priority, important labels may cover the dots of less important items, which
  // then go unlabeled (ADR 0045); the caller's own lower_items wins
  if (options.priority !== undefined || base.items.some((it) => it.priority !== undefined || it.tier !== undefined)) {
    const a = p.avoid ?? {};
    p.avoid = { ...a, label: { lower_items: 10, ...a.label }, leader: { lower_items: 2.5, ...a.leader } };
  }
  if (options.placement) p.placement = { ...options.placement };
  if (options.leaders === false) {
    const models = (p.placement?.models ?? ["adjacent", "slider"]).filter((m) => m !== "distant" && m !== "boundary");
    p.placement = { ...p.placement, models };
  } else if (typeof options.leaders === "string") {
    p.leaders = { style: options.leaders };
    const models = p.placement?.models ?? ["adjacent", "slider"];
    if (!models.includes("distant")) p.placement = { ...p.placement, models: [...models, "distant"] };
  } else if (options.leaders) {
    p.leaders = options.leaders;
  }
  if (options.priority && typeof options.priority === "object") p.priority = options.priority;
  if (options.solver) p.solver = options.solver;
  return { ...p, ...options.problem };
}

/** The default degradation ladder (`degrade` in spec/defaults.md). */
const DEFAULT_DEGRADE = ["alternatives", "wrap", "distant", "evict_lower", "shrink:0.85", "soft_overlap", "omit"];

/**
 * For helpers whose host draws the label text itself (Vega, Cytoscape) and only moves it:
 * leaves the steps that change the text out of the degradation ladder (`wrap`,
 * `truncate`, `shrink`), since the host would still draw it on one line at its own size.
 */
export function keepHostText(problem: LabelProblem): LabelProblem {
  const ladder = (problem.degrade ?? DEFAULT_DEGRADE).filter((s) => s !== "wrap" && s !== "truncate" && !s.startsWith("shrink"));
  return { ...problem, degrade: ladder };
}

/** Solve options: the measurement (canvas by default) plus `placeOptions`. */
export function placeOptionsOf<D>(options: LabelOptions<D>, measure?: MeasureFn): PlaceOptions {
  const m = options.measure === false ? undefined : (options.measure ?? measure ?? defaultMeasure());
  return m ? { ...options.placeOptions, measure: m } : { ...options.placeOptions };
}

let sharedMeasure: MeasureFn | undefined | null = null;
function defaultMeasure(): MeasureFn | undefined {
  if (sharedMeasure === null) sharedMeasure = canvasMeasure();
  return sharedMeasure;
}
