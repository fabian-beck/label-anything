/**
 * The environment of a solve: pluggable backends and host callbacks (spec §6.4); port of
 * `rust/crates/la-core/src/env.rs`.
 *
 * The core has no I/O. File access, the clock and host callbacks are injected through
 * {@link Env}. SVG backgrounds use `@label-anything/svg` by default ({@link BUILTIN_SVG};
 * a host may supply another {@link SvgBackend}); raster pixel modes come from
 * `@label-anything/raster`. {@link BasicEnv} is the environment without clock and
 * callbacks (Rust `BasicEnv`); `place` builds one from its {@link PlaceOptions}.
 *
 * Rust's `Env` trait has a default for every method, so every member of the
 * {@link Env} interface is optional; the core calls them through the helpers below.
 *
 * @module
 */

import * as svg from "@label-anything/svg";
import type { Rgba } from "@label-anything/raster";
import type { Mode } from "@label-anything/raster";
import type { FontSpec, TextMetrics } from "./api.js";
import { P, Rect } from "./geom/index.js";

export type { FontSpec, TextMetrics };

/** Geometry produced by an SVG backend, in canvas pixels (Rust `env::Geom`). */
export type Geom =
  | { kind: "polygon"; rings: P[][]; evenOdd: boolean }
  | { kind: "polyline"; points: P[]; width: number; closed: boolean }
  | { kind: "rect"; rect: Rect };

/** A class rule `(selector, class)` of SVG classification. */
export type SvgRule = readonly [selector: string, cls: string];

/** A classification failure of {@link SvgDoc.classify}: the rule index and a message. */
export class SvgRuleError extends Error {
  readonly rule: number;
  constructor(rule: number, message: string) {
    super(message);
    this.name = "SvgRuleError";
    this.rule = rule;
  }
}

/** A parsed SVG document. */
export interface SvgDoc {
  /** Viewport size in px (before mapping to the canvas). */
  size(): [number, number];
  /**
   * Classify drawn geometry by the first matching `(selector, class)` rule; class
   * `"ignore"` drops geometry. Elements whose id is in `excludeIds` are skipped.
   * Selector errors throw {@link SvgRuleError}.
   */
  classify(rules: readonly SvgRule[], defaultClass: string, excludeIds: readonly string[]): [string, Geom][];
  /** Geometry of the element with this id (and its descendants), or null. */
  geometryById(id: string): Geom[] | null;
  /** Geometry of all elements matching `selector` (throws an `Error` with a message). */
  geometryBySelector(selector: string): Geom[];
}

/** Parses SVG markup into an {@link SvgDoc} mapped onto the canvas. */
export interface SvgBackend {
  /**
   * `canvas`: target canvas size (the viewport is scaled onto it), or null to keep SVG
   * user units. `measure(text, fontSizePx, family, weight)` gives text widths; text boxes
   * extend `ascent` em above and `descent` em below the baseline (the ascender and
   * descender of the measuring font). Throws an `Error` whose message describes the
   * failure.
   */
  load(
    markup: string,
    canvas: [number, number] | null,
    tolerance: number,
    measure: (text: string, size: number, family: string, weight: number) => number,
    ascent: number,
    descent: number,
  ): SvgDoc;
}

/** Raster processing mode with its parameters (spec §4.6). */
export type RasterMode = Mode;
/** RGBA8 image, row-major, straight alpha. */
export type RgbaImage = Rgba;

/** Resolved options of one raster source. */
export interface RasterOpts {
  mode: RasterMode;
  class: string;
  scale: number;
  offset: P;
}

function geomOf(g: svg.Geometry): Geom {
  switch (g.type) {
    case "polygon":
      return { kind: "polygon", rings: g.rings.map((r) => r.map((p) => new P(p[0], p[1]))), evenOdd: g.even_odd };
    case "polyline":
      return { kind: "polyline", points: g.points.map((p) => new P(p[0], p[1])), width: g.width, closed: g.closed };
    case "rect":
      return { kind: "rect", rect: new Rect(g.x, g.y, g.x + g.w, g.y + g.h) };
  }
}

class BuiltinDoc implements SvgDoc {
  constructor(private readonly scene: svg.Scene) {}

  size(): [number, number] {
    return [this.scene.canvas_width, this.scene.canvas_height];
  }

  classify(rules: readonly SvgRule[], defaultClass: string, excludeIds: readonly string[]): [string, Geom][] {
    // report the first rule whose selector does not parse
    for (let i = 0; i < rules.length; i++) {
      const r = svg.parseSelector(rules[i]![0]);
      if (!r.ok) throw new SvgRuleError(i, r.error.message);
    }
    const classRules: svg.ClassRule[] = rules.map(([selector, cls]) => ({ selector, class: cls }));
    // excluded elements and their descendants (instance geometry belongs to the
    // outermost <use>)
    const excluded: [number, number][] = [];
    for (const id of excludeIds) {
      const e = svg.elementById(this.scene, id);
      if (e !== undefined) excluded.push([e, this.scene.elements[e]!.subtree_end]);
    }
    const out = svg.classify(this.scene, classRules, defaultClass);
    if (!out.ok) throw new SvgRuleError(0, out.error.message);
    const res: [string, Geom][] = [];
    for (const c of out.value) {
      const el = c.primitive.element;
      if (excluded.some(([a, b]) => el >= a && el < b)) continue;
      res.push([c.class, geomOf(c.primitive)]);
    }
    return res;
  }

  geometryById(id: string): Geom[] | null {
    const ps = svg.elementGeometry(this.scene, id);
    return ps === undefined ? null : ps.map(geomOf);
  }

  geometryBySelector(selector: string): Geom[] {
    const r = svg.select(this.scene, selector);
    if (!r.ok) throw new Error(r.error.message);
    return r.value.map(geomOf);
  }
}

/** The built-in SVG backend (`@label-anything/svg`, identical to `label-anything-svg`). */
export const BUILTIN_SVG: SvgBackend = {
  load(markup, canvas, tolerance, measure, ascent, descent) {
    const r = svg.parseSvg(markup, {
      canvas: canvas === null ? null : { width: canvas[0], height: canvas[1] },
      tolerance,
      measure,
      ascent,
      descent,
    });
    if (!r.ok) throw new Error(`${r.error.message} (${r.error.code})`);
    return new BuiltinDoc(r.value);
  },
};

/**
 * Everything the core needs from its host. Every member is optional; a missing member
 * behaves like Rust's default trait method.
 */
export interface Env {
  /** The SVG backend ({@link BUILTIN_SVG} when absent; `null`: no SVG support). */
  svg?(): SvgBackend | null;
  /**
   * A raster background supplied directly by the host: replaces the image of the first
   * `obstacles.raster` source (or adds one with default options).
   */
  rasterOverride?(): RgbaImage | null;
  /** Read a file; throws an `Error` whose message is reported. Unavailable by default. */
  readFile?(path: string): Uint8Array;
  /** Monotonic time in milliseconds (only used for the wall-clock guards and stats). */
  nowMs?(): number;
  /** Host text measurement (overrides the built-in shaper when it returns metrics). */
  measure?(text: string, font: FontSpec): TextMetrics | null;
  /**
   * Whether {@link Env.measure} may return metrics. Return `false` when it never does: text
   * is then measured with the fonts alone, so wrapping can measure the candidate lines in
   * constant time (`FontMeasure`, ADR 0018). The default, `true`, is correct for every
   * environment.
   */
  hasMeasureCallback?(): boolean;
  /** Host priority callback: `[tier, score]` per item, evaluated once per item. */
  priority?(item: unknown, index: number): [tier: number | null, score: number] | null;
  /** Whether a host priority callback is installed. */
  hasPriorityCallback?(): boolean;
  /** Extra user cost of a candidate (item id, box, has leader). */
  extraCost?(itemId: string, bbox: Rect, leader: boolean): number;
  /** Whether a host cost callback is installed. */
  hasCostCallback?(): boolean;
  /** Progress notification. */
  progress?(phase: string, fraction: number): void;
  /** Cancellation request. */
  cancelled?(): boolean;
}

/** An environment without clock, files and callbacks (vector, SVG and inline rasters). */
export class BasicEnv implements Env {
  hasMeasureCallback(): boolean {
    return false;
  }
}

// --- calls with Rust's defaults ------------------------------------------------------

/** `env.svg()` (default: the built-in backend). */
export function envSvg(env: Env): SvgBackend | null {
  return env.svg ? env.svg() : BUILTIN_SVG;
}

/** `env.raster_override()` (default none). */
export function envRasterOverride(env: Env): RgbaImage | null {
  return env.rasterOverride ? env.rasterOverride() : null;
}

/** `env.read_file(path)`: throws an `Error` with the message of Rust's `Err`. */
export function envReadFile(env: Env, path: string): Uint8Array {
  if (env.readFile) return env.readFile(path);
  throw new Error(`file access is not available in this environment (${path})`);
}

/** `env.now_ms()` (default 0). */
export function envNow(env: Env): number {
  return env.nowMs ? env.nowMs() : 0;
}

/** `env.has_measure_callback()` (default true). */
export function envHasMeasureCallback(env: Env): boolean {
  return env.hasMeasureCallback ? env.hasMeasureCallback() : true;
}

/** `env.cancelled()` (default false). */
export function envCancelled(env: Env): boolean {
  return env.cancelled ? env.cancelled() : false;
}

/** `env.progress(phase, fraction)`. */
export function envProgress(env: Env, phase: string, fraction: number): void {
  if (env.progress) env.progress(phase, fraction);
}
